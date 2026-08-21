export async function fetchCommonCrawl(baseUrl) {
  const urls = [];
  const domain = new URL(baseUrl).hostname.replace(/^www\./, '');
  
  try {
    const cdxUrl = `http://index.commoncrawl.org/CC-MAIN-2026-10-index?url=*.${domain}/*&output=json&limit=300`;
    const response = await fetch(cdxUrl);
    
    if (response.ok) {
      const text = await response.text();
      const lines = text.trim().split('\n');
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.url) urls.push(entry.url);
        } catch {}
      }
    }
  } catch (error) {
    console.error(`[commoncrawl] failed:`, error.message);
  }
  
  return urls;
}
