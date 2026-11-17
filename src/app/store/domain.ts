/** The domain aggregates as rows: triggers, threads, tickets and decisions, with their thread and search indexes. */
import { threadKey, type Decision, type Repositories, type Thread, type ThreadFact, type ThreadFacts, type Ticket, type Trigger,
  type TriggerDisposition } from '../../core/index.ts'
import type { StoreCore } from './core.ts'
import { decisionText, ticketText, type Search } from './search.ts'

/** A Thread's row, with the metadata writes Sources and the panel use beyond the engine's port. */
export type ThreadRepository = Repositories['threads'] & {
  describe(key: string, patch: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void
  patchMeta(key: string, patch: Record<string, unknown>): void
}
/** The four aggregates the Engine writes through `Repositories`. */
export type DomainRepositories = Pick<Repositories, 'triggers' | 'tickets' | 'decisions'> & { threads: ThreadRepository }

export function createDomain(core: StoreCore, search: Search): DomainRepositories {
  const { db } = core
  /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
  const indexThreads = (trigger: Trigger): void => {
    db.prepare('DELETE FROM trigger_thread WHERE id=?').run(trigger.id)
    const insert = db.prepare('INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)')
    for (const ref of trigger.threads) insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
  }

  const triggers = {
    get: (id: string): Trigger | undefined => {
      const row = db.prepare('SELECT value FROM trigger WHERE id=?').get(id)
      return row ? JSON.parse(String(row.value)) as Trigger : undefined
    },
    save: (trigger: Trigger): void => core.atomic(() => {
      db.prepare('INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at')
        .run(trigger.id, JSON.stringify(trigger), trigger.at)
      indexThreads(trigger)
      search.index('trigger', trigger.id, trigger.at, trigger.text)
    }),
    disposition: (id: string): TriggerDisposition | undefined => {
      const row = db.prepare('SELECT value FROM disposition WHERE id=?').get(id)
      return row ? JSON.parse(String(row.value)) as TriggerDisposition : undefined
    },
    saveDisposition: (id: string, value: TriggerDisposition): void => {
      db.prepare('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value))
    },
  }

  const threads = {
    get: (keyValue: string): Thread | undefined => {
      const row = db.prepare('SELECT value FROM thread WHERE key=?').get(keyValue)
      return row ? JSON.parse(String(row.value)) as Thread : undefined
    },
    save: (thread: Thread): void => {
      db.prepare('INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(thread.key, JSON.stringify(thread))
    },
    list: (): Thread[] => db.prepare('SELECT value FROM thread ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Thread),
    active: (): Thread[] => core.values('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
    /** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
    describe: (keyValue: string, patch: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void => {
      const thread = threads.get(keyValue)
      if (!thread) return
      const facts: ThreadFacts = { ...(thread.meta.facts as ThreadFacts | undefined) }
      for (const [id, fact] of Object.entries(patch.facts ?? {})) { if (fact) facts[id] = fact; else delete facts[id] }
      const meta = { ...thread.meta, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.url === undefined ? {} : { url: patch.url }), facts }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) threads.save({ ...thread, meta })
    },
    /** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
    patchMeta: (keyValue: string, patch: Record<string, unknown>): void => core.atomic(() => {
      const thread = threads.get(keyValue)
      if (!thread) return
      const meta = { ...thread.meta }
      for (const [name, value] of Object.entries(patch)) { if (value === undefined) delete meta[name]; else meta[name] = value }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) threads.save({ ...thread, meta })
    }),
  }

  const tickets = {
    get: (id: string): Ticket | undefined => {
      const row = db.prepare('SELECT value FROM ticket WHERE id=?').get(id)
      return row ? JSON.parse(String(row.value)) as Ticket : undefined
    },
    save: (ticket: Ticket): void => core.atomic(() => {
      db.prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id, JSON.stringify(ticket))
      search.index('ticket', ticket.id, ticket.updatedAt || ticket.createdAt, ticketText(ticket))
    }),
    /** Newest first. */
    list: (): Ticket[] => core.values('SELECT value FROM ticket ORDER BY rowid DESC'),
    /** Newest first. */
    open: (): Ticket[] => core.values('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC'),
    /** Newest first. */
    active: (): Ticket[] => core.values('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC'),
  }

  const decisions = {
    get: (id: string): Decision | undefined => {
      const row = db.prepare('SELECT value FROM decision WHERE id=?').get(id)
      return row ? JSON.parse(String(row.value)) as Decision : undefined
    },
    save: (decision: Decision): void => core.atomic(() => {
      db.prepare('INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread')
        .run(decision.id, decision.threadKey, JSON.stringify(decision))
      search.index('decision', decision.id, decision.at, decisionText(decision))
    }),
    byThread: (threadKeyValue: string): Decision[] => db.prepare('SELECT value FROM decision WHERE thread=? ORDER BY rowid')
      .all(threadKeyValue).map(row => JSON.parse(String(row.value)) as Decision),
  }

  return { triggers, threads, tickets, decisions }
}
