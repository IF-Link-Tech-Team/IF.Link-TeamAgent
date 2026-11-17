/** Subscribed Feishu thread polling: which threads are due this round, and the replies the live stream may have missed. */
import { isOpen, type Thread } from '../../core/index.ts'
import { atSite, type Commands, type Tally } from '../../infra/commands.ts'
import { KV } from '../../kv.ts'
import type { FeishuTiming } from '../feishu-config.ts'
import { readFeishu, type FeishuRef } from '../feishu-read.ts'
import { SOURCE, feishuRef, feishuTrigger, topicEvent } from '../feishu-trigger.ts'
import type { SourceContext } from '../host.ts'
import { pollThreads as pollEach } from '../poll.ts'
import { FEISHU_TIMING, activity, bot, enabled, receive, type FeishuCache } from './state.ts'

/** Resolves the retained source message reference for polling a subscribed thread. */
export function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined {
  const meta = thread.meta as { sourceTriggerId?: string; chatId?: string; messageId?: string }
  if (meta.chatId && meta.messageId && meta.sourceTriggerId) {
    return { triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId }
  }
  const trigger = ctx.triggers.latest(thread.key)
  return trigger ? feishuRef(trigger) : undefined
}
/**
 * Whether a subscribed thread is worth reading this round: a thread a live ticket follows is read at most every
 * `timing.threadPoll`, and one nothing follows is only read while it saw activity within `timing.threadRecent`. A thread
 * that is quiet and ticketless keeps its subscription but is left to the reconnect catch-up.
 */
export function threadDue(ctx: SourceContext, thread: Thread, now = Date.now(), timing: FeishuTiming = FEISHU_TIMING): boolean {
  if (now - (activity.thread.get(thread.key) ?? 0) < timing.threadPoll) return false
  const followed = thread.subscriptions.some(id => {
    const ticket = ctx.tickets.get(id)
    return !!ticket && isOpen(ticket)
  })
  if (followed) return true
  return now - Date.parse(thread.lastAt ?? thread.createdAt) < timing.threadRecent
}
/** Polls subscribed Feishu threads that are due, so replies missed by the live stream become triggers for their tickets. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally?: Tally, cache?: FeishuCache,
  timing: FeishuTiming = FEISHU_TIMING): Promise<void> {
  const now = Date.now()
  await pollEach(ctx, SOURCE, () => !!signal?.aborted, thread => pollThread(ctx, thread, signal, tally, cache),
    thread => !threadDue(ctx, thread, now, timing))
}
async function pollThread(ctx: SourceContext, thread: Thread, signal?: AbortSignal, tally?: Tally, cache?: FeishuCache): Promise<void> {
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('Subscribed thread has no retained source message')
  const config = enabled(ctx)
  // The Source was turned off; the next round polls again.
  if (!config) return
  activity.thread.set(thread.key, Date.now())
  const commands = ctx.commands.withSignal(signal)
  // A thread's first page usually repeats a page the topic sweep of the same round already read; share that read.
  const reader: Pick<Commands, 'lark'> = cache ? { lark: (args, cwd) => cache.lark(commands, args, cwd, 'thread') } : atSite(commands, 'thread')
  const pageSize = config.readPageSize
  const checkpoint = KV.feishu.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.feishu.initialized(thread.key))
  if (!initialized) {
    // Mark root and parent messages as seen on first poll so historical context is not ingested as new triggers.
    for (const section of ['root', 'parent']) {
      const result = await readFeishu(reader, ref, `feishu/${ref.triggerId}/${section}`, pageSize)
      if ('message' in result && result.message) known.add(result.message.message_id)
    }
    ctx.state.set(checkpoint, [...known])
  }
  const direct = ctx.state.get(KV.feishu.chats)?.[ref.chatId] === true
  const since = Date.parse(thread.createdAt)
  const root = thread.ref.id.slice(thread.ref.id.indexOf(':') + 1)
  let resource: string | null = `feishu/${ref.triggerId}/thread`
  while (resource) {
    if (signal?.aborted) return
    const result = await readFeishu(reader, ref, resource, pageSize, 'desc')
    if (!('messages' in result)) throw new Error('Expected Feishu thread messages')
    if (tally && 'skipped' in result) tally.skipped += result.skipped ?? 0
    if ('thread_id' in result && result.thread_id && thread.meta.threadId !== result.thread_id) {
      ctx.threads.patch(thread.key, { threadId: result.thread_id })
    }
    const encounteredKnown = result.messages.some(message => known.has(message.message_id))
    const { botId, appId } = bot(ctx)
    for (const message of result.messages.filter(item => !known.has(item.message_id) && !item.deleted).reverse()) {
      if (signal?.aborted) return
      const trigger = feishuTrigger(topicEvent(message, ref.chatId, direct, root), botId, appId)
      // Ignore messages older than the thread subscription on initial poll.
      if (!trigger || (!initialized && Date.parse(trigger.at) < since)) continue
      await receive(ctx, trigger)
    }
    result.messages.forEach(message => known.add(message.message_id))
    ctx.state.set(checkpoint, [...known])
    if (initialized && encounteredKnown) break
    resource = result.next_resource
  }
  ctx.state.set(KV.feishu.initialized(thread.key), true)
}
