/**
 * The Feishu topic sweep: which topics of a chat a round reads, and the page reader both the topic and chat sweeps
 * read a container's messages through.
 */
import { validItems, type Tally } from '../../infra/commands.ts'
import { KV } from '../../kv.ts'
import type { FeishuTiming } from '../feishu-config.ts'
import { HistoryPageSchema, HistoricalMessageSchema, admitsBackfill, feishuTime, feishuTrigger, historyEvent } from '../feishu-trigger.ts'
import type { SourceContext } from '../host.ts'
import { FEISHU_TIMING, activity, bot, receive, type FeishuCache } from './state.ts'

/** Which topics a sweep reads: every known one, only the recently active ones, or none (a chat-only pass). */
export type TopicMode = 'all' | 'hot' | 'none'
/**
 * What a sweep reads and shares with the rest of its round; both are optional so the exported functions stay usable alone.
 * `force` reads every topic whatever the recent window says, which is what a reconnect catch-up needs.
 */
export interface SweepOptions { topics?: TopicMode; cache?: FeishuCache; force?: boolean; timing?: FeishuTiming }

/** Reads this chat's topics without reading the chat itself: the cold sweep, and the reconnect catch-up's topic half. */
export async function sweepChatTopics(ctx: SourceContext, chatId: string, direct: boolean, since: string, until: string,
  signal: AbortSignal, tally: Tally = { skipped: 0 }, mode: TopicMode = 'all', cache?: FeishuCache, force = false,
  timing: FeishuTiming = FEISHU_TIMING): Promise<void> {
  const topics = { ...ctx.state.get(KV.feishu.topics(chatId)) }
  await scanTopics(ctx, chatId, direct, topics, since, until, signal, tally, mode, cache, force, timing)
  ctx.state.set(KV.feishu.topics(chatId), topics)
}
/**
 * Whether the topic pass still reads a topic: one that saw a message within `timing.topicRecent`, or one whose stored
 * time is unreadable. The decision reads the persisted `lastSeenAt`, not the in-memory activity markers, because a
 * restart empties those and would otherwise skip every topic exactly when the catch-up has the most to recover.
 */
const recentTopic = (seen: string | undefined, now: number, timing: FeishuTiming): boolean => {
  const at = Date.parse(seen ?? '')
  return !Number.isFinite(at) || now - at < timing.topicRecent
}
/**
 * Reads the chosen topics of one chat; a hot topic is one that received an event within `timing.topicHot`, while the
 * periodic pass reads the topics that saw a message within `timing.topicRecent` unless `force` asks for all of them.
 */
export async function scanTopics(ctx: SourceContext, chatId: string, direct: boolean, topics: Record<string, string>,
  since: string, until: string, signal: AbortSignal, tally: Tally, mode: TopicMode, cache?: FeishuCache, force = false,
  timing: FeishuTiming = FEISHU_TIMING): Promise<void> {
  const ids = Object.keys(topics)
  const now = Date.now()
  const chosen = mode === 'hot' ? ids.filter(id => now - (activity.topic.get(id) ?? 0) < timing.topicHot)
    : mode === 'none' ? [] : ids.filter(id => force || recentTopic(topics[id], now, timing))
  for (const id of chosen) {
    if (signal.aborted) return
    await scanContainer(ctx, chatId, direct, 'thread', id, since, until, signal, tally, topics, cache)
  }
}
/** Reads one chat's or topic's messages between `since` and `until`, page by page, and feeds the admitted ones into intake. */
export async function scanContainer(ctx: SourceContext, chatId: string, direct: boolean, kind: 'chat' | 'thread', id: string,
  since: string, until: string, signal: AbortSignal, tally: Tally, topics: Record<string, string>, cache?: FeishuCache): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  const lark = <T>(args: string[]): Promise<T> => cache ? cache.lark<T>(commands, args, undefined, 'sweep') : commands.lark<T>(args, undefined, 'sweep')
  let page: string | undefined
  const pages = new Set<string>()
  do {
    if (signal.aborted) throw signal.reason
    const seconds = (time: string) => String(Math.floor(Date.parse(time) / 1000))
    const parameters = { container_id_type: kind, container_id: id, start_time: seconds(since), end_time: seconds(until),
      sort_type: 'ByCreateTimeAsc', page_size: 50, ...(page ? { page_token: page } : {}) }
    const request = ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(parameters)]
    const result = HistoryPageSchema.parse(await lark(request))
    for (const message of validItems(HistoricalMessageSchema, result.items, tally)) {
      const outside = message.chat_id !== chatId || (kind === 'thread' && message.thread_id !== id)
      if (outside) throw new Error('Feishu history returned a message outside the requested chat or thread')
      if (message.deleted) continue
      const at = feishuTime(message.create_time)
      if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? '') >= Date.parse(at))) topics[message.thread_id] = at
      const trigger = feishuTrigger(historyEvent(message, chatId, direct), bot(ctx).botId, bot(ctx).appId)
      if (trigger && admitsBackfill(ctx, trigger)) await receive(ctx, trigger)
    }
    const stuck = result.has_more && (!result.page_token || pages.has(result.page_token))
    if (stuck) throw new Error('Feishu history pagination did not advance')
    page = result.has_more ? result.page_token : undefined
    if (page) pages.add(page)
  } while (page)
}
