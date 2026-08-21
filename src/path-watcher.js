import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { savePath } from './database.js';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeUrl(value, origin) {
  try {
    const url = new URL(value, origin);
    const base = new URL(origin);

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
    const page = await browser.newPage();
    const base = new URL(target.url);
    const discovered = new Set([base.toString()]);

    await page.goto(target.url, {
      waitUntil: 'networkidle',
      timeout: 45_000
    });

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
      const response = await page.request.get(url, {
        timeout: 20_000,
        failOnStatusCode: false
      }).catch(() => null);

      const body = response
        ? await response.text().catch(() => '')
        : '';

      const result = savePath({
        targetId: target.id,
        url,
        path: new URL(url).pathname || '/',
        status: response?.status() || null,
        contentHash: digest(body)
      });

      if (result.type !== 'unchanged') {
        results.push({
          type: result.type,
          url,
          status: response?.status() || null
        });
      }
    }

    return results;
  } finally {
    await browser.close();
  }
}
