/** The SQLite schema, its generated columns, and the version check that refuses a database it cannot migrate. */
import { chmodSync } from 'node:fs'
import { KV } from '../../kv.ts'
import { OLDEST_SCHEMA, SCHEMA_VERSION, migrateTo11, migrateTo12, tooOld } from '../migration.ts'
import type { StoreCore } from './core.ts'

/**
 * Generated columns and partial indexes defining active working sets so passes scan only active rows.
 * Older databases missing a column get it added on open and populated by SQLite from stored JSON rows.
 */
const SETS: Record<string, Record<string, string>> = {
  ticket: {
    open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
    // Only the latest assignment can be pending or running because the Engine closes one before adding the next.
    active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`,
  },
  thread: {
    active: "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
    subscribed: "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
  },
  // Composite key (ticketId + thread) used to preserve per-conversation reply order.
  outbox: { dropped: "TEXT AS (value ->> '$.dropped.at')", pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)` },
}

/** Creates the tables and indexes a current database needs, migrating an older one in a single transaction. */
function createTables(core: StoreCore): void {
  core.db.exec(`
    CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
      PRIMARY KEY (thread, id));
    CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
      since TEXT NOT NULL, PRIMARY KEY (kind, key));
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(body, kind UNINDEXED, ref UNINDEXED, at UNINDEXED, tokenize='trigram');
    CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
    CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
    CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
    CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
  `)
}

/** Reconciles generated working-set columns and indexes when opening databases created by earlier versions. */
function addColumns(core: StoreCore): void {
  const { db } = core
  const columns = (table: string) => new Set(db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table).map(row => String(row.name)))
  for (const [table, definitions] of Object.entries(SETS)) {
    // Drop generated columns whose definition changed or that were removed, along with their index, before adding current ones.
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? '')
    const generated = db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)').all(table).map(row => String(row.name))
    for (const name of generated) {
      if (definitions[name] && sql.includes(`${name} ${definitions[name]}`)) continue
      db.exec(`DROP INDEX IF EXISTS ${table}_${name}; ALTER TABLE ${table} DROP COLUMN ${name}`)
    }
    const existing = columns(table)
    for (const [name, definition] of Object.entries(definitions)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
      db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL`)
    }
  }
  if (!columns('effect').has('generation')) db.exec('ALTER TABLE effect ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
}

/**
 * Opens the schema on an already-open database, migrating it when it is older than this build.
 * @throws When the schema is older than `OLDEST_SCHEMA`, newer than `SCHEMA_VERSION`, or when migration fails; the database
 * file is left unchanged so a later attempt in the same process can open it.
 */
export function initializeSchema(core: StoreCore, path: string): void {
  const { db } = core
  chmodSync(path, 0o600)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const version = core.get(KV.store.schema)
  if (version !== undefined && version > SCHEMA_VERSION) throw new Error(`Unsupported orchestrator database version ${version}`)
  if (version !== undefined && version < OLDEST_SCHEMA) throw new Error(tooOld(version))
  const migrating = version !== undefined && version < SCHEMA_VERSION
  try {
    core.atomic(() => {
      createTables(core)
      addColumns(core)
      if (migrating && version! < 11) migrateTo11(core as unknown as Parameters<typeof migrateTo11>[0])
      if (migrating) migrateTo12(core as unknown as Parameters<typeof migrateTo12>[0])
      if (version !== SCHEMA_VERSION) core.set(KV.store.schema, SCHEMA_VERSION)
    })
  } catch (error) {
    if (!migrating) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`The orchestrator database is unchanged at schema ${version}: its migration to schema ${SCHEMA_VERSION} failed: ${reason}`, { cause: error })
  }
}
