import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { savePath } from './database.js';
import { discoverPublicPaths } from './discovery.js';

const MAX_PAGES = 100;
const MAX_CANDIDATES = 2000;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameSite(a, b) {
  const clean = host => host.toLowerCase().replace(/^www\./, '');
  return clean(a) === clean(b);
}

function normalize(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const base = new URL(baseUrl);

    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!sameSite(url.hostname, base.hostname)) return null;

    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isPage(url) {
  return !/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt|json|pdf|zip)$/i.test(
    new URL(url).pathname
  );
}

function add(set, value, baseUrl) {
  const url = normalize(value, baseUrl);
  if (url && set.size < MAX_CANDIDATES) set.add(url);
  return url;
}

export async function scanPaths(target) {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; paths-v2/1.0)'
    });
    const page = await context.newPage();
    const baseUrl = new URL(target.url).toString();
    const discovered = new Set();
    const queue = [];
    const crawled = new Set();
    const networkUrls = new Set();

    page.on('request', request => {
      add(networkUrls, request.url(), baseUrl);
    });

    page.on('response', response => {
      add(networkUrls, response.url(), baseUrl);
    });

    console.log(`[paths] target=${target.url}`);

    const response = await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000
    }).catch(error => {
      console.error(`[paths] homepage navigation failed: ${error.message}`);
      return null;
    });

    console.log(`[paths] homepage status=${response?.status() ?? 'none'}`);
    console.log(`[paths] final URL=${page.url()}`);

    await page.waitForTimeout(5000);

    const hrefs = await page.locator('a[href]').evaluateAll(
      nodes => nodes.map(node => node.href)
    ).catch(() => []);

    console.log(`[paths] homepage hrefs=${hrefs.length}`);

    add(discovered, page.url(), baseUrl);
    for (const href of hrefs) {
      const url = add(discovered, href, baseUrl);
      if (url && isPage(url)) queue.push(url);
    }

    for (const url of networkUrls) add(discovered, url, baseUrl);

    console.log(
      `[paths] after homepage: discovered=${discovered.size}, network=${networkUrls.size}, queue=${queue.length}`
    );

    while (queue.length && crawled.size < MAX_PAGES) {
      const url = queue.shift();
      if (crawled.has(url)) continue;
      crawled.add(url);

      const child = await context.newPage();
      const childNetwork = [];

      child.on('response', response => childNetwork.push(response.url()));

      const childResponse = await child.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000
      }).catch(() => null);

      const childHrefs = await child.locator('a[href]').evaluateAll(
        nodes => nodes.map(node => node.href)
      ).catch(() => []);

      add(discovered, child.url(), baseUrl);
      for (const href of childHrefs) {
        const normalized = add(discovered, href, baseUrl);
        if (normalized && isPage(normalized) && !crawled.has(normalized)) {
          queue.push(normalized);
        }
      }

      for (const networkUrl of childNetwork) add(discovered, networkUrl, baseUrl);
      await child.close().catch(() => {});

      console.log(
        `[crawl] pages=${crawled.size}, discovered=${discovered.size}, queue=${queue.length}, status=${childResponse?.status() ?? 'none'}`
      );
    }

    let external = [];
    try {
      external = await discoverPublicPaths(baseUrl, [...discovered]);
    } catch (error) {
      console.error(`[discovery] failed: ${error.message}`);
    }

    for (const url of external) add(discovered, url, baseUrl);

    console.log(
      `[paths] FINAL discovered=${discovered.size}, crawled=${crawled.size}, external=${external.length}`
    );
    console.log(`[paths] URLs=${JSON.stringify([...discovered].slice(0, 100))}`);

    const results = [];

    for (const url of discovered) {
      const request = await context.request.get(url, {
        timeout: 20_000,
        failOnStatusCode: false
      }).catch(() => null);

      const status = request?.status() ?? null;
      const body = request ? await request.text().catch(() => '') : '';

      const saved = savePath({
        targetId: target.id,
        url,
        path: new URL(url).pathname || '/',
        status,
        contentHash: digest(body)
      });

      console.log(`[save] ${saved.type} ${status ?? 'unknown'} ${url}`);

      if (saved.type !== 'unchanged') {
        results.push({ type: saved.type, url, status });
      }
    }

    console.log(`[paths] changes=${results.length}`);
    return results;
  } finally {
    await browser.close();
  }
}
