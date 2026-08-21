import { request } from 'playwright';

export async function fetchRobotsTxt(baseUrl) {
  const urls = [];
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    const ctx = await request.newContext();
    const response = await ctx.get(robotsUrl, { timeout: 10_000 });
    
    if (response.ok()) {
      const text = await response.text();
      
      // Extract sitemap URLs
      const sitemapLines = text.match(/^sitemap:\s*(.+)$/gim) || [];
      for (const line of sitemapLines) {
        const sitemapUrl = line.split(':')[1].trim();
        urls.push(sitemapUrl);
      }
    }
    
    await ctx.dispose();
  } catch (error) {
    console.error(`[robots] failed:`, error.message);
  }
  
  return urls;
}
