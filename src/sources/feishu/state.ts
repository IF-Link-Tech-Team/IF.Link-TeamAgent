/**
 * The Feishu loops' shared process state and constants: the cadences, the in-memory activity markers, the catch-up
 * request, and the per-round read cache, together with the few context helpers every loop reads.
 */
import { threadKey, type Trigger } from '../../core/index.ts'
import type { FeishuBot } from '../../deployment.ts'
import type { Commands, LarkSite } from '../../infra/commands.ts'
import { KV } from '../../kv.ts'
import { feishuChatLink } from '../feishu-channel.ts'
import { feishuTiming, type FeishuConfig, type FeishuTiming } from '../feishu-config.ts'
import { SOURCE } from '../feishu-trigger.ts'
import { health, type SourceContext } from '../host.ts'

/**
 * The default cadences of the background sweeps, from the Source schema's defaults (which an environment variable may
 * seed). Each round builds the effective ones from the saved configuration instead, so a change in the panel applies
 * without a restart; this constant stays for callers that have no configuration at hand.
 */
export const FEISHU_TIMING: FeishuTiming = feishuTiming()

/**
 * Markers of recent live events, kept in memory: a restart starts cold on purpose, because the first round (and every
 * reconnect) sweeps everything the markers would otherwise have spared.
 */
export const activity = { chat: new Map<string, number>(), topic: new Map<string, number>(), thread: new Map<string, number>() }
/** Set by the first round and by every event-stream restart: the missed window has to be read, not simply skipped. */
let catchUpRequested = true

/** Forgets the in-memory markers and asks for a full sweep; tests and a restored deployment both use it. */
export function resetFeishuLoops(): void {
  activity.chat.clear(); activity.topic.clear(); activity.thread.clear(); catchUpRequested = true
}
/** Asks the next round to read every chat, topic, and thread: what the event stream may have missed while it was down. */
export function requestFeishuCatchUp(): void { catchUpRequested = true }
/**
 * Reads the catch-up request, clearing it: the history round consumes the flag, and because an importing module cannot
 * assign an imported binding, the flag stays behind this one accessor.
 */
export function takeCatchUpRequest(): boolean {
  const requested = catchUpRequested
  catchUpRequested = false
  return requested
}
/**
 * Records a live event so the sweeps revisit its chat and topic within a minute. Only the event path calls this: a
 * message read by a sweep must not mark its own topic hot, or every sweep would keep every topic hot.
 */
export function noteFeishuEvent(trigger: Trigger, at = Date.now()): void {
  const chatId = String(trigger.meta.chatId ?? '')
  if (chatId) activity.chat.set(chatId, at)
  const threadId = String(trigger.meta.threadId ?? '')
  if (threadId) activity.topic.set(threadId, at)
}

/** One round's memo of Feishu reads, so the chat, topic, and thread sweeps never read the same page twice in a round. */
export interface FeishuCache {
  /** `site` only labels the call that actually goes out; a hit was already paid for and is not counted again. */
  lark<T>(commands: Pick<Commands, 'lark'>, args: string[], cwd?: string, site?: LarkSite): Promise<T>
  readonly size: number
}
export function feishuCache(): FeishuCache {
  const memo = new Map<string, Promise<unknown>>()
  return {
    lark<T>(commands: Pick<Commands, 'lark'>, args: string[], cwd?: string, site: LarkSite = 'other'): Promise<T> {
      const key = [cwd ?? '', ...args].join('\u0000')
      let pending = memo.get(key) as Promise<T> | undefined
      if (pending) return pending
      pending = commands.lark<T>(args, cwd, site)
      memo.set(key, pending)
      // A failed read must not be memoized, or one flaky call would answer for the rest of the round.
      void pending.catch(() => memo.delete(key))
      return pending
    },
    get size(): number { return memo.size },
  }
}

/** The saved Feishu configuration while the Source is enabled, or undefined while it is off or uninstalled. */
export const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>(SOURCE)
/** The deployment's working bot CLI; a Source without one never reaches a read path. */
export const bot = (ctx: SourceContext): FeishuBot => {
  const resolved = ctx.deployment.feishu
  if (!resolved) throw new Error('The Feishu Source has no working bot CLI')
  return resolved
}
/**
 * A message that @s another bot the Policy lists is that bot's job, not ours: it already reached the other agent through
 * the other app. Dropping it here keeps one human request from becoming two Tickets.
 */
export function addressedToAnotherBot(trigger: Trigger, self: readonly string[], listed: readonly { id: string }[]): boolean {
  const mentioned = trigger.meta.mentions
  if (!Array.isArray(mentioned) || mentioned.length === 0) return false
  const ids = mentioned.filter((id): id is string => typeof id === 'string')
  // Addressed to us, even if another bot is named too: answering our own mention matters more than avoiding a duplicate.
  if (ids.some(id => self.includes(id))) return false
  const others = new Set(listed.map(bot => bot.id))
  return ids.some(id => others.has(id))
}

/** Feeds one Trigger into intake and labels each of its Threads with the chat's name and link. */
export async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  const self = [ctx.deployment.feishu?.botId, ctx.deployment.feishu?.appId].filter((id): id is string => !!id)
  if (addressedToAnotherBot(trigger, self, ctx.policyBots())) return
  await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url: chatLink(ctx, chatId), facts: { chat } })
}
/** The chat's AppLink, stored on a Thread so the panel can open it. */
export const chatLink = (ctx: SourceContext, chatId: string): string => feishuChatLink(ctx.deployment.feishu?.brand ?? 'feishu', chatId)
/** Reports why the loops cannot run and returns false until setup has resolved the bot. */
export function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.feishu) return true
  const waiting = health('paused', ctx.configured() ? 'feishuCliUnset' : 'setupPending')
  ctx.report('feishu', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Forgets markers older than the longest window they still influence, so a long-running process does not accumulate them. */
export function pruneActivity(now: number, timing: FeishuTiming): void {
  const stale = now - Math.max(timing.topicSweep, timing.threadRecent)
  for (const markers of [activity.chat, activity.topic, activity.thread]) {
    for (const [key, at] of markers) if (at < stale) markers.delete(key)
  }
}
/** A chat that received an event is swept once, this long afterwards, so an event the stream lost still lands quickly. */
const FAST_SWEEP_DELAY_MS = 30_000
/** The chats that received an event long enough ago to be swept, and have not been swept since that event. */
export function fastChats(chats: Record<string, boolean>, now: number, swept: Map<string, number>): [string, boolean][] {
  return Object.entries(chats).flatMap(([chatId, direct]) => {
    const at = activity.chat.get(chatId)
    if (at === undefined || now - at < FAST_SWEEP_DELAY_MS || (swept.get(chatId) ?? 0) >= at) return []
    return [[chatId, direct] as [string, boolean]]
  })
}
