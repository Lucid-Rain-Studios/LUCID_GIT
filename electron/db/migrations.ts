import type Database from 'better-sqlite3'

export function runMigrations(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lock_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_path     TEXT    NOT NULL,
      file_path     TEXT    NOT NULL,
      event_type    TEXT    NOT NULL,
      actor_login   TEXT    NOT NULL DEFAULT '',
      actor_name    TEXT    NOT NULL DEFAULT '',
      timestamp     INTEGER NOT NULL,
      duration_ms   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lock_events_repo  ON lock_events (repo_path, timestamp);
    CREATE INDEX IF NOT EXISTS idx_lock_events_file  ON lock_events (repo_path, file_path);

    CREATE TABLE IF NOT EXISTS conflict_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_path     TEXT    NOT NULL,
      file_path     TEXT    NOT NULL,
      our_branch    TEXT    NOT NULL DEFAULT '',
      their_branch  TEXT    NOT NULL DEFAULT '',
      conflict_type TEXT    NOT NULL DEFAULT 'content',
      timestamp     INTEGER NOT NULL,
      resolved      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_conflict_events_repo ON conflict_events (repo_path, timestamp);
    CREATE INDEX IF NOT EXISTS idx_conflict_events_file ON conflict_events (repo_path, file_path);
  `)
  // Preserve old records, whose preview origin / lock identity is unknown.
  const lockColumns = db.prepare('PRAGMA table_info(lock_events)').all() as Array<{ name: string }>
  if (!lockColumns.some(column => column.name === 'lock_id')) db.exec("ALTER TABLE lock_events ADD COLUMN lock_id TEXT NOT NULL DEFAULT ''")
  const conflictColumns = db.prepare('PRAGMA table_info(conflict_events)').all() as Array<{ name: string }>
  if (!conflictColumns.some(column => column.name === 'source')) db.exec("ALTER TABLE conflict_events ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy'")
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lock_events_identity
    ON lock_events (repo_path, lock_id, CASE WHEN event_type = 'locked' THEN 'locked' ELSE 'released' END)
    WHERE lock_id <> '';
  `)
}
