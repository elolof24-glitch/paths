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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
`);

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
    SELECT id, name, url, enabled, created_at
    FROM targets
    WHERE enabled = 1
    ORDER BY name
  `).all();
}

export function getStoredPaths(targetId) {
  return db.prepare(`
    SELECT url, path, status, first_seen, last_seen
    FROM paths
    WHERE target_id = ?
    ORDER BY path ASC
  `).all(targetId);
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
