import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { savePath } from './database.js';
import { discoverPublicPaths } from './discovery.js';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const base = new URL(baseUrl);

    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname !== base.hostname) return null;

    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function trackable(url, baseUrl) {
  const normalized = normalizeUrl(url, baseUrl);
  if (!normalized) return null;

  const pathname = new URL(normalized).pathname;
  if (/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt|json)$/i.test(pathname)) {
    return null;
  }

  return normalized;
}

export async function scanPaths(target) {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; paths-v2/1.0)'
    });
    const page = await context.newPage();
    const base = new URL(target.url);
    const discovered = new Set([base.toString()]);

    const response = await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000
    });

    await page.waitForTimeout(5000);

    const links = await page.locator('a[href]').evaluateAll(
      nodes => nodes.map(node => node.href)
    );

    const browserUrls = links
      .map(link => trackable(link, base.toString()))
      .filter(Boolean);

    for (const url of browserUrls) {
      discovered.add(url);
    }

    const publicUrls = await discoverPublicPaths(
      base.toString(),
      browserUrls
    );

    for (const url of publicUrls) {
      const trackableUrl = trackable(url, base.toString());
      if (trackableUrl) discovered.add(trackableUrl);
    }

    console.log(
      `[paths] ${target.name}: ${discovered.size} public path candidate(s)`
    );

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
