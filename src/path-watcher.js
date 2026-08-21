import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { savePath } from './database.js';
import { discoverPublicPaths } from './discovery.js';

const MAX_PAGES = 100;
const MAX_CANDIDATES = 2000;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function isSameSite(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const base = new URL(baseUrl);
    return canonicalHost(url.hostname) === canonicalHost(base.hostname);
  } catch {
    return false;
  }
}

function normalizeUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!isSameSite(url.toString(), baseUrl)) return null;

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

function addCandidate(candidates, value, baseUrl, source) {
  const url = normalizeUrl(value, baseUrl);
  if (!url || candidates.size >= MAX_CANDIDATES) return;

  const existing = candidates.get(url);
  if (existing) {
    existing.sources.add(source);
  } else {
    candidates.set(url, { url, sources: new Set([source]) });
  }
}

function extractRoutes(text, baseUrl, candidates, source) {
  if (!text) return;

  for (const value of text.match(/https?:\/\/[^\s"'<>\\]+/g) || []) {
    addCandidate(candidates, value.replace(/[),.;]+$/, ''), baseUrl, source);
  }

  for (const value of text.match(/(?:["'`])\/(?!\/)[^"'`\s]{2,200}/g) || []) {
    addCandidate(candidates, value.slice(1), baseUrl, source);
  }
}

async function crawlSource(baseUrl, seeds) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; paths-v2/1.0)'
  });
  const candidates = new Map();
  const queue = [];
  const visited = new Set();

  try {
    for (const seed of seeds) {
      addCandidate(candidates, seed, baseUrl, 'seed');
      queue.push(seed);
    }

    addCandidate(candidates, baseUrl, baseUrl, 'target');
    queue.push(baseUrl);

    while (queue.length && visited.size < MAX_PAGES) {
      const requested = queue.shift();
      const url = normalizeUrl(requested, baseUrl);
      if (!url || visited.has(url)) continue;
      visited.add(url);

      const page = await context.newPage();
      const network = new Set();

      page.on('response', response => {
        const value = normalizeUrl(response.url(), baseUrl);
        if (value) network.add(value);
      });

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000
      }).catch(() => null);

      await page.waitForTimeout(1_500);

      const finalUrl = normalizeUrl(page.url(), baseUrl);
      if (finalUrl) addCandidate(candidates, finalUrl, baseUrl, 'redirect');

      const hrefs = await page.locator('a[href]').evaluateAll(
        nodes => nodes.map(node => node.href)
      ).catch(() => []);
      const html = await page.content().catch(() => '');

      for (const href of hrefs) {
        const value = normalizeUrl(href, baseUrl);
        if (!value) continue;
        addCandidate(candidates, value, baseUrl, 'link');
        if (isPage(value) && !visited.has(value)) queue.push(value);
      }

      for (const value of network) {
        addCandidate(candidates, value, baseUrl, 'network');
      }

      extractRoutes(html, baseUrl, candidates, 'html');

      await page.close().catch(() => {});

      console.log(
        `[crawl] visited=${visited.size} candidates=${candidates.size} queue=${queue.length}`
      );
    }
  } finally {
    await browser.close();
  }

  return candidates;
}

export async function scanPaths(target) {
  const seeds = Array.isArray(target.seeds) ? target.seeds : [];
  const candidates = await crawlSource(target.url, seeds);

  let external = [];
  try {
    external = await discoverPublicPaths(
      target.url,
      [...candidates.keys()]
    );
  } catch (error) {
    console.error(`[discovery] external sources failed: ${error.message}`);
  }

  for (const url of external) {
    addCandidate(candidates, url, target.url, 'external');
  }

  console.log(
    `[sentinel] target=${target.name} candidates=${candidates.size} sources=seed,link,network,html,redirect,external`
  );

  const changes = [];
  const current = new Set(candidates.keys());

  for (const entry of candidates.values()) {
    const request = await fetch(entry.url, {
      headers: { 'user-agent': 'paths-v2/1.0' },
      signal: AbortSignal.timeout(20_000)
    }).catch(() => null);

    const status = request?.status ?? null;
    const body = request ? await request.text().catch(() => '') : '';
    const source = [...entry.sources].join(',');

    const result = savePath({
      targetId: target.id,
      url: entry.url,
      path: new URL(entry.url).pathname || '/',
      status,
      contentHash: hash(body),
      source
    });

    if (result.type !== 'unchanged') {
      changes.push({
        type: result.type,
        url: entry.url,
        status,
        source
      });
    }
  }

  console.log(
    `[sentinel] discovered=${current.size} stored=${current.size} changes=${changes.length}`
  );

  return changes;
}
