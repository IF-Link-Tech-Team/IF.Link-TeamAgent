/** Full-text search over tickets, triggers, decisions and journal entries, kept in step with their saves. */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { reasonText, type Decision, type Reason, type Ticket, type Trigger } from '../../core/index.ts'
import type { StoreCore } from './core.ts'

/** A journal entry the index serves; anything else, a path traversal included, is not one. */
const JOURNAL_FILE = /^[A-Za-z0-9_-]+\.md$/
/** One ranked full-text match: the record's kind and id, its own time, and a snippet of its searchable text. */
export interface SearchMatch { kind: string; ref: string; at: string; snippet: string }
/** The searchable text of a ticket: its title, and the latest assignment's report summary when it has one. */
export const ticketText = (ticket: Ticket): string => [ticket.title, ticket.assignments.at(-1)?.report?.summary ?? ''].filter(part => part.trim()).join('\n')
/** The searchable text of a decision: its reasons in words, with one an earlier version stored as a string kept as written. */
export const decisionText = (decision: Decision): string => (Array.isArray(decision.reason) ? decision.reason as unknown[] : [])
  .map(reason => typeof reason === 'string' ? reason : reasonText([reason as Reason])).join('; ')

/** The index facet: writes on save, the derived rebuild on open, and the two ranked queries. */
export interface Search {
  /** Replaces the searchable text of one record; an empty body removes it. */
  index(kind: string, ref: string, at: string, body: string): void
  /** Whether the index holds a row for every record with searchable text. */
  isIndexed(): boolean
  /** Rebuilds the derived index from the record tables in one transaction. */
  rebuild(): void
  /** Indexes the journal entries under `dir/journal`, cheaply when nothing changed. */
  indexJournal(dir: string): void
  /** Ranked matches; `kinds` limits which, and a query under three characters scans for the substring instead. */
  search(query: string, options?: { kinds?: readonly string[]; limit?: number }): SearchMatch[]
}

export function createSearch(core: StoreCore): Search {
  const { db } = core
  /** Signature of the journal files the last synchronization indexed, so a search rewrites them only when they change. */
  let journalSignature = ''
  const search: Search = {
    index: (kind, ref, at, body) => {
      db.prepare('DELETE FROM search_fts WHERE kind=? AND ref=?').run(kind, ref)
      if (body.trim()) db.prepare('INSERT INTO search_fts(body, kind, ref, at) VALUES (?,?,?,?)').run(body, kind, ref, at)
    },
    isIndexed: () => {
      const row = db.prepare(`SELECT
        (SELECT count(*) FROM search_fts WHERE kind <> 'journal') AS indexed,
        (SELECT count(*) FROM trigger WHERE trim(coalesce(value ->> '$.text', ''), char(9) || char(10) || char(13) || ' ') <> '')
          + (SELECT count(*) FROM ticket WHERE trim(coalesce(value ->> '$.title', ''), char(9) || char(10) || char(13) || ' ') <> ''
            OR trim(coalesce(value ->> '$.assignments[#-1].report.summary', ''), char(9) || char(10) || char(13) || ' ') <> '')
          + (SELECT count(*) FROM decision WHERE EXISTS (SELECT 1 FROM json_each(decision.value, '$.reason') AS reason
            WHERE trim(coalesce(reason.value ->> '$.code', '')) <> '')) AS expected`).get()
      return Number(row?.indexed) === Number(row?.expected)
    },
    rebuild: () => {
      core.atomic(() => {
        db.exec('DELETE FROM search_fts')
        for (const trigger of core.values<Trigger>('SELECT value FROM trigger')) search.index('trigger', trigger.id, trigger.at, trigger.text)
        for (const ticket of core.values<Ticket>('SELECT value FROM ticket')) search.index('ticket', ticket.id, ticket.updatedAt || ticket.createdAt, ticketText(ticket))
        for (const decision of core.values<Decision>('SELECT value FROM decision')) search.index('decision', decision.id, decision.at, decisionText(decision))
      })
      journalSignature = ''
    },
    indexJournal: (dir: string) => {
      const root = join(dir, 'journal')
      let names: string[]
      try { names = readdirSync(root).filter(name => JOURNAL_FILE.test(name)).sort() } catch { names = [] }
      const signature = names.map(name => {
        try { const info = statSync(join(root, name)); return `${name}:${info.size}:${info.mtimeMs}` } catch { return name }
      }).join('|')
      if (signature === journalSignature) return
      core.atomic(() => {
        db.prepare("DELETE FROM search_fts WHERE kind='journal'").run()
        for (const name of names) {
          try { search.index('journal', name, '', readFileSync(join(root, name), 'utf8')) } catch { /* A file that vanished mid-scan simply is not indexed. */ }
        }
      })
      journalSignature = signature
    },
    search: (query, options = {}) => {
      const text = query.trim()
      if (!text) return []
      const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 10)), 50)
      const kinds = options.kinds ?? []
      const filter = kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''
      // Quote the query as one phrase, doubling quotes, so FTS5 syntax characters in user input are searched for, not interpreted.
      if ([...text].length >= 3) {
        const phrase = `"${text.replaceAll('"', '""')}"`
        return db.prepare(`SELECT kind, ref, at, snippet(search_fts, 0, '[', ']', '…', 12) AS snippet FROM search_fts
          WHERE search_fts MATCH ?${filter} ORDER BY rank LIMIT ?`).all(phrase, ...kinds, limit)
          .map(row => ({ kind: String(row.kind), ref: String(row.ref), at: String(row.at), snippet: String(row.snippet) }))
      }
      // A shorter query cannot be a trigram, so it keeps the same result shape by scanning for the substring instead.
      const pattern = `%${text.replace(/[\\%_]/g, match => `\\${match}`)}%`
      return db.prepare(`SELECT kind, ref, at, substr(body, max(1, instr(lower(body), lower(?)) - 8), 40) AS snippet FROM search_fts
        WHERE body LIKE ? ESCAPE '\\'${filter} ORDER BY at DESC, rowid ASC LIMIT ?`).all(text, pattern, ...kinds, limit)
        .map(row => ({ kind: String(row.kind), ref: String(row.ref), at: String(row.at), snippet: String(row.snippet) }))
    },
  }
  return search
}
