/**
 * The Feishu Source's configuration schema and the cadences its background loops use.
 *
 * Kept apart from the Source kind so `feishu-loops.ts` can read a cadence without importing the plugin entry, which
 * would be a cycle (the plugin imports the loops).
 */
import { z } from 'zod'
import { FeishuBotSchema } from '../deployment.ts'

/**
 * A cadence in minutes read from the environment only as a default for a new configuration. The panel stores the value
 * from then on, so an operator changing a sweep does not have to edit a systemd unit; an existing unit's value still
 * seeds the first read, which keeps an upgrade from silently spending more quota than before.
 */
const envMinutes = (name: string, fallback: number): number => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}
export const FeishuConfigSchema = FeishuBotSchema.extend({
  readPageSize: z.number().int().min(1).max(50).default(50),
  linkTimeoutMs: z.number().int().min(1).max(90000).default(5000),
  /** How often every chat is swept for messages the live stream lost. */
  chatSweepMinutes: z.number().int().min(1).max(10080).default(envMinutes('DSH_FEISHU_CHAT_SWEEP_MINUTES', 60)),
  /** A topic that received an event recently is swept on every round; one that saw a message within `topicRecent` takes part in the topic pass. */
  topicHotMinutes: z.number().int().min(1).max(10080).default(envMinutes('DSH_FEISHU_TOPIC_HOT_MINUTES', 30)),
  topicRecentMinutes: z.number().int().min(1).max(10080).default(envMinutes('DSH_FEISHU_TOPIC_RECENT_MINUTES', 720)),
  /** Every topic is swept this often, hot or not. */
  topicSweepMinutes: z.number().int().min(1).max(10080).default(envMinutes('DSH_FEISHU_TOPIC_SWEEP_MINUTES', 120)),
  /** How long the process must have been down before a catch-up forces every topic. */
  catchUpForceMinutes: z.number().int().min(1).max(10080).default(envMinutes('DSH_FEISHU_CATCH_UP_FORCE_MINUTES', 30)),
  /** A subscribed thread is polled at most this often, and only while it is followed or saw activity within `threadRecent`. */
  threadPollMinutes: z.number().int().min(1).max(10080).default(envMinutes('DSH_FEISHU_THREAD_POLL_MINUTES', 10)),
  threadRecentMinutes: z.number().int().min(1).max(10080).default(envMinutes('DSH_FEISHU_THREAD_RECENT_MINUTES', 60)),
  /** The joined-chat list is a display aid, not a message path. */
  chatNamesMinutes: z.number().int().min(1).max(10080).default(envMinutes('DSH_FEISHU_CHAT_NAMES_MINUTES', 60)),
  /** Rounds one chat must fail in a row before the history health turns red. */
  historyFailureRounds: z.number().int().min(1).max(10).default(3),
  chats: z.array(z.object({ chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>
/** The cadences the background loops compare against, in milliseconds; read from the saved Source configuration. */
export interface FeishuTiming {
  chatSweep: number; topicHot: number; topicRecent: number; topicSweep: number; catchUpForce: number; threadPoll: number
  threadRecent: number; chatNames: number
}
/** Turn a saved configuration's minute cadences into the milliseconds the loops use; an absent field takes its default. */
export const feishuTiming = (config?: Partial<FeishuConfig>): FeishuTiming => {
  const value = FeishuConfigSchema.parse(config ?? {})
  const minutes = (count: number): number => count * 60_000
  return { chatSweep: minutes(value.chatSweepMinutes), topicHot: minutes(value.topicHotMinutes),
    topicRecent: minutes(value.topicRecentMinutes), topicSweep: minutes(value.topicSweepMinutes),
    catchUpForce: minutes(value.catchUpForceMinutes), threadPoll: minutes(value.threadPollMinutes),
    threadRecent: minutes(value.threadRecentMinutes), chatNames: minutes(value.chatNamesMinutes) }
}
