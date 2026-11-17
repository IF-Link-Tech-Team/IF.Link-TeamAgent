/** The joined-chat names the panel shows: read from the bot's chat list on the configured cadence. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { KV } from '../../kv.ts'
import { feishuTiming } from '../feishu-config.ts'
import { SOURCE } from '../feishu-trigger.ts'
import type { SourceContext } from '../host.ts'
import { available, enabled } from './state.ts'

/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
export async function refreshChatNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const commands = ctx.commands.withSignal(signal)
  const result = z.looseObject({ chats: z.array(z.looseObject({ chat_id: z.string(), name: z.string().nullish() })).optional() })
    .parse(await commands.lark(['im', '+chat-list', '--page-all', '--page-size', '100'], undefined, 'chats'))
  const names = Object.fromEntries((result.chats ?? []).filter(chat => chat.name).map(chat => [chat.chat_id, chat.name!]))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Rereads the chat list on its configured cadence: its names label chats in the panel, and a new chat shows up within it. */
export async function chatNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (config) {
      try { await refreshChatNames(ctx, signal) }
      catch { /* Names are a display aid; the stored list stays until a later read succeeds. */ }
    }
    await delay(feishuTiming(config).chatNames, undefined, { signal }).catch(() => {})
  }
}
