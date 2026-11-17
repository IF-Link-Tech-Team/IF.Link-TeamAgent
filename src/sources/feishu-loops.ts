/**
 * The Feishu loops' entry and barrel: `runFeishu` starts the live event consumer, the history sweep and the chat-name
 * refresh, and everything below is re-exported so the plugin and the tests keep one import path.
 */
import { feishuTiming } from './feishu-config.ts'
import { watch } from './feishu/events.ts'
import { backfillLoop } from './feishu/history.ts'
import { chatNamesLoop } from './feishu/names.ts'
import { enabled } from './feishu/state.ts'
import type { SourceContext } from './host.ts'

export const runFeishu = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> => {
  // Log the cadences this process starts with. Every round re-reads the saved configuration, so this line is the
  // starting point rather than a promise; without it a surprising round size is only visible after the fact.
  const timing = feishuTiming(enabled(ctx))
  const minutes = (value: number): string => `${Math.round(value / 60_000)}m`
  console.log(`[feishu] cadence: chat ${minutes(timing.chatSweep)}, topic ${minutes(timing.topicSweep)}, `
    + `thread ${minutes(timing.threadPoll)}, hot ${minutes(timing.topicHot)}, catch-up force ${minutes(timing.catchUpForce)}`)
  return Promise.allSettled([watch, backfillLoop, chatNamesLoop].map(loop => loop(ctx, signal)))
}

export * from './feishu/state.ts'
export * from './feishu/quota.ts'
export * from './feishu/topics.ts'
export * from './feishu/history.ts'
export * from './feishu/events.ts'
export * from './feishu/names.ts'
export * from './feishu/threads.ts'
