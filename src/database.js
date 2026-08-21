import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

const directory = path.dirname(config.databasePath);
fs.mkdirSync(directory, { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_scan_at TEXT DEFAULT '1970-01-01T00:00:00.000Z'
  );

  CREATE TABLE IF NOT EXISTS paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER,
    content_hash TEXT NOT NULL,
    first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
    UNIQUE(target_id, url)
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL,
    pattern TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
    UNIQUE(target_id, pattern)
  );
`);

// Migration: add last_scan_at column if it doesn't exist
try {
  db.prepare('SELECT last_scan_at FROM targets LIMIT 1').get();
} catch (error) {
  if (error.message.includes('no such column')) {
    console.log('[db] adding last_scan_at column to targets table');
    db.exec(`ALTER TABLE targets ADD COLUMN last_scan_at TEXT DEFAULT '1970-01-01T00:00:00.000Z'`);
  }
}

export function upsertTarget(name, url) {
  return db.prepare(`
    INSERT INTO targets (name, url)
    VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET
      url = excluded.url,
      enabled = 1
  `).run(name, url);
}

export function disableTarget(name) {
  return db.prepare(`
    UPDATE targets SET enabled = 0 WHERE name = ?
  `).run(name);
}

export function getTargets() {
  return db.prepare(`
    SELECT id, name, url, enabled, created_at, last_scan_at
    FROM targets
    WHERE enabled = 1
    ORDER BY name
  `).all();
}

export function getStoredPaths(targetId, days = null) {
  let query = `
    SELECT url, path, status, first_seen, last_seen
    FROM paths
    WHERE target_id = ?
  `;
  
  const params = [targetId];
  
  if (days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    query += ` AND first_seen >= ?`;
    params.push(cutoff.toISOString());
  }
  
  query += ` ORDER BY path ASC`;
  
  return db.prepare(query).all(...params);
}

export function getNewPathsSinceLastScan(targetId) {
  return db.prepare(`
    SELECT url, path, status, first_seen, last_seen
    FROM paths
    WHERE target_id = ? AND first_seen > (
      SELECT COALESCE(last_scan_at, '1970-01-01') FROM targets WHERE id = ?
    )
    ORDER BY first_seen DESC
  `).all(targetId, targetId);
}

export function savePath({ targetId, url, path: pathname, status, contentHash }) {
  const existing = db.prepare(`
    SELECT id, content_hash
    FROM paths
    WHERE target_id = ? AND url = ?
  `).get(targetId, url);

  if (!existing) {
    db.prepare(`
      INSERT INTO paths (
        target_id, url, path, status, content_hash
      ) VALUES (?, ?, ?, ?, ?)
    `).run(targetId, url, pathname, status, contentHash);

    return { type: 'new' };
  }

  const changed = existing.content_hash !== contentHash;

  db.prepare(`
    UPDATE paths
    SET path = ?, status = ?, content_hash = ?, last_seen = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(pathname, status, contentHash, existing.id);

  return { type: changed ? 'changed' : 'unchanged' };
}

export function countStoredPaths(targetId) {
  const result = db.prepare(`
    SELECT COUNT(*) as count
    FROM paths
    WHERE target_id = ?
  `).get(targetId);
  
  return result.count;
}

export function removeUrlsByPattern(targetId, pattern) {
  const stmt = db.prepare('DELETE FROM paths WHERE target_id = ? AND url LIKE ?');
  const result = stmt.run(targetId, `%${pattern}%`);
  console.log(`[db] removed ${result.changes} URLs matching "${pattern}" from target ${targetId}`);
  return result.changes;
}

export function updateLastScan(targetId) {
  db.prepare(`UPDATE targets SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?`).run(targetId);
}

export function addBlacklist(targetId, pattern) {
  return db.prepare(`
    INSERT INTO blacklist (target_id, pattern)
    VALUES (?, ?)
    ON CONFLICT(target_id, pattern) DO NOTHING
  `).run(targetId, pattern);
}

export function getBlacklist(targetId) {
  return db.prepare(`
    SELECT pattern FROM blacklist WHERE target_id = ?
  `).all(targetId).map(r => r.pattern);
}

export function removeBlacklist(targetId, pattern) {
  return db.prepare(`
    DELETE FROM blacklist WHERE target_id = ? AND pattern = ?
  `).run(targetId, pattern);
}

export function clearBlacklist(targetId) {
  return db.prepare(`
    DELETE FROM blacklist WHERE target_id = ?
  `).run(targetId);
}
