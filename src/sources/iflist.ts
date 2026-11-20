/** IF.List Source: pulls the messages the IF.List bot received, and replies through the same bot. */
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { OutboundMessage, Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import { sourceContext, type Health, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

/**
 * The IF.List bot has exactly one long-connection client, and it is the IF.List service on the server: it receives
 * direct messages and @mentions, keeps them in an inbox, and lets this Source pull them over HTTPS. Pulling our own
 * service costs no Feishu quota, so the interval can be short.
 *
 * Replies go back through the same bot (`iflist say`), never through this Source's own Feishu bot, so the two entry
 * points a person uses never mix.
 */
export const SOURCE = 'iflist'
/** The binary the runtime calls; it reads its own credentials from ~/.config/iflist/config.json. */
const CLI = process.env.DSH_SUPERAGENT_IFLIST_CLI?.trim() || 'iflist'

export const IfListConfigSchema = z.object({
  /** How often the inbox is pulled. Our own HTTP service, so this costs no platform quota. */
  pollSeconds: z.number().int().min(1).max(60).default(2),
  /** Direct messages reach the agent; turning this off leaves only @mentions in groups. */
  directMessages: z.boolean().default(true),
  /** How many messages one pull returns. */
  pageSize: z.number().int().min(1).max(50).default(20),
}).strict()
export type IfListConfig = z.infer<typeof IfListConfigSchema>

/** One message of the inbox, as the service serialises it. */
const InboxItemSchema = z.object({
  seq: z.number().int(),
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.string().default('p2p'),
  openId: z.string().optional(),
  unionId: z.string().optional(),
  text: z.string().default(''),
  addressed: z.enum(['mention', 'direct']).default('direct'),
  at: z.string(),
})
type InboxItem = z.infer<typeof InboxItemSchema>

const PageSchema = z.object({ items: z.array(InboxItemSchema), next: z.number() })

/** The Trigger one inbox message produces: the message is the unit, its chat is the Thread. */
export function iflistTrigger(item: InboxItem): Trigger {
  const direct = item.chatType === 'p2p'
  const threadId = `${SOURCE}:${item.chatId}`
  return {
    id: `${SOURCE}:${item.messageId}`,
    source: SOURCE,
    threads: [{ source: SOURCE, id: threadId }],
    actor: { source: SOURCE, id: item.unionId ?? item.openId ?? '' },
    human: true,
    addressed: direct ? 'direct' : 'mention',
    at: item.at,
    text: item.text,
    channel: { source: SOURCE, thread: threadId, address: { chatId: item.chatId, messageId: item.messageId, direct: String(direct) } },
    meta: { chatId: item.chatId, messageId: item.messageId, direct, ...(item.unionId ? { unionId: item.unionId } : {}) },
  }
}

const KV = { cursor: record<number>('iflist-cursor') }

/** Replies through the IF.List bot, under the message that started the Thread when there is one. */
export async function sendIfList(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { chatId, messageId } = message.channel.address
  if (!chatId) throw new Error('Missing IF.List chat')
  const args = ['say', '--chat', chatId, '--text', message.text, ...(messageId ? ['--reply', messageId] : [])]
  try {
    await host.commands.run(CLI, args)
    return 'sent'
  } catch (error) {
    // A deleted or inaccessible conversation is gone; anything else may succeed on the next retry.
    if (/not\s*found|gone|invalid/i.test(error instanceof Error ? error.message : String(error))) return 'gone'
    throw error
  }
}

export const iflistKind: SourceKind<IfListConfig> = {
  kind: SOURCE,
  title: { zh: 'IF.List 机器人', en: 'IF.List bot' },
  description: {
    zh: '拉取 IF.List 机器人收到的私聊与群内 @，回话也走这个机器人；机器人本身由服务器上的 IF.List 服务持有。',
    en: 'Pulls the direct messages and @mentions the IF.List bot received and replies through it; the server-side IF.List service owns the bot connection.',
  },
  schema: IfListConfigSchema,
  fields: [
    { key: 'pollSeconds', type: 'number', min: 1, max: 60, label: { zh: '拉取间隔 / 秒', en: 'Pull interval / seconds' },
      hint: { zh: '拉的是我们自己的服务，不吃飞书额度，所以可以短。', en: 'This pulls our own service, not Feishu, so it costs no platform quota.' } },
    { key: 'pageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页条数', en: 'Messages per pull' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
  ],
  health: ['iflist'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    return { listened: true, observed: false, row: 'group' }
  },
  channel: {
    send: sendIfList,
    // A reply may go to any conversation this Source still reads.
    allowed: (address, config) => (address.direct === 'true' ? config.directMessages : true),
    link: address => ({ url: '', label: { zh: `IF.List · ${address.chatId ?? ''}`, en: `IF.List · ${address.chatId ?? ''}` } }),
  },
  policy: {
    unnamed: { person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '机器人', en: 'Bot' } },
    schema: z.object({
      // open_id or union_id: the inbox carries both, and the list may name either.
      allowed: z.array(z.object({ id: z.string().regex(/^(ou|on)_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate ids').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的飞书用户', en: 'Feishu users who may originate work' },
        hint: { zh: '留空时，所有能私聊或 @ 到这个机器人的人都算明确请求——机器人本身的应用可用范围就是第一道门。',
          en: 'Left empty, anyone who can direct-message or @ the bot makes an explicit request; the app\'s availability scope is the outer door.' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'open_id / union_id', en: 'open_id / union_id' }, pattern: '(ou|on)_[a-zA-Z0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
    ],
    explicit: { zh: '私聊机器人，或在群里 @ 它，都算明确请求。', en: 'A direct message to the bot, or an @mention of it in a group, is an explicit request.' },
    rows: () => [
      { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '接收', en: 'Received' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'group', label: { zh: '群内 @', en: '@ in a chat' }, note: { zh: '仅 @', en: '@ only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    ],
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_IFLIST_CHAT', description: { zh: '私聊或 @ 机器人所在的会话', en: 'The conversation that messaged the bot' } },
      { key: 'DSH_SUPERAGENT_IFLIST_OWNER', description: { zh: '说话的人（union_id）；只有他能确认那张卡', en: 'The person who spoke (union_id); only they may confirm the card' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_IFLIST_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '',
      DSH_SUPERAGENT_IFLIST_OWNER: trigger?.source === SOURCE ? String(trigger.meta.unionId ?? trigger.actor.id ?? '') : '',
    }),
  },
  facts: () => ({}),
}

/** One pull: ask the IF.List service for what arrived after `after`. */
async function pull(commands: SourceContext['commands'], config: IfListConfig, after: number): Promise<{ items: InboxItem[]; next: number }> {
  const output = await commands.run(CLI, ['inbox', '--after', String(after), '--limit', String(config.pageSize)])
  return PageSchema.parse(JSON.parse(output))
}

/**
 * Polls the inbox and hands every new message to the Engine. The cursor is stored per Source, so a restart neither
 * replays old messages nor skips the ones that arrived while the service was down.
 */
export async function runIfList(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let after = ctx.state.get(KV.cursor) ?? 0
  let failures = 0
  const report = (health: Health) => ctx.report('iflist', health)

  while (!signal.aborted) {
    const config = ctx.config<IfListConfig>(SOURCE)
    if (config) {
      try {
        const page = await pull(ctx.commands.withSignal(signal), config, after)
        for (const item of page.items) {
          await ctx.receive(iflistTrigger(item))
          after = item.seq
        }
        if (page.items.length > 0) ctx.state.set(KV.cursor, after)
        failures = 0
        report({ state: 'ready', detail: `Cursor ${after}; ${page.items.length} new message(s)`, at: new Date().toISOString() })
      } catch (error) {
        failures += 1
        const detail = error instanceof Error ? error.message : String(error)
        report({ state: 'error', detail: `${failures} failed pull(s); last: ${detail}`.slice(0, 300) })
        await delay(Math.min(30_000, 2_000 * failures), undefined, { signal }).catch(() => undefined)
        continue
      }
      await delay(config.pollSeconds * 1_000, undefined, { signal }).catch(() => undefined)
    } else {
      await delay(2_000, undefined, { signal }).catch(() => undefined)
    }
  }
}

export const name = 'dsh-superagent-iflist'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(iflistKind), 'iflist: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runIfList(sourceContext(ctx.orchestrator, iflistKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
