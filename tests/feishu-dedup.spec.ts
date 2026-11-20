import { describe, expect, it } from 'vitest'

import { addressedToAnotherBot } from '../src/sources/feishu/state.ts'
import type { Trigger } from '../src/core/index.ts'

const SELF = ['ou_self', 'cli_self']
const LISTED = [{ id: 'ou_iflist' }, { id: 'ou_other' }]

const trigger = (mentions: string[]): Trigger => ({
  id: 'feishu:om_1',
  source: 'feishu',
  threads: [{ source: 'feishu', id: 'feishu:oc_1' }],
  actor: { source: 'feishu', id: 'ou_alice' },
  human: true,
  at: '2026-11-20T08:00:00.000Z',
  text: '@IF.List Agent 帮我建一条',
  channel: { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1' } },
  meta: { chatId: 'oc_1', messageId: 'om_1', mentions },
})

describe('a message addressed to another bot', () => {
  it('is dropped, so the other agent does not also answer it', () => {
    expect(addressedToAnotherBot(trigger(['ou_iflist']), SELF, LISTED)).toBe(true)
  })

  it('is kept when it also mentions us: our own mention wins', () => {
    expect(addressedToAnotherBot(trigger(['ou_iflist', 'ou_self']), SELF, LISTED)).toBe(false)
  })

  it('is kept when the mentioned id is not a listed bot', () => {
    expect(addressedToAnotherBot(trigger(['ou_someone']), SELF, LISTED)).toBe(false)
  })

  it('is kept when nobody was mentioned at all', () => {
    expect(addressedToAnotherBot(trigger([]), SELF, LISTED)).toBe(false)
  })
})
