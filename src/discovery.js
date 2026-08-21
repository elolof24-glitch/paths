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
    headers: {
      'user-agent': 'paths-v2/1.0'
    },
    signal: AbortSignal.timeout(30_000)
  }).catch(() => null);

  if (!response || !response.ok) return '';
  return response.text().catch(() => '');
}

async function sitemapDiscovery(baseUrl) {
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

  while (queue.size && visited.size < 100) {
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
        if (normalized) urls.add(normalized);
      }
    }
  }

  return urls;
}

async function commonCrawlDiscovery(baseUrl) {
  const base = new URL(baseUrl);
  const indexes = await fetchText('https://index.commoncrawl.org/collinfo.json');
  let latest;

  try {
    latest = JSON.parse(indexes)[0]?.cdx-api;
  } catch {
    return new Set();
  }

  if (!latest) return new Set();

  const query = new URL(latest);
  query.searchParams.set('url', `${base.hostname}/*`);
  query.searchParams.set('output', 'json');
  query.searchParams.set('fl', 'url,status');
  query.searchParams.set('filter', 'status:200');
  query.searchParams.set('collapse', 'urlkey');
  query.searchParams.set('pageSize', '5000');

  const body = await fetchText(query.toString());
  const urls = new Set();

  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const row = JSON.parse(line);
      const normalized = normalize(row.url, baseUrl);
      if (normalized) urls.add(normalized);
    } catch {}
  }

  return urls;
}

async function waybackDiscovery(baseUrl) {
  const base = new URL(baseUrl);
  const query = new URL('https://web.archive.org/cdx/search/cdx');
  query.searchParams.set('url', `${base.hostname}/*`);
  query.searchParams.set('matchType', 'prefix');
  query.searchParams.set('output', 'json');
  query.searchParams.set('fl', 'original,statuscode');
  query.searchParams.set('filter', 'statuscode:200');
  query.searchParams.set('collapse', 'urlkey');
  query.searchParams.set('limit', '5000');

  const body = await fetchText(query.toString());
  const urls = new Set();

  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const row = JSON.parse(line);
      const original = Array.isArray(row) ? row[0] : row.original;
      const normalized = normalize(original, baseUrl);
      if (normalized) urls.add(normalized);
    } catch {}
  }

  return urls;
}

export async function discoverPublicPaths(baseUrl, browserUrls = []) {
  const paths = new Set();

  for (const url of browserUrls) {
    const normalized = normalize(url, baseUrl);
    if (normalized) paths.add(normalized);
  }

  const [sitemaps, commonCrawl, wayback] = await Promise.all([
    sitemapDiscovery(baseUrl),
    commonCrawlDiscovery(baseUrl),
    waybackDiscovery(baseUrl)
  ]);

  for (const collection of [sitemaps, commonCrawl, wayback]) {
    for (const url of collection) paths.add(url);
  }

  return [...paths];
}
