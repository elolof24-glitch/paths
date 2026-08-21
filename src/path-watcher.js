import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { savePath, getNewPathsSinceLastScan, updateLastScan, getBlacklist } from './database.js';
import { fetchRobotsTxt } from './discovery/robots.js';
import { fetchSitemaps } from './discovery/sitemaps.js';
import { fetchCommonCrawl } from './discovery/commoncrawl.js';
import { fetchWayback } from './discovery/wayback.js';

const MAX_PAGES = 30;
const MAX_URLS = 500;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function host(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
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
  try {
    return !/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt|json|pdf|zip)$/i.test(
      new URL(url).pathname
    );
  } catch {
    return false;
  }
}

function recentPath(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\/202[0-4]\//.test(pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// === NEW: Filter for high-value paths ===
function isHighValue(url) {
  const path = new URL(url).pathname.toLowerCase();
  
  // Skip trading pairs (noise)
  if (path.includes('/trade/')) return false;
  if (path.match(/_[a-z]{3,6}$/i)) return false; // Ends with _USDT, _BTC, etc.
  
  // Skip generic paths
  if (path.includes('/captcha/')) return false;
  if (path.includes('/login/')) return false;
  if (path.includes('/register/')) return false;
  if (path.includes('/api/')) return false;
  
  // Keep high-value paths
  if (path.includes('/en/') || path.includes('/zh-CN/') || path.includes('/ja/')) return true;
  if (path.includes('/product/') || path.includes('/products/')) return true;
  if (path.includes('/announcement/') || path.includes('/announcements/')) return true;
  if (path.includes('/blog/') || path.includes('/news/')) return true;
  if (path.includes('/new/') || path.includes('/latest/')) return true;
  if (path.includes('/feature/') || path.includes('/features/')) return true;
  if (path.includes('/agent-') || path.includes('/os/') || path.includes('/ai/')) return true;
  
  // Keep short, clean paths (likely important pages)
  const segments = path.split('/').filter(s => s.length > 0);
  if (segments.length <= 3 && segments.every(s => s.length > 2)) return true;
  
  return false; // Skip everything else
}
// ==========================================

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
    
    // Get blacklist for this target
    const blacklist = getBlacklist(target.id);
    
    function isBlacklisted(url) {
      return blacklist.some(pattern => url.includes(pattern));
    }

    // === V2: Multi-source discovery ===
    
    // 1. robots.txt
    const robotsUrls = await fetchRobotsTxt(baseUrl);
    for (const url of robotsUrls) {
      if (recentPath(url) && !isBlacklisted(url) && isHighValue(url)) add(discovered, url, baseUrl);
    }

    // 2. sitemaps
    const sitemapUrls = await fetchSitemaps(baseUrl);
    for (const url of sitemapUrls) {
      if (recentPath(url) && !isBlacklisted(url) && isHighValue(url)) add(discovered, url, baseUrl);
    }

    // 3. Common Crawl
    const ccUrls = await fetchCommonCrawl(baseUrl);
    for (const url of ccUrls) {
      if (recentPath(url) && !isBlacklisted(url) && isHighValue(url)) add(discovered, url, baseUrl);
    }

    // 4. Wayback
    const wbUrls = await fetchWayback(baseUrl);
    for (const url of wbUrls) {
      if (recentPath(url) && !isBlacklisted(url) && isHighValue(url)) add(discovered, url, baseUrl);
    }

    // === Existing: seeds and crawling ===
    
    add(discovered, baseUrl, baseUrl);
    queue.push(baseUrl);

    for (const seed of seeds) {
      const url = add(discovered, seed, baseUrl);
      if (url && !isBlacklisted(url) && isHighValue(url)) queue.push(url);
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
        if (finalUrl && crawlable(finalUrl) && !visited.has(finalUrl) && !isBlacklisted(finalUrl) && isHighValue(finalUrl)) {
          queue.push(finalUrl);
        }

        const hrefs = await page.locator('a[href]').evaluateAll(
          nodes => nodes.map(node => node.href)
        ).catch(() => []);

        for (const href of hrefs) {
          const found = add(discovered, href, baseUrl);
          if (found && crawlable(found) && !visited.has(found) && !isBlacklisted(found) && isHighValue(found)) {
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

    // Save all discovered paths (excluding blacklisted)
    for (const url of discovered) {
      if (isBlacklisted(url)) {
        console.log(`[blacklist] skipping ${url}`);
        continue;
      }
      
      const request = await context.request.get(url, {
        timeout: 20_000,
        failOnStatusCode: false
      }).catch(() => null);

      const status = request?.status() ?? null;
      const body = request ? await request.text().catch(() => '') : '';

      savePath({
        targetId: target.id,
        url,
        path: new URL(url).pathname || '/',
        status,
        contentHash: hash(body)
      });
    }

    // Get ONLY new paths since last scan
    const newPaths = getNewPathsSinceLastScan(target.id);
    
    // Update last scan timestamp
    updateLastScan(target.id);

    const changes = newPaths.map(p => ({
      type: 'new',
      url: p.url,
      status: p.status,
      first_seen: p.first_seen
    }));

    console.log(
      `[paths] stored=${discovered.size} new_since_last_scan=${changes.length}`
    );

    return {
      discovered: [...discovered],
      changes
    };
  } finally {
    await browser.close();
  }
}
