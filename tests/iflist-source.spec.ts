import { describe, expect, it } from 'vitest'

import { iflistKind, iflistTrigger, runIfList, sendIfList, type IfListConfig } from '../src/sources/iflist.ts'
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

describe('IF.List Source', () => {
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
