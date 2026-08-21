import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { savePath } from './database.js';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const base = new URL(baseUrl);

    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.origin !== base.origin) return null;

    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function ignoredPath(pathname) {
  return /\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map)$/i.test(pathname);
}

export async function scanPaths(target) {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; paths-v2/1.0)'
    });
    const page = await context.newPage();
    const base = new URL(target.url);
    const discovered = new Set();

    const response = await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000
    });

    await page.waitForTimeout(3000);
    discovered.add(base.toString());

    const links = await page.locator('a[href]').evaluateAll(
      nodes => nodes.map(node => node.href)
    );

    for (const link of links) {
      const url = normalizeUrl(link, base.toString());
      if (!url) continue;
      if (!ignoredPath(new URL(url).pathname)) discovered.add(url);
    }

    const results = [];

    for (const url of discovered) {
      let status = null;
      let body = '';

      if (url === base.toString() && response) {
        status = response.status();
        body = await response.text().catch(() => '');
      } else {
        const request = await context.request.get(url, {
          timeout: 20_000,
          failOnStatusCode: false
        }).catch(() => null);

        status = request?.status() ?? null;
        body = request ? await request.text().catch(() => '') : '';
      }

      const result = savePath({
        targetId: target.id,
        url,
        path: new URL(url).pathname || '/',
        status,
        contentHash: digest(body)
      });

      if (result.type !== 'unchanged') {
        results.push({ type: result.type, url, status });
      }
    }

    return results;
  } finally {
    await browser.close();
  }
}
