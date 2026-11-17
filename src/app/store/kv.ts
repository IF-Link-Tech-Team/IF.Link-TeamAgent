/** The key-value table: typed records in, typed records out, and families of keys by prefix. */
import type { DatabaseSync } from 'node:sqlite'
import type { Family, Key } from '../../kv.ts'

/** The KV facet of the Store, over one SQLite handle. */
export interface Kv {
  get<V>(name: Key<V>): V | undefined
  set<V>(name: Key<V>, value: V): void
  delete(name: string): void
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
}

export function createKv(db: DatabaseSync): Kv {
  const kv: Kv = {
    get: <V>(name: Key<V>): V | undefined => {
      const row = db.prepare('SELECT value FROM kv WHERE key=?').get(name)
      return row === undefined ? undefined : JSON.parse(String(row.value)) as V
    },
    set: <V>(name: Key<V>, value: V): void => {
      db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
    },
    delete: (name: string): void => { db.prepare('DELETE FROM kv WHERE key=?').run(name) },
    keys: (family: string | { prefix: string }): string[] => {
      const prefix = typeof family === 'string' ? family : family.prefix
      const pattern = `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`
      return db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'").all(pattern).map(row => String(row.key))
    },
  }
  return kv
}
