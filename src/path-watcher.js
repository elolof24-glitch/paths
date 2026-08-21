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

function isTrackablePath(pathname) {
  return !/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt)$/i.test(pathname);
}

function addUrl(value, baseUrl, discovered) {
  const url = normalizeUrl(value, baseUrl);
  if (!url) return;

  const pathname = new URL(url).pathname || '/';
  if (isTrackablePath(pathname)) discovered.add(url);
}

function extractRoutes(text, baseUrl, discovered) {
  if (!text) return;

  for (const value of text.match(/https?:\/\/[^\s"'<>\\]+/g) || []) {
    addUrl(value, baseUrl, discovered);
  }

  for (const value of text.match(/(?:["'`])\/(?!\/)[a-zA-Z0-9][a-zA-Z0-9_./-]{1,160}/g) || []) {
    addUrl(value.slice(1), baseUrl, discovered);
  }
}

async function getSitemapUrls(baseUrl) {
  const sitemapUrls = new Set([
    new URL('/sitemap.xml', baseUrl).toString(),
    new URL('/sitemap_index.xml', baseUrl).toString(),
    new URL('/sitemap-index.xml', baseUrl).toString()
  ]);

  const robots = await fetch(new URL('/robots.txt', baseUrl)).then(response => response.text()).catch(() => '');

  for (const line of robots.split(/\r?\n/)) {
    if (line.toLowerCase().startsWith('sitemap:')) {
      sitemapUrls.add(line.slice(line.indexOf(':') + 1).trim());
    }
  }

  const found = new Set();

  async function readSitemap(sitemapUrl, depth = 0) {
    if (depth > 2 || found.has(sitemapUrl)) return;
    found.add(sitemapUrl);

    const xml = await fetch(sitemapUrl).then(response => response.text()).catch(() => '');
    if (!xml) return;

    for (const value of xml.match(/<loc>[^<]+<\/loc>/g) || []) {
      const location = value.replace(/<\/?loc>/g, '').trim();

      if (/sitemap/i.test(location) || /<sitemap/i.test(xml)) {
        await readSitemap(location, depth + 1);
      } else {
        found.add(location);
      }
    }
  }

  for (const sitemapUrl of sitemapUrls) {
    await readSitemap(sitemapUrl);
  }

  return [...found];
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

    const links = await page.locator('a[href]').evaluateAll(
      nodes => nodes.map(node => node.href)
    );

    for (const link of links) addUrl(link, base.toString(), discovered);

    extractRoutes(await page.content(), base.toString(), discovered);

    const resourceEntries = await page.evaluate(() =>
      performance.getEntriesByType('resource').map(entry => entry.name)
    );

    for (const resource of resourceEntries) {
      addUrl(resource, base.toString(), discovered);
    }

    for (const sitemapUrl of await getSitemapUrls(base.toString())) {
      addUrl(sitemapUrl, base.toString(), discovered);
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
