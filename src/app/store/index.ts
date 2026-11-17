/**
 * SQLite backing store implementing domain `Repositories`, view read queries, versioned settings, outbox receipts, and key-value state.
 * The Runtime opens it after locking the state directory and automatically migrates supported older schemas on startup.
 * The Engine mutates domain aggregates inside `atomic` transactions while Sources, views, and the Outbox read state or update their own records.
 * Each facet — schema, key-value, search, settings, aggregates, receipts — sits in its own file and shares only `StoreCore`.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { key, threadKey, type ChannelRef, type Repositories } from '../../core/index.ts'
import type { Family, Key } from '../../kv.ts'
import type { Settings, SettingsSave } from '../../policy/index.ts'
import { SCHEMA_VERSION } from '../migration.ts'
import { storeReads } from '../store-read.ts'
import type { StoreCore } from './core.ts'
import { createDomain, type DomainRepositories } from './domain.ts'
import { createKv, type Kv } from './kv.ts'
import { createReceipts, type Receipts } from './outbox.ts'
import { initializeSchema } from './schema.ts'
import { createSearch, type Search, type SearchMatch } from './search.ts'
import { createSettings, type SettingsStore, type SettingsVersion } from './settings.ts'

export { SCHEMA_VERSION }
export type { DropReason, Dropped, Receipt } from './outbox.ts'
export type { SearchMatch } from './search.ts'
/** A Trigger's position on its thread timeline, ordered by timestamp and then `id` as tie-breaker. */
export interface TimelinePlace { at: string; id: string }
export type { SettingsVersion } from './settings.ts'

/**
 * Opens or creates the SQLite database at `path`, migrating an older schema to this build's in a single transaction.
 * @param report - Receives errors thrown by `afterCommit` callbacks without failing the committed transaction.
 * @throws When the database schema is older than `OLDEST_SCHEMA`, newer than this build's, or when migration fails; in every
 * case the database file is left unchanged and the handle closed so a later attempt in the same process can open it.
 */
export class Store implements Repositories {
  readonly db: DatabaseSync
  private readonly kv: Kv
  private readonly index: Search
  private readonly settingsStore: SettingsStore
  private readonly aggregates: ReturnType<typeof createDomain>
  readonly receipts: Receipts
  /** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
  readonly read: ReturnType<typeof storeReads>
  private depth = 0
  /** Callbacks queued to run once the outermost transaction commits, indexed by savepoint level; rolling back a level discards its callbacks. */
  private readonly committed: (() => void)[][] = []

  constructor(path: string, private readonly report: (error: unknown) => void = () => {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.kv = createKv(this.db)
    this.read = storeReads(this.db)
    this.index = createSearch(this)
    this.settingsStore = createSettings(this)
    this.aggregates = createDomain(this, this.index)
    this.receipts = createReceipts(this)
    this.triggers = this.aggregates.triggers
    this.threads = this.aggregates.threads
    this.tickets = this.aggregates.tickets
    this.decisions = this.aggregates.decisions
    try {
      initializeSchema(this, path)
      // The index is derived from the record tables, so a database opened before search existed gets it from its rows, not a migration.
      if (!this.index.isIndexed()) this.index.rebuild()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /** Closes the underlying SQLite database connection. */
  close(): void { this.db.close() }

  /** Parses JSON `value` columns returned by a query. */
  values<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  }

  /** Reads a typed KV record by its key in `KV`. */
  get<V>(name: Key<V>): V | undefined { return this.kv.get(name) }
  /** Writes a typed KV record under `name`. */
  set<V>(name: Key<V>, value: V): void { this.kv.set(name, value) }
  /** Deletes the KV record at `name`. */
  delete(name: string): void { this.kv.delete(name) }
  /** Returns all KV keys belonging to `family` or starting with `prefix`. */
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  keys(family: string | { prefix: string }): string[] { return this.kv.keys(family as never) as string[] }

  /** Current validated settings. */
  settings(): Settings { return this.settingsStore.settings() }
  /** Revision of one settings block; each configuration page saves against its own block for optimistic concurrency. */
  blockRevision(block: SettingsSave): number { return this.settingsStore.blockRevision(block) }
  /** Saves settings as the next revision (making it current) and increments `record.block`'s revision counter when present. */
  saveSettings(value: unknown, record: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'> = { source: 'internal', policyVersion: '', policyChanged: false, notified: [] }): Settings {
    return this.settingsStore.save(value, record)
  }
  /** Saved settings revisions, newest first; revisions predating settings history are absent. */
  settingsHistory(limit = 20): SettingsVersion[] { return this.settingsStore.history(limit) }

  /** Replaces the searchable text of one record; an empty body removes it. */
  indexSearch(kind: string, ref: string, at: string, body: string): void { this.index.index(kind, ref, at, body) }
  /** Rebuilds the derived index from the three tables in one transaction. */
  rebuildSearch(): void { this.index.rebuild() }
  /** Index the journal entries under `dir/journal` alongside tickets, triggers and decisions. */
  indexJournal(dir: string): void { this.index.indexJournal(dir) }
  /** Ranked matches across tickets, triggers, decisions and the journal. */
  search(query: string, options: { kinds?: readonly string[]; limit?: number } = {}): SearchMatch[] { return this.index.search(query, options) }

  /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
  replyStatus(id: string): import('../../core/index.ts').ReplyStatus | undefined { return this.receipts.get(id)?.status }

  readonly triggers: DomainRepositories['triggers']
  readonly threads: DomainRepositories['threads']
  readonly tickets: DomainRepositories['tickets']
  readonly decisions: DomainRepositories['decisions']

  /**
   * Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
   * Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
   */
  atomic<T>(operation: () => T): T {
    const level = this.depth++
    const name = `orchestrator_atomic_${level}`
    this.committed[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try { value = operation(); this.db.exec(`RELEASE ${name}`) }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
    const actions = this.committed.splice(level)[0]!
    if (level) this.committed[level - 1]!.push(...actions)
    else for (const action of actions) { try { action() } catch (error) { this.report(error) } }
    return value
  }

  /**
   * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
   * callbacks queued inside a transaction that rolls back are discarded and never run.
   */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }
}
export { key, threadKey }
export type { ChannelRef }
