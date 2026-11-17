/** What every facet of the Store needs from it: the SQLite handle, savepoints, key-value state, and row decoding. */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Family, Key } from '../../kv.ts'

export interface StoreCore {
  readonly db: DatabaseSync
  /** Runs `work` in a savepoint and returns its value; nested calls join the outer transaction. */
  atomic<T>(work: () => T): T
  get<V>(name: Key<V>): V | undefined
  set<V>(name: Key<V>, value: V): void
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  /** Parses the JSON `value` column of every row a query returns. */
  values<T>(sql: string, ...parameters: SQLInputValue[]): T[]
}
