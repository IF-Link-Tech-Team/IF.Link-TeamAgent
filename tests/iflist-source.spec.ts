import { beforeEach, describe, expect, it } from 'vitest'

import { iflistCallbackTrigger, iflistKind, iflistTrigger, resetDirectoryCache, runIfList, sendIfList, type IfListConfig } from '../src/sources/iflist.ts'
import type { SourceContext } from '../src/sources/host.ts'

const config: IfListConfig = { pollSeconds: 1, directMessages: true, pageSize: 20, directIntake: false }

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  seq: 1,
  messageId: 'om_1',
  chatId: 'oc_1',
  chatType: 'p2p',
  unionId: 'on_alice',
  text: '帮我建一条：周五前整理报名表',
  addressed: 'direct' as const,
  at: '2026-11-20T08:00:00.000Z',
  ...over,
})

const callback = (over: Partial<Record<string, unknown>> = {}) => item({
  kind: 'card_action',
  messageId: 'card:p1:create:created:success:iss-1',
  chatId: 'oc_origin',
  chatType: 'group',
  text: 'IF.List 卡片回调：整理报名表\n状态：created',
  ticketId: 'a'.repeat(32),
  proposalId: 'p1',
  action: 'create',
  proposalState: 'created',
  outcome: 'success',
  operatorOpenId: 'ou_alice',
  operatorUnionId: 'on_alice',
  issueId: 'iss-1',
  ...over,
})

const origin = {
  id: 'feishu:om_origin',
  source: 'feishu',
  threads: [{ source: 'feishu', id: 'oc_origin:om_origin' }],
  actor: { source: 'feishu', id: 'ou_alice' },
  human: true,
  addressed: 'mention',
  at: '2026-11-20T07:00:00.000Z',
  text: '建一条任务',
  channel: { source: 'feishu', thread: 'feishu:oc_origin:om_origin', address: { chatId: 'oc_origin', messageId: 'om_origin' } },
  meta: {},
}
const ticket = { id: 'a'.repeat(32), origin: { triggerId: origin.id, triggerIds: [origin.id] } }
const callbackContext = {
  tickets: { get: (id: string) => id === ticket.id ? ticket : undefined },
  triggers: { get: (id: string) => id === origin.id ? origin : undefined },
}

describe('IF.List Source', () => {
  beforeEach(() => resetDirectoryCache())
  it('maps a direct message to an explicit Trigger on its own Thread', () => {
    const trigger = iflistTrigger(item() as never)
    expect(trigger.id).toBe('iflist:om_1')
    expect(trigger.threads[0]?.id).toBe('iflist:om_1')
    expect(trigger.actor.id).toBe('on_alice')
    expect(trigger.addressed).toBe('direct')
    expect(trigger.human).toBe(true)
    expect(trigger.meta).toMatchObject({ chatId: 'oc_1', messageId: 'om_1', direct: true })
  })

  it('keeps two direct messages in the same chat on separate threads', () => {
    const first = iflistTrigger(item() as never)
    const second = iflistTrigger(item({ messageId: 'om_2' }) as never)
    expect(first.threads[0]?.id).not.toBe(second.threads[0]?.id)
    expect(first.threads[0]?.id).toBe('iflist:om_1')
    expect(second.threads[0]?.id).toBe('iflist:om_2')
  })

  it('marks a group mention as addressed by mention, and keeps the chat as its Thread', () => {
    const trigger = iflistTrigger(item({ chatType: 'group', addressed: 'mention' }) as never)
    expect(trigger.addressed).toBe('mention')
    expect(trigger.meta.direct).toBe(false)
    expect(trigger.threads[0]?.id).toBe('iflist:oc_1')
    expect(trigger.channel?.address.direct).toBe('false')
  })

  it('listens to direct messages only while they are allowed', () => {
    expect(iflistKind.scope!({ meta: { direct: true } }, config)).toMatchObject({ listened: true, row: 'direct' })
    expect(iflistKind.scope!({ meta: { direct: true } }, { ...config, directMessages: false }))
      .toMatchObject({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(iflistKind.scope!({ meta: { direct: false } }, config)).toMatchObject({ listened: true, row: 'group' })
    expect(iflistKind.scope!({ meta: { direct: true, kind: 'card_action' } }, { ...config, directMessages: false }))
      .toMatchObject({ listened: true, row: 'group' })
  })

  it('replies through the IF.List bot, under the message that started the thread', async () => {
    const calls: [string, string[]][] = []
    const host = { commands: { run: async (program: string, args: string[]) => { calls.push([program, args]); return '{"ok":true}' } } }
    const state = await sendIfList(host as never, {
      id: 'r1',
      channel: { source: 'iflist', thread: 'iflist:om_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
      text: '建好了',
      kind: 'reply',
    })
    expect(state).toBe('sent')
    expect(calls[0]?.[1]).toEqual(['say', '--chat', 'oc_1', '--text', '建好了', '--reply', 'om_1'])
  })

  it('direct-intakes a natural DM with one model call and one propose command', async () => {
    const calls: string[][] = []
    let cursor: number | undefined
    const controller = new AbortController()
    const ctx = {
      config: () => ({ ...config, directIntake: true }),
      complete: async () => JSON.stringify({
        title: '确定下一次 Meetup 的主题',
        project: 'Meetup',
        assignees: ['self'],
        start: '2026-11-23',
        due: '2026-11-25',
        priority: 'high',
        description: '围绕 team agent / deepseek harness 定下一次主题。',
        confidence: 0.92,
      }),
      commands: (() => {
        const run = async (_program: string, args: string[]): Promise<string> => {
          calls.push(args)
          if (args[0] === 'inbox') return JSON.stringify({ items: [item({ text: '在 Meetup 项目里定下一次主题，两天后开始，下周三截止，次高' })], next: 1 })
          if (args[0] === 'project') return JSON.stringify({ projects: [{ identifier: 'MEETUP', name: 'Meetup' }] })
          if (args[0] === 'workspace-people') return JSON.stringify({ members: [{ display_name: '梁宇凡', email: 'on_alice@feishu.iflink.tech' }] })
          if (args[0] === 'task') { controller.abort(); return JSON.stringify({ ok: true }) }
          return '{}'
        }
        return { run, withSignal: () => ({ run }) }
      })(),
      state: { get: () => cursor, set: (_key: string, value: number) => { cursor = value } },
      tickets: { open: () => [], get: () => undefined },
      notify: () => undefined,
      receive: async () => { throw new Error('must not fall back to the Engine') },
      report: () => undefined,
    }
    await runIfList(ctx as unknown as SourceContext, controller.signal)
    expect(cursor).toBe(1)
    const propose = calls.find(args => args[0] === 'task')!
    expect(propose).toContain('--suppress-assignment-card')
    expect(propose).toContain('--to')
    expect(propose).toContain('on_alice')
    expect(propose).toContain('--priority')
    expect(propose).toContain('high')
  })


  it('direct-intakes a group @ with a private card and --direct false', async () => {
    const calls: string[][] = []
    const controller = new AbortController()
    const ctx = {
      config: () => ({ ...config, directIntake: true }),
      complete: async () => JSON.stringify({ title: '写需求文档', project: 'Design Agent', assignees: ['self'],
        start: '2026-11-21', due: '2026-11-27', priority: 'high', description: '', confidence: 0.9 }),
      commands: (() => {
        const run = async (_program: string, args: string[]): Promise<string> => {
          calls.push(args)
          if (args[0] === 'inbox') return JSON.stringify({ items: [item({ chatType: 'group', addressed: 'mention', chatId: 'oc_group' })], next: 1 })
          if (args[0] === 'project') return JSON.stringify({ projects: [{ identifier: 'DESIGNAI', name: 'Design Agent' }] })
          if (args[0] === 'workspace-people') return JSON.stringify({ members: [{ display_name: '梁宇凡', email: 'on_alice@feishu.iflink.tech' }] })
          if (args[0] === 'task') { controller.abort(); return JSON.stringify({ ok: true }) }
          return '{}'
        }
        return { run, withSignal: () => ({ run }) }
      })(),
      state: { get: () => undefined, set: () => undefined },
      tickets: { open: () => [], get: () => undefined },
      notify: () => undefined,
      receive: async () => { throw new Error('must not fall back') },
      report: () => undefined,
    }
    await runIfList(ctx as unknown as SourceContext, controller.signal)
    const propose = calls.find(args => args[0] === 'task')!
    expect(propose).toContain('--direct')
    expect(propose[propose.indexOf('--direct') + 1]).toBe('false')
    expect(propose[propose.indexOf('--chat') + 1]).toBe('oc_group')
    expect(propose).not.toContain('--why')
  })


  it('replies with the existing ticket instead of sending a duplicate card', async () => {
    const notes: { text: string; channel: unknown }[] = []
    const controller = new AbortController()
    const existing = { id: 'a'.repeat(32), title: '完成 Design Agent 需求文档', createdAt: new Date().toISOString() }
    const ctx = {
      config: () => ({ ...config, directIntake: true }),
      complete: async () => JSON.stringify({ title: '完成 Design Agent 需求文档', project: 'DESIGNAI', assignees: ['self'],
        confidence: 0.9, duplicate_of: existing.id }),
      commands: (() => {
        const run = async (_program: string, args: string[]): Promise<string> => {
          if (args[0] === 'inbox') return JSON.stringify({ items: [item()], next: 1 })
          if (args[0] === 'project') return JSON.stringify({ projects: [] })
          if (args[0] === 'workspace-people') return JSON.stringify({ members: [] })
          throw new Error('must not propose a duplicate')
        }
        return { run, withSignal: () => ({ run }) }
      })(),
      state: { get: () => undefined, set: () => undefined },
      tickets: { open: () => [existing], get: (id: string) => id === existing.id ? existing : undefined },
      notify: (message: { text: string; channel: unknown }) => { notes.push(message); controller.abort() },
      receive: async () => { throw new Error('must not fall back') },
      report: () => undefined,
    }
    await runIfList(ctx as unknown as SourceContext, controller.signal)
    expect(notes[0]?.text).toContain('完成 Design Agent 需求文档')
    expect(notes[0]?.text).toContain('没有重复建单')
  })

  it('maps a card result to the original Feishu thread without making it a new addressed request', () => {
    const trigger = iflistCallbackTrigger(callback() as never, callbackContext as never)
    expect(trigger?.threads).toEqual(origin.threads)
    expect(trigger?.channel?.thread).toBe('feishu:oc_origin:om_origin')
    expect(trigger?.channel?.address).toEqual({ chatId: 'oc_origin', messageId: 'om_origin', direct: 'false' })
    expect(trigger?.human).toBe(true)
    expect(trigger?.addressed).toBeUndefined()
    expect(trigger?.meta).toMatchObject({ kind: 'card_action', ticketId: ticket.id, proposalId: 'p1', issueId: 'iss-1' })
  })

  it('does not invent a conversation for direct-intake cards that have no Team Agent ticket', () => {
    expect(iflistCallbackTrigger(callback({ ticketId: 'iflist-direct:om_1' }) as never, callbackContext as never)).toBeUndefined()
  })

  it('delivers a card result only to its ticket, bypasses direct intake, and advances the cursor', async () => {
    const received: { trigger: { id: string; meta: Record<string, unknown> }; ticketId: string }[] = []
    let cursor: number | undefined
    const controller = new AbortController()
    const ctx = {
      config: () => ({ ...config, directIntake: true }),
      commands: { withSignal: () => ({ run: async () => JSON.stringify({ items: [callback()], next: 1 }) }) },
      state: { get: () => cursor, set: (_key: string, value: number) => { cursor = value } },
      tickets: callbackContext.tickets,
      triggers: callbackContext.triggers,
      complete: async () => { throw new Error('card callbacks must not be extracted as messages') },
      receiveForTicket: async (trigger: { id: string; meta: Record<string, unknown> }, ticketId: string) => {
        received.push({ trigger, ticketId })
        controller.abort()
        return 'stored'
      },
      receive: async () => { throw new Error('must not fan out or queue an Eval') },
      report: () => undefined,
    }
    await runIfList(ctx as unknown as SourceContext, controller.signal)
    expect(cursor).toBe(1)
    expect(received).toHaveLength(1)
    expect(received[0]?.ticketId).toBe(ticket.id)
    expect(received[0]?.trigger.meta.kind).toBe('card_action')
  })

  it('pulls once, hands every message to the Engine, and advances the cursor', async () => {
    const received: string[] = []
    let cursor: number | undefined
    const controller = new AbortController()
    const ctx = {
      config: () => config,
      commands: { withSignal: () => ({ run: async () => JSON.stringify({ items: [item(), item({ seq: 2, messageId: 'om_2' })], next: 2 }) }) },
      state: { get: () => cursor, set: (_key: string, value: number) => { cursor = value } },
      receive: async (trigger: { id: string }) => {
        received.push(trigger.id)
        controller.abort()
        return {}
      },
      report: () => undefined,
    }
    await runIfList(ctx as unknown as SourceContext, controller.signal)
    expect(received).toEqual(['iflist:om_1', 'iflist:om_2'])
    expect(cursor).toBe(2)
  })
})
