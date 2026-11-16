import { describe, expect, it } from 'vitest'
import { Gestures } from '../src/app/gestures.ts'
import type { Trigger } from '../src/core/index.ts'

/** The pace a saved Policy carries; every admission reads it afresh. */
const pace = (personMinutes: number, perHour: number) => () => ({ personMinutes, perHour })
const trigger = (person: string, chat: string): Trigger => ({ id: `${person}:${chat}`, source: 'feishu', threads: [], actor: { source: 'feishu', id: person },
  human: true, at: '2026-11-13T00:00:00.000Z', text: 'thanks', channel: { source: 'feishu', thread: chat, address: { chatId: chat } }, meta: { chatId: chat } })

describe('Gestures', () => {
  it('holds one person back for the configured time and a chat to the configured hourly pace', () => {
    const store = new Map<string, unknown>()
    const now = { at: Date.parse('2026-11-13T10:00:00Z') }
    const gestures = new Gestures({ get: key => store.get(key) as never, set: (key, value) => { store.set(key, value) } },
      () => now.at, pace(30, 2))
    const gesture = { score: 4, intent: 'thanks' as const }
    expect(gestures.admit(trigger('a', 'c1'), gesture)).toBe(true)
    // The same person may not be answered twice within 30 minutes, even in another chat.
    expect(gestures.admit(trigger('a', 'c2'), gesture)).toBe(false)
    now.at += 31 * 60_000
    expect(gestures.admit(trigger('a', 'c2'), gesture)).toBe(true)
    // The chat's hourly allowance of two is spent: the first two went out, the third waits.
    expect(gestures.admit(trigger('b', 'c2'), gesture)).toBe(true)
    expect(gestures.admit(trigger('c', 'c2'), gesture)).toBe(false)
    // A tighter saved pace applies on the next admission without a restart.
    now.at += 31 * 60_000
    const strict = new Gestures({ get: key => store.get(key) as never, set: (key, value) => { store.set(key, value) } },
      () => now.at, pace(120, 1))
    expect(strict.admit(trigger('c', 'c3'), gesture)).toBe(true)
    expect(strict.admit(trigger('d', 'c3'), gesture)).toBe(false)
  })
})
