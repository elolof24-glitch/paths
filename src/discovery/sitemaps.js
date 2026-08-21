import { request } from 'playwright';
import { parseStringPromise } from 'xml2js';

export async function fetchSitemaps(baseUrl) {
  const urls = [];
  const ctx = await request.newContext();
  
  try {
    const candidates = ['/sitemap.xml', '/sitemap_index.xml'];
    
    for (const path of candidates) {
      const sitemapUrl = new URL(path, baseUrl).toString();
      const response = await ctx.get(sitemapUrl, { timeout: 10_000 });
      
      if (response.ok()) {
        const xml = await response.text();
        const result = await parseStringPromise(xml);
        
        if (result.urlset?.url) {
          for (const entry of result.urlset.url) {
            if (entry.loc?.[0]) {
              urls.push(entry.loc[0]);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(`[sitemaps] failed:`, error.message);
  } finally {
    await ctx.dispose();
  }
  
  return urls;
}
