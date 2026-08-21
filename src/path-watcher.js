import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { savePath } from './database.js';
import { discoverPublicPaths } from './discovery.js';

const MAX_PAGES = 100;
const MAX_CANDIDATES = 2_000;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function sameSite(hostA, hostB) {
  return canonicalHost(hostA) === canonicalHost(hostB);
}

function normalizeUrl(value, baseUrl) {
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

function isHtmlPath(url) {
  return !/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt|json|pdf|zip)$/i.test(
    new URL(url).pathname
  );
}

function addUrl(set, value, baseUrl) {
  const normalized = normalizeUrl(value, baseUrl);
  if (!normalized || set.size >= MAX_CANDIDATES) return null;
  set.add(normalized);
  return normalized;
}

function extractTextUrls(text, baseUrl, discovered) {
  if (!text) return;

  for (const value of text.match(/https?:\/\/[^\s"'<>\\]+/g) || []) {
    addUrl(discovered, value.replace(/[),.;]+$/, ''), baseUrl);
  }

  for (const value of text.match(/(?:["'`])\/(?!\/)[a-zA-Z0-9][a-zA-Z0-9_./?=&%-]{1,200}/g) || []) {
    addUrl(discovered, value.slice(1), baseUrl);
  }
}

async function readPage(context, url, baseUrl) {
  const page = await context.newPage();
  const links = new Set();
  let response = null;
  let body = '';

  try {
    response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000
    }).catch(() => null);

    await page.waitForTimeout(1_500);
    body = await page.content().catch(() => '');

    const hrefs = await page.locator('a[href]').evaluateAll(
      nodes => nodes.map(node => node.href)
    ).catch(() => []);

    for (const href of hrefs) {
      const normalized = normalizeUrl(href, baseUrl);
      if (normalized) links.add(normalized);
    }

    const resources = await page.evaluate(() =>
      performance.getEntriesByType('resource').map(entry => entry.name)
    ).catch(() => []);

    for (const resource of resources) {
      const normalized = normalizeUrl(resource, baseUrl);
      if (normalized) links.add(normalized);
    }

    extractTextUrls(body, baseUrl, links);

    return {
      finalUrl: response?.url() || url,
      status: response?.status() ?? null,
      body,
      links: [...links]
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scanPaths(target) {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; paths-v2/1.0)'
    });
    const baseUrl = new URL(target.url).toString();
    const discovered = new Set();
    const crawled = new Set();
    const queue = [];

    addUrl(discovered, baseUrl, baseUrl);
    queue.push(baseUrl);

    while (queue.length && crawled.size < MAX_PAGES) {
      const current = queue.shift();
      if (crawled.has(current)) continue;
      crawled.add(current);

      const page = await readPage(context, current, baseUrl);
      addUrl(discovered, page.finalUrl, baseUrl);

      for (const link of page.links) {
        addUrl(discovered, link, baseUrl);

        if (isHtmlPath(link) && !crawled.has(link) && queue.length < MAX_PAGES) {
          queue.push(link);
        }
      }

      console.log(
        `[crawl] ${crawled.size}/${MAX_PAGES} pages, ${discovered.size} candidates`
      );
    }

    const external = await discoverPublicPaths(baseUrl, [...discovered]);
    for (const url of external) addUrl(discovered, url, baseUrl);

    console.log(
      `[paths] ${target.name}: discovered=${discovered.size}, crawled=${crawled.size}`
    );

    const results = [];

    for (const url of discovered) {
      const request = await context.request.get(url, {
        timeout: 20_000,
        failOnStatusCode: false
      }).catch(() => null);

      const status = request?.status() ?? null;
      const body = request
        ? await request.text().catch(() => '')
        : '';

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

    console.log(
      `[paths] ${target.name}: stored candidates=${discovered.size}, changes=${results.length}`
    );

    return results;
  } finally {
    await browser.close();
  }
}
