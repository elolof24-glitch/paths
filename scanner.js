import { config } from './config.js';
import { loadTargets } from './targets.js';
import { db } from './db.js';

export async function checkAll() {
  const targets = loadTargets();
  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - 1); // Only last 30 days
  
  console.log(`[scan] starting scheduled scan (new paths since ${sinceDate.toISOString()})`);
  
  for (const target of targets) {
    await scanTarget(target, sinceDate);
  }
}

export async function scanTarget(target, sinceDate = null) {
  const startTime = Date.now();
  const targetId = target.name;
  
  console.log(`[scan] starting ${targetId}`);
  
  // Get existing URLs for this target
  const existing = db.prepare('SELECT url, discoveredAt FROM urls WHERE target = ?').all(targetId);
  const existingSet = new Set(existing.map(r => r.url));
  const existingMap = new Map(existing.map(r => [r.url, r.discoveredAt]));
  
  // Filter: only process if discoveredAt > sinceDate
  const recentUrls = sinceDate 
    ? existing.filter(r => new Date(r.discoveredAt) > sinceDate).map(r => r.url)
    : [];
  
  console.log(`[scan] ${targetId}: ${existing.length} existing, ${recentUrls.length} new this month`);
  
  // Crawl to find NEW URLs
  const { visited, discovered } = await bfsCrawl(target, existingSet);
  
  // Store new URLs with timestamp
  const now = Date.now();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO urls (url, target, discoveredAt, statusCode, contentType)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  let newCount = 0;
  for (const url of discovered) {
    if (!existingSet.has(url)) {
      insert.run(url, targetId, now, null, null);
      newCount++;
    }
  }
  
  console.log(`[paths] ${targetId}: stored=${existing.length + newCount} new_or_changed=${newCount}`);
  
  // Send alert only if new paths found
  if (newCount > 0) {
    await sendResults({
      target: targetId,
      changes: discovered.filter(url => !existingSet.has(url)),
      visited,
      duration: Date.now() - startTime
    });
  }
}
