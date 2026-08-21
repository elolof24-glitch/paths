export async function fetchWayback(baseUrl) {
  const urls = [];
  const domain = new URL(baseUrl).hostname.replace(/^www\./, '');
  
  try {
    const cdxUrl = `http://web.archive.org/cdx/search/cdx?url=*.${domain}/*&output=json&limit=300`;
    const response = await fetch(cdxUrl);
    
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 1) {
        const originalIndex = data[0].indexOf('original');
        for (let i = 1; i < data.length; i++) {
          if (data[i][originalIndex]) {
            urls.push(data[i][originalIndex]);
          }
        }
      }
    }
  } catch (error) {
    console.error(`[wayback] failed:`, error.message);
  }
  
  return urls;
}
