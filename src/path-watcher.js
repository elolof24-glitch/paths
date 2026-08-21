import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { savePath } from './database.js';
import { fetchRobotsTxt } from './discovery/robots.js';
import { fetchSitemaps } from './discovery/sitemaps.js';
import { fetchCommonCrawl } from './discovery/commoncrawl.js';
import { fetchWayback } from './discovery/wayback.js';

const MAX_PAGES = 50;
const MAX_URLS = 1000;
const MAX_AGE_DAYS = 30; // Only URLs from last 30 days

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function host(value) {
  return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
}

function normalize(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (host(url.toString()) !== host(baseUrl)) return null;

    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function add(set, value, baseUrl) {
  const url = normalize(value, baseUrl);
  if (url && set.size < MAX_URLS) set.add(url);
  return url;
}

function crawlable(url) {
  return !/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt|json|pdf|zip)$/i.test(
    new URL(url).pathname
  );
}

function recentPath(url) {
  // Skip paths that look old/archived
  // This is a simple heuristic - skip if path contains old date patterns
  const pathname = new URL(url).pathname.toLowerCase();
  
  // Skip paths with old year patterns like /2020/, /2021/, /2022/, /2023/, /2024/
  if (/\/202[0-4]\//.test(pathname)) {
    return false;
  }
  
  return true;
}

export async function scanPaths(target) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; paths-v2/1.0)'
  });
  const discovered = new Set();
  const queue = [];
  const visited = new Set();

  try {
    const baseUrl = target.url;
    const seeds = Array.isArray(target.seeds) ? target.seeds : [];

    // === V2: Multi-source discovery ===
    
    // 1. robots.txt
    const robotsUrls = await fetchRobotsTxt(baseUrl);
    for (const url of robotsUrls) {
      if (recentPath(url)) add(discovered, url, baseUrl);
    }

    // 2. sitemaps
    const sitemapUrls = await fetchSitemaps(baseUrl);
    for (const url of sitemapUrls) {
      if (recentPath(url)) add(discovered, url, baseUrl);
    }

    // 3. Common Crawl
    const ccUrls = await fetchCommonCrawl(baseUrl);
    for (const url of ccUrls) {
      if (recentPath(url)) add(discovered, url, baseUrl);
    }

    // 4. Wayback
    const wbUrls = await fetchWayback(baseUrl);
    for (const url of wbUrls) {
      if (recentPath(url)) add(discovered, url, baseUrl);
    }

    // === Existing: seeds and crawling ===
    
    add(discovered, baseUrl, baseUrl);
    queue.push(baseUrl);

    for (const seed of seeds) {
      const url = add(discovered, seed, baseUrl);
      if (url) queue.push(url);
    }

    while (queue.length && visited.size < MAX_PAGES) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      const page = await context.newPage();
      let response = null;

      try {
        response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000
        }).catch(() => null);

        await page.waitForTimeout(2_000);

        const finalUrl = add(discovered, page.url(), baseUrl);
        if (finalUrl && crawlable(finalUrl) && !visited.has(finalUrl)) {
          queue.push(finalUrl);
        }

        const hrefs = await page.locator('a[href]').evaluateAll(
          nodes => nodes.map(node => node.href)
        ).catch(() => []);

        for (const href of hrefs) {
          const found = add(discovered, href, baseUrl);
          if (found && crawlable(found) && !visited.has(found)) {
            queue.push(found);
          }
        }

        console.log(
          `[crawl] visited=${visited.size} discovered=${discovered.size} queue=${queue.length}`
        );
      } finally {
        await page.close().catch(() => {});
      }
    }

    console.log(`[paths] discovered=${discovered.size}`);

    const changes = [];

    for (const url of discovered) {
      const request = await context.request.get(url, {
        timeout: 20_000,
        failOnStatusCode: false
      }).catch(() => null);

      const status = request?.status() ?? null;
      const body = request ? await request.text().catch(() => '') : '';

      const result = savePath({
        targetId: target.id,
        url,
        path: new URL(url).pathname || '/',
        status,
        contentHash: hash(body)
      });

      if (result.type !== 'unchanged') {
        changes.push({ type: result.type, url, status });
      }
    }

    console.log(
      `[paths] stored=${discovered.size} new_or_changed=${changes.length}`
    );

    return {
      discovered: [...discovered],
      changes
    };
  } finally {
    await browser.close();
  }
}
