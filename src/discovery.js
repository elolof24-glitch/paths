function exactHost(url, baseUrl) {
  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);

    if (parsed.hostname !== base.hostname) return null;
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;

    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function isPageUrl(url) {
  const pathname = new URL(url).pathname;
  return !/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|xml|txt|json)$/i.test(pathname);
}

export async function discoverExternalUrls(baseUrl) {
  const base = new URL(baseUrl);
  const urls = new Set();

  const collections = await fetch('https://index.commoncrawl.org/collinfo.json')
    .then(response => response.json())
    .catch(() => []);

  const latestIndex = collections[0]?.cdx-api;

  if (latestIndex) {
    const query = new URL(latestIndex);
    query.searchParams.set('url', `${base.hostname}/*`);
    query.searchParams.set('output', 'json');
    query.searchParams.set('filter', 'status:200');
    query.searchParams.set('collapse', 'urlkey');
    query.searchParams.set('pageSize', '5000');

    const body = await fetch(query)
      .then(response => response.text())
      .catch(() => '');

    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;

      try {
        const row = JSON.parse(line);
        const normalized = exactHost(row.url, baseUrl);
        if (normalized && isPageUrl(normalized)) urls.add(normalized);
      } catch {}
    }
  }

  const wayback = new URL('https://web.archive.org/cdx/search/cdx');
  wayback.searchParams.set('url', `${base.hostname}/*`);
  wayback.searchParams.set('matchType', 'prefix');
  wayback.searchParams.set('output', 'json');
  wayback.searchParams.set('fl', 'original,statuscode,mimetype');
  wayback.searchParams.set('filter', 'statuscode:200');
  wayback.searchParams.set('collapse', 'urlkey');
  wayback.searchParams.set('limit', '5000');

  const archiveBody = await fetch(wayback)
    .then(response => response.text())
    .catch(() => '');

  for (const line of archiveBody.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const row = JSON.parse(line);
      const original = Array.isArray(row) ? row[0] : row.original;
      const normalized = exactHost(original, baseUrl);
      if (normalized && isPageUrl(normalized)) urls.add(normalized);
    } catch {}
  }

  return [...urls];
}
