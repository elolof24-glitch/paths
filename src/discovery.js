function canonicalHostname(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function allowedHost(hostname, baseHostname) {
  return canonicalHostname(hostname) === canonicalHostname(baseHostname);
}

function normalize(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const base = new URL(baseUrl);

    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!allowedHost(url.hostname, base.hostname)) return null;

    url.hash = '';
    url.search = '';

    if (/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt|json)$/i.test(url.pathname)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
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

function addUrl(set, value, baseUrl) {
  const normalized = normalize(value, baseUrl);
  if (normalized) set.add(normalized);
}

async function getSitemapUrls(baseUrl) {
  const base = new URL(baseUrl);
  const queue = new Set([
    new URL('/sitemap.xml', base).toString(),
    new URL('/sitemap_index.xml', base).toString(),
    new URL('/sitemap-index.xml', base).toString()
  ]);
  const visited = new Set();
  const urls = new Set();
  const robots = await fetchText(new URL('/robots.txt', base));

  for (const line of robots.split(/\r?\n/)) {
    if (line.toLowerCase().startsWith('sitemap:')) {
      queue.add(line.slice(line.indexOf(':') + 1).trim());
    }
  }

  while (queue.size && visited.size < 200) {
    const sitemapUrl = queue.values().next().value;
    queue.delete(sitemapUrl);
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    const xml = await fetchText(sitemapUrl);
    if (!xml) continue;

    const isIndex = /<sitemapindex[\s>]/i.test(xml);

    for (const match of xml.match(/<loc>[^<]+<\/loc>/gi) || []) {
      const location = match.replace(/<\/?loc>/gi, '').trim();

      if (isIndex || /sitemap/i.test(location)) {
        queue.add(location);
      } else {
        addUrl(urls, location, baseUrl);
      }
    }
  }

  return urls;
}

async function getCommonCrawlUrls(baseUrl) {
  const host = new URL(baseUrl).hostname;
  const collections = JSON.parse(
    await fetchText('https://index.commoncrawl.org/collinfo.json') || '[]'
  );
  const urls = new Set();

  for (const collection of collections.slice(0, 5)) {
    const endpoint = collection?.['cdx-api'] || collection?.cdx_api;
    if (!endpoint) continue;

    const query = new URL(endpoint);
    query.searchParams.set('url', `${host}/*`);
    query.searchParams.set('output', 'json');
    query.searchParams.set('fl', 'url,status');
    query.searchParams.set('filter', 'status:200');
    query.searchParams.set('collapse', 'urlkey');
    query.searchParams.set('limit', '5000');

    const text = await fetchText(query.toString());

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;

      try {
        const row = JSON.parse(line);
        addUrl(urls, row.url, baseUrl);
      } catch {}
    }
  }

  return urls;
}

async function getWaybackUrls(baseUrl) {
  const base = new URL(baseUrl);
  const query = new URL('https://web.archive.org/cdx/search/cdx');
  const urls = new Set();

  query.searchParams.set('url', `${base.hostname}/*`);
  query.searchParams.set('matchType', 'prefix');
  query.searchParams.set('output', 'json');
  query.searchParams.set('fl', 'original,statuscode');
  query.searchParams.set('filter', 'statuscode:200');
  query.searchParams.set('collapse', 'urlkey');
  query.searchParams.set('limit', '5000');

  const text = await fetchText(query.toString());
  let rows;

  try {
    rows = JSON.parse(text);
  } catch {
    return urls;
  }

  if (!Array.isArray(rows) || rows.length < 2) return urls;

  const header = rows[0];
  const originalIndex = Array.isArray(header)
    ? header.indexOf('original')
    : -1;

  for (const row of rows.slice(1)) {
    const value = originalIndex >= 0 ? row[originalIndex] : row[0];
    addUrl(urls, value, baseUrl);
  }

  return urls;
}

export async function discoverPublicPaths(baseUrl, browserUrls = []) {
  const discovered = new Set();

  for (const url of browserUrls) {
    addUrl(discovered, url, baseUrl);
  }

  const sources = [
    ['sitemap', getSitemapUrls(baseUrl)],
    ['commoncrawl', getCommonCrawlUrls(baseUrl)],
    ['wayback', getWaybackUrls(baseUrl)]
  ];
  const results = await Promise.allSettled(sources.map(([, promise]) => promise));

  for (let index = 0; index < results.length; index++) {
    const [name] = sources[index];
    const result = results[index];

    if (result.status === 'fulfilled') {
      console.log(`[discovery] ${name}: ${result.value.size} URL(s)`);
      for (const url of result.value) discovered.add(url);
    } else {
      console.error(`[discovery] ${name} failed:`, result.reason);
    }
  }

  console.log(`[discovery] total: ${discovered.size} candidate(s)`);
  return [...discovered];
}
