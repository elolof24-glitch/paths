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

function addRouteCandidate(value, baseUrl, discovered) {
  const url = normalizeUrl(value, baseUrl);
  if (!url) return;

  const pathname = new URL(url).pathname;
  if (pathname === '/' || pathname.length > 1) {
    discovered.add(url);
  }
}

function extractStringRoutes(value, baseUrl, discovered) {
  if (typeof value !== 'string') return;

  const absoluteMatches = value.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  for (const match of absoluteMatches) {
    addRouteCandidate(match, baseUrl, discovered);
  }

  const pathMatches = value.match(/(?:^|["'`])\/(?!\/)[a-zA-Z0-9][a-zA-Z0-9_./-]{1,120}/g) || [];
  for (const match of pathMatches) {
    addRouteCandidate(match.replace(/^["'`]/, ''), baseUrl, discovered);
  }
}

function collectRoutes(value, baseUrl, discovered, depth = 0) {
  if (depth > 5 || value == null) return;

  if (typeof value === 'string') {
    extractStringRoutes(value, baseUrl, discovered);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectRoutes(item, baseUrl, discovered, depth + 1);
    return;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectRoutes(item, baseUrl, discovered, depth + 1);
    }
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
    const discovered = new Set([base.toString()]);

    const response = await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000
    });

    await page.waitForTimeout(5_000);

    const sameHostResponses = [];

    page.on('response', networkResponse => {
      try {
        const url = new URL(networkResponse.url());
        if (url.origin === base.origin) sameHostResponses.push(url.toString());
      } catch {}
    });

    const links = await page.locator('a[href]').evaluateAll(
      nodes => nodes.map(node => node.href)
    );

    for (const link of links) addRouteCandidate(link, base.toString(), discovered);

    const html = await page.content();
    extractStringRoutes(html, base.toString(), discovered);

    for (const script of await page.locator('script').allTextContents()) {
      extractStringRoutes(script, base.toString(), discovered);
    }

    const resourceEntries = await page.evaluate(() => {
      const entries = performance.getEntriesByType('resource');
      return entries.map(entry => entry.name);
    });

    for (const resource of resourceEntries) {
      addRouteCandidate(resource, base.toString(), discovered);
    }

    for (const networkUrl of sameHostResponses) {
      addRouteCandidate(networkUrl, base.toString(), discovered);
    }

    const routeManifest = await page.evaluate(() => ({
      nextData: globalThis.__NEXT_DATA__ || null,
      router: globalThis.__NUXT__ || null
    })).catch(() => ({}));

    collectRoutes(routeManifest, base.toString(), discovered);

    const filtered = [...discovered].filter(url => {
      const pathname = new URL(url).pathname;
      return !ignoredPath(pathname);
    });

    const results = [];

    for (const url of filtered) {
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
