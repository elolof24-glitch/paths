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
  if (/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt)$/i.test(pathname)) {
    return null;
  }

  return normalized;
}

async function getCommonCrawlUrls(baseUrl) {
  const host = new URL(baseUrl).hostname;
  const indexList = await fetch('https://index.commoncrawl.org/collinfo.json')
    .then(response => response.json())
    .catch(() => []);

  const latest = indexList[0]?.cdx-api;
  if (!latest) return [];

  const query = new URL(latest);
  query.searchParams.set('url', `${host}/*`);
  query.searchParams.set('output', 'json');
  query.searchParams.set('fl', 'url,status,mime');
  query.searchParams.set('filter', 'status:200');
  query.searchParams.set('collapse', 'urlkey');
  query.searchParams.set('pageSize', '5000');

  const text = await fetch(query).then(response => response.text()).catch(() => '');
  const urls = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const row = JSON.parse(line);
      if (row.url) urls.push(row.url);
    } catch {}
  }

  return urls;
}

async function getSitemapUrls(baseUrl) {
  const base = new URL(baseUrl);
  const candidates = [
    new URL('/sitemap.xml', base).toString(),
    new URL('/sitemap_index.xml', base).toString(),
    new URL('/sitemap-index.xml', base).toString()
  ];

  const robots = await fetch(new URL('/robots.txt', base))
    .then(response => response.text())
    .catch(() => '');

  for (const line of robots.split(/\r?\n/)) {
    if (line.toLowerCase().startsWith('sitemap:')) {
      candidates.push(line.slice(line.indexOf(':') + 1).trim());
    }
  }

  const visited = new Set();
  const urls = new Set();

  async function readSitemap(url, depth = 0) {
    if (depth > 2 || visited.has(url)) return;
    visited.add(url);

    const xml = await fetch(url).then(response => response.text()).catch(() => '');
    if (!xml) return;

    for (const match of xml.match(/<loc>[^<]+<\/loc>/g) || []) {
      const location = match.replace(/<\/?loc>/g, '').trim();

      if (/sitemap/i.test(location)) {
        await readSitemap(location, depth + 1);
      } else {
        urls.add(location);
      }
    }
  }

  for (const candidate of candidates) await readSitemap(candidate);
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

    await page.waitForTimeout(5000);

    const links = await page.locator('a[href]').evaluateAll(
      nodes => nodes.map(node => node.href)
    );

    for (const link of links) {
      const url = trackable(link, base.toString());
      if (url) discovered.add(url);
    }

    for (const url of await getSitemapUrls(base.toString())) {
      const trackableUrl = trackable(url, base.toString());
      if (trackableUrl) discovered.add(trackableUrl);
    }

    for (const url of await getCommonCrawlUrls(base.toString())) {
      const trackableUrl = trackable(url, base.toString());
      if (trackableUrl) discovered.add(trackableUrl);
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
