/** Feishu history recovery: the two-tier chat sweep, the catch-up read of what the event stream missed, and the cursors they advance. */
import { setTimeout as delay } from 'node:timers/promises'
import { takeLarkCalls, type Tally } from '../../infra/commands.ts'
import { KV } from '../../kv.ts'
import { feishuTiming, type FeishuConfig, type FeishuTiming } from '../feishu-config.ts'
import { SOURCE } from '../feishu-trigger.ts'
import { health, type SourceContext } from '../host.ts'
import { POLL_HORIZON_MS, cursorAt, polled } from '../poll.ts'
import { historyFailureHealth, noteFeishuCalls } from './quota.ts'
import { FEISHU_TIMING, available, enabled, fastChats, feishuCache, pruneActivity, takeCatchUpRequest, type FeishuCache } from './state.ts'
import { pollThreads } from './threads.ts'
import { scanContainer, scanTopics, sweepChatTopics, type SweepOptions, type TopicMode } from './topics.ts'

/**
 * How often the loop wakes up. A round now costs a call or two: the hourly and two-hourly sweeps, not the rounds,
 * are what read Feishu, so the cadence is cheap and a chat that just received an event is swept within a minute.
 */
const ROUND_MS = 60_000

/** The chats this Source reads: the configured ones plus the direct chats it has already seen, while they are received. */
function sweepableChats(ctx: SourceContext, config: FeishuConfig): Record<string, boolean> {
  const seen = ctx.state.get(KV.feishu.chats) ?? {}
  const known = Object.entries(seen).filter(([, direct]) => direct && config.directMessages)
  return { ...Object.fromEntries(config.chats.map(chat => [chat.chatId, false])), ...Object.fromEntries(known) }
}
/**
 * Sweeps history in two tiers instead of reading every chat on every round: a chat is swept once shortly after it
 * receives an event, and every chat is swept hourly as a floor. Everything the event stream delivered is deduplicated
 * by its deterministic Trigger id, so an overlap costs a call but never a duplicate.
 */
export async function backfillLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) { ctx.report('history', health('paused', 'feishuBotMissing')); return }
  // Consecutive failures per chat. Feishu occasionally answers 2200 for a single chat and recovers on its own;
  // one flaky round must not turn the whole component red, so only a chat failing `historyFailureRounds` rounds
  // in a row is reported. Counters live in memory: a restart is a fresh start, and no stale count survives a night.
  const failures = new Map<string, number>()
  let lastChatSweep = 0
  let lastTopicSweep = 0
  let swept = new Map<string, number>()
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('history', health('paused', 'sourceOff'))
      await delay(ROUND_MS, undefined, { signal }).catch(() => {})
      continue
    }
    // Cadences are read from this round's configuration, so saving a new value in the panel applies on the next round.
    const timing = feishuTiming(config)
    const now = Date.now()
    const catchUp = takeCatchUpRequest()
    // 会话历史只带得出话题的根消息，线程里的回复只有读话题才看得到，所以一次真正的补扫要把每个已知话题都翻一遍。
    // 但重启只停了几十秒时，这一页页翻下去几乎换不回任何消息：按停机时长决定要不要强制，短了就回到常规的活跃过滤。
    const gap = catchUp ? catchUpGap(ctx, now) : 0
    const force = catchUp && gap >= timing.catchUpForce
    if (catchUp) console.log(`[feishu] catch-up after ${Number.isFinite(gap) ? `${Math.round(gap / 1000)}s` : 'an unrecorded gap'}: ${force ? 'every topic' : 'recent topics only'}`)
    const chats = sweepableChats(ctx, config)
    const chatSweep = catchUp || now - lastChatSweep >= timing.chatSweep
    const topicSweep = catchUp || now - lastTopicSweep >= timing.topicSweep
    const cache = feishuCache()
    const errors: string[] = []
    const tally = { skipped: 0 }
    // The full sweep reads every topic anyway, so its chat pass leaves topics alone and the round stays cheap.
    const mode: TopicMode = topicSweep ? 'none' : 'hot'
    const targets = chatSweep ? Object.entries(chats) : fastChats(chats, now, swept)
    for (const [chatId, direct] of targets) {
      if (signal.aborted) break
      await sweepChat(ctx, chatId, direct, signal, tally, failures, errors, mode, cache, force, timing)
      swept.set(chatId, now)
    }
    if (chatSweep) { lastChatSweep = now; swept = new Map() }
    else pruneActivity(now, timing)
    if (topicSweep) {
      lastTopicSweep = now
      const window = { since: new Date(now - timing.topicSweep).toISOString(), until: new Date(now).toISOString() }
      for (const [chatId, direct] of Object.entries(chats)) {
        if (signal.aborted) break
        try { await sweepChatTopics(ctx, chatId, direct, window.since, window.until, signal, tally, 'all', cache, force, timing) }
        catch (error) { if (!signal.aborted) errors.push(`${chatId} topics: ${String(error)}`) }
      }
    }
    await pollThreads(ctx, signal, tally, cache, timing)
    for (const chatId of failures.keys()) if (!(chatId in chats)) failures.delete(chatId)
    const skipped = tally.skipped ? `; ${tally.skipped} unreadable messages skipped` : ''
    const retrying = errors.length ? `; ${errors.length} chat(s) failed this round, retrying` : ''
    // The round takes what it spent: a process counter kept apart from the day's record drifted on every restart.
    const { total: calls, byCommand, bySite } = takeLarkCalls()
    // Every round is accounted, not only a sweep round: the daily record is what quota decisions are read from later.
    const { today } = signal.aborted ? { today: 0 } : noteFeishuCalls(ctx, calls, byCommand, bySite)
    const read = calls ? `; ${calls} API calls this round, ${today} today` : `; ${today} API calls today`
    if (!signal.aborted) ctx.report('history', historyFailureHealth(failures, errors, config.historyFailureRounds) ?? {
      state: 'ready', detail: `Configured groups and known direct chats recovered${skipped}${retrying}${read}`, at: new Date().toISOString() })
    await delay(ROUND_MS, undefined, { signal }).catch(() => {})
  }
}

/**
 * How long the process was down (or, mid-run, how long since the last completed round), read from the persisted
 * timestamp the previous round left. An unreadable or missing value reads as "a long time", so a first start after an
 * upgrade still sweeps everything once.
 */
export function catchUpGap(ctx: SourceContext, now = Date.now()): number {
  const last = Date.parse(ctx.state.get(KV.feishu.lastRound) ?? '')
  return Number.isFinite(last) ? Math.max(0, now - last) : Number.POSITIVE_INFINITY
}

/** Sweeps one chat between its cursor and now, advancing the cursor only on success so a failed chat is retried. */
async function sweepChat(ctx: SourceContext, chatId: string, direct: boolean, signal: AbortSignal, tally: Tally,
  failures: Map<string, number>, errors: string[], topics: TopicMode, cache?: FeishuCache, force = false,
  timing: FeishuTiming = FEISHU_TIMING): Promise<void> {
  const started = new Date().toISOString()
  const cursorKey = KV.feishu.history(chatId)
  const since = ctx.state.get(cursorKey)
  if (since === undefined) { ctx.state.set(cursorKey, started); return }
  try {
    await backfillChat(ctx, chatId, direct, since, started, signal, tally, { topics, cache, force, timing })
    if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started))
    failures.delete(chatId)
  } catch (error) {
    if (signal.aborted) return
    failures.set(chatId, (failures.get(chatId) ?? 0) + 1)
    errors.push(`${chatId}: ${String(error)}`)
  }
}

/**
 * Backfills chat messages and active topic replies between `since` and `until` before the caller advances the chat cursor.
 * Topics are stored as `{ id: lastSeenAt }`, and unsubscribed topics older than the polling horizon are pruned.
 */
export async function backfillChat(ctx: SourceContext, chatId: string, direct: boolean, since: string, until: string,
  signal: AbortSignal, tally: Tally = { skipped: 0 }, options: SweepOptions = {}): Promise<void> {
  const topics = { ...ctx.state.get(KV.feishu.topics(chatId)) }
  await scanContainer(ctx, chatId, direct, 'chat', chatId, since, until, signal, tally, topics, options.cache)
  // A quiet topic is forgotten unless a subscribed Thread that is still polled follows it.
  const followed = new Set(ctx.threads.subscribed(SOURCE).filter(thread => polled(ctx, thread))
    .map(thread => String(thread.meta.threadId ?? ctx.triggers.latest(thread.key)?.meta.threadId ?? '')))
  for (const [id, seen] of Object.entries(topics)) {
    if (!followed.has(id) && Date.parse(until) - Date.parse(seen) >= POLL_HORIZON_MS) delete topics[id]
  }
  ctx.state.set(KV.feishu.topics(chatId), topics)
  const mode = options.topics ?? 'all'
  if (mode !== 'none') await scanTopics(ctx, chatId, direct, topics, since, until, signal, tally, mode, options.cache, options.force,
    options.timing ?? FEISHU_TIMING)
}
