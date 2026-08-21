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
    if (url.hostname !== base.hostname) return null;

    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isTrackablePath(pathname) {
  return !/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt|json)$/i.test(pathname);
}

function trackable(value, baseUrl) {
  const normalized = normalizeUrl(value, baseUrl);
  if (!normalized) return null;

  const pathname = new URL(normalized).pathname || '/';
  return isTrackablePath(pathname) ? normalized : null;
}

function addUrl(value, baseUrl, discovered) {
  const url = trackable(value, baseUrl);
  if (url) discovered.add(url);
}

function extractRoutes(text, baseUrl, discovered) {
  if (!text) return;

  for (const value of text.match(/https?:\/\/[^\s"'<>\\]+/g) || []) {
    addUrl(value.replace(/[),.;]+$/, ''), baseUrl, discovered);
  }

  for (const value of text.match(/(?:["'`])\/(?!\/)[a-zA-Z0-9][a-zA-Z0-9_./-]{1,160}/g) || []) {
    addUrl(value.slice(1), baseUrl, discovered);
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'paths-v2/1.0' },
    signal: AbortSignal.timeout(30_000)
  }).catch(() => null);

  if (!response || !response.ok) return '';
  return response.text().catch(() => '');
}

async function getCommonCrawlUrls(baseUrl) {
  const host = new URL(baseUrl).hostname;
  const indexList = JSON.parse(await fetchText('https://index.commoncrawl.org/collinfo.json') || '[]');
  const urls = new Set();

  for (const collection of indexList.slice(0, 3)) {
    const endpoint = collection?.cdx_api || collection?.['cdx-api'];
    if (!endpoint) continue;

    const query = new URL(endpoint);
    query.searchParams.set('url', `${host}/*`);
    query.searchParams.set('output', 'json');
    query.searchParams.set('fl', 'url,status');
    query.searchParams.set('filter', 'status:200');
    query.searchParams.set('collapse', 'urlkey');
    query.searchParams.set('pageSize', '5000');

    const text = await fetchText(query.toString());

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;

      try {
        const row = JSON.parse(line);
        if (row.url) {
          const url = trackable(row.url, baseUrl);
          if (url) urls.add(url);
        }
      } catch {}
    }
  }

  return [...urls];
}

async function getSitemapUrls(baseUrl) {
  const base = new URL(baseUrl);
  const queue = new Set([
    new URL('/sitemap.xml', base).toString(),
    new URL('/sitemap_index.xml', base).toString(),
    new URL('/sitemap-index.xml', base).toString()
  ]);
  const robots = await fetchText(new URL('/robots.txt', base));

  for (const line of robots.split(/\r?\n/)) {
    if (line.toLowerCase().startsWith('sitemap:')) {
      queue.add(line.slice(line.indexOf(':') + 1).trim());
    }
  }

  const visited = new Set();
  const urls = new Set();

  while (queue.size && visited.size < 100) {
    const sitemapUrl = queue.values().next().value;
    queue.delete(sitemapUrl);
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    const xml = await fetchText(sitemapUrl);
    if (!xml) continue;

    for (const match of xml.match(/<loc>[^<]+<\/loc>/g) || []) {
      const location = match.replace(/<\/?loc>/g, '').trim();

      if (/sitemap/i.test(location)) {
        queue.add(location);
      } else {
        const url = trackable(location, baseUrl);
        if (url) urls.add(url);
      }
    }
  }

  return [...urls];
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

    const resources = await page.evaluate(() =>
      performance.getEntriesByType('resource').map(entry => entry.name)
    );

    for (const resource of resources) {
      addUrl(resource, base.toString(), discovered);
    }

    for (const url of await getSitemapUrls(base.toString())) {
      discovered.add(url);
    }

    for (const url of await getCommonCrawlUrls(base.toString())) {
      discovered.add(url);
    }

    console.log(`[paths] ${target.name}: ${discovered.size} candidate(s)`);

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
