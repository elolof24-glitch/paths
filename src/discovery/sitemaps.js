import { request } from 'playwright';

export async function fetchSitemaps(baseUrl) {
  const urls = [];
  const ctx = await request.newContext();
  
  try {
    const candidates = ['/sitemap.xml', '/sitemap_index.xml'];
    
    for (const path of candidates) {
      const sitemapUrl = new URL(path, baseUrl).toString();
      console.log(`[sitemaps] fetching ${sitemapUrl}`);
      
      const response = await ctx.get(sitemapUrl, { timeout: 10_000 });
      
      if (response.ok()) {
        const xml = await response.text();
        console.log(`[sitemaps] got ${xml.length} bytes`);
        
        // Simple regex to extract URLs from <loc> tags
        const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
        
        for (const match of urlMatches) {
          const url = match.replace(/<loc>|<\/loc>/g, '');
          urls.push(url);
        }
        
        console.log(`[sitemaps] extracted ${urlMatches.length} URLs`);
      } else {
        console.log(`[sitemaps] status ${response.status()}`);
      }
    }
  } catch (error) {
    console.error(`[sitemaps] failed:`, error.message);
  } finally {
    await ctx.dispose();
  }
  
  console.log(`[sitemaps] returning ${urls.length} URLs`);
  return urls;
}
