function normalize(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const base = new URL(baseUrl);

    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname !== base.hostname) return null;

    url.hash = '';
    url.search = '';

    const pathname = url.pathname || '/';
    if (/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt|json)$/i.test(pathname)) {
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

function parseJsonLines(text) {
  const rows = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      rows.push(JSON.parse(line));
    } catch {}
  }

  return rows;
}

async function commonCrawlDiscovery(baseUrl) {
  const base = new URL(baseUrl);
  const collections = JSON.parse(
    await fetchText('https://index.commoncrawl.org/collinfo.json') || '[]'
  );

  const results = new Set();

  for (const collection of collections.slice(0, 3)) {
    if (!collection?.cdx_api) continue;

    const query = new URL(collection.cdx_api);
    query.searchParams.set('url', `${base.hostname}/*`);
    query.searchParams.set('output', 'json');
    query.searchParams.set('fl', 'url,status');
    query.searchParams.set('filter', 'status:200');
    query.searchParams.set('collapse', 'urlkey');
    query.searchParams.set('pageSize', '5000');

    const text = await fetchText(query.toString());

    for (const row of parseJsonLines(text)) {
      const normalized = normalize(row.url, baseUrl);
      if (normalized) results.add(normalized);
    }
  }

  return results;
}

async function waybackDiscovery(baseUrl) {
  const base = new URL(baseUrl);
  const results = new Set();
  const query = new URL('https://web.archive.org/cdx/search/cdx');

  query.searchParams.set('url', `${base.hostname}/*`);
  query.searchParams.set('matchType', 'prefix');
  query.searchParams.set('output', 'json');
  query.searchParams.set('fl', 'original,statuscode');
  query.searchParams.set('filter', 'statuscode:200');
  query.searchParams.set('collapse', 'urlkey');
  query.searchParams.set('limit', '5000');

  const text = await fetchText(query.toString());
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (Array.isArray(parsed)) {
    const header = parsed[0];
    const originalIndex = header?.indexOf('original');

    for (const row of parsed.slice(1)) {
      const original = originalIndex >= 0 ? row[originalIndex] : row[0];
      const normalized = normalize(original, baseUrl);
      if (normalized) results.add(normalized);
    }
  }

  return results;
}

async function sitemapDiscovery(baseUrl) {
  const base = new URL(baseUrl);
  const queue = new Set([
    new URL('/sitemap.xml', base).toString(),
    new URL('/sitemap_index.xml', base).toString(),
    new URL('/sitemap-index.xml', base).toString()
  ]);
  const visited = new Set();
  const results = new Set();

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

    for (const match of xml.match(/<loc>[^<]+<\/loc>/g) || []) {
      const value = match.replace(/<\/?loc>/g, '').trim();

      if (/sitemap/i.test(value)) {
        queue.add(value);
      } else {
        const normalized = normalize(value, baseUrl);
        if (normalized) results.add(normalized);
      }
    }
  }

  return results;
}

export async function discoverPublicPaths(baseUrl, browserUrls = []) {
  const sources = await Promise.allSettled([
    sitemapDiscovery(baseUrl),
    commonCrawlDiscovery(baseUrl),
    waybackDiscovery(baseUrl)
  ]);

  const results = new Set();

  for (const value of browserUrls) {
    const normalized = normalize(value, baseUrl);
    if (normalized) results.add(normalized);
  }

  for (const source of sources) {
    if (source.status !== 'fulfilled') continue;
    for (const url of source.value) results.add(url);
  }

  console.log(
    `[discovery] ${baseUrl}: ${results.size} public path candidate(s)`
  );

  return [...results];
}
