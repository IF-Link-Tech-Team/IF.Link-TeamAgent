/** Outbox receipts: what was queued to which conversation, and how it ended. */
import { type OutboundMessage, type ReplyStatus } from '../../core/index.ts'
import type { StoreCore } from './core.ts'

export type DropReason = 'channelGone' | 'channelIgnored' | 'failed'
export interface Receipt extends OutboundMessage { status: ReplyStatus; dropped?: { at: string; reason: DropReason } }
export type Dropped = Receipt & { dropped: { at: string; reason: DropReason } }

/** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
export interface Receipts {
  get(id: string): Receipt | undefined
  /** Pending message receipts, oldest first. */
  waiting(): Receipt[]
  /** True if an earlier message for the same ticket and conversation is still pending with fewer than `failures` failed attempts. */
  behind(id: string, failures: number): boolean
  /** Records a new pending receipt; an already-recorded message ID keeps its original one. Returns whether it was new. */
  add(message: OutboundMessage): boolean
  /** Marks a pending receipt as sent or dropped, recreating it if withdrawn meanwhile so its ID cannot be queued again. */
  settle(message: OutboundMessage, outcome: 'sent' | DropReason): void
  /** Withdraws a pending message that has not yet been sent. Returns whether one was waiting. */
  withdraw(id: string): boolean
}

export function createReceipts(core: StoreCore): Receipts {
  const { db } = core
  return {
    get: id => core.values<Receipt>('SELECT value FROM outbox WHERE id = ?', id)[0],
    waiting: () => core.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
    behind: (id, failures) => !!db.prepare(`SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ? LIMIT 1`).get(id, failures),
    add: message => Number(db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)').run(message.id,
      JSON.stringify({ ...message, status: 'pending' } as Receipt)).changes) > 0,
    settle: (message, outcome) => {
      // What the Channel drew is part of the receipt: a mark remembers the emoji it added, so the panel and a later reader
      // see the same message the person did.
      const settled = { ...outcome === 'sent' ? { status: 'sent' } : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } },
        ...message.emoji ? { emoji: message.emoji } : {} }
      const { id, channel, text, kind, ticketId } = message
      const updated = db.prepare("UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'")
        .run(JSON.stringify(settled), id)
      if (!Number(updated.changes)) db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
        .run(id, JSON.stringify({ id, channel, text, kind, ...ticketId ? { ticketId } : {}, ...settled }))
    },
    withdraw: id => Number(db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id).changes) > 0,
  }
}
