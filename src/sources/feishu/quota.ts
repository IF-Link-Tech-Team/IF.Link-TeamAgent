/** The Feishu call record: what each round spent, counted per local day, and the health a run of failed rounds reports. */
import { KV } from '../../kv.ts'
import { health, type Health, type SourceContext } from '../host.ts'

/**
 * Adds one round's Feishu calls to today's record and logs the rounds that actually called. The in-memory counter dies
 * with the process, so the daily record is the only way to read quota use back afterwards; an idle round writes nothing
 * but its increment, which keeps both the store and the log sparse.
 *
 * `bySite` answers a question `byCommand` cannot: the same `api GET` is a cold sweep, a thread poll, or an agent reading
 * context, and only the site tells them apart. Records written before 2026-11-13 18:30 have no `bySite` key; that is
 * read as "not measured", not as zero.
 */
export function noteFeishuCalls(ctx: SourceContext, calls: number, byCommand: Record<string, number> = {},
  bySite: Record<string, number> = {}, at = new Date()): { today: number } {
  const key = KV.feishu.calls(callDay(at))
  const current = ctx.state.get(key) ?? { total: 0, rounds: 0, byCommand: {}, bySite: {} }
  const split = { ...current.byCommand }
  // Each round adds its own split, so the parts keep summing to the day's total instead of freezing on the largest
  // value one process happened to reach.
  for (const [name, count] of Object.entries(byCommand)) split[name] = (split[name] ?? 0) + count
  const sites = { ...(current.bySite ?? {}) }
  for (const [site, count] of Object.entries(bySite)) sites[site] = (sites[site] ?? 0) + count
  const next = { total: current.total + calls, rounds: current.rounds + 1, byCommand: split, bySite: sites }
  ctx.state.set(key, next)
  // 补扫要不要强制读全部话题，看的就是"上一轮跑到什么时候"。
  ctx.state.set(KV.feishu.lastRound, new Date(at).toISOString())
  console.log(`[feishu] round ${next.rounds}: ${calls} API call(s), ${next.total} today (${callDay(at)})`)
  return { today: next.total }
}
/** The local calendar day (`YYYY-MM-DD`) a call is counted under, so an operator reads it in their own time zone. */
export function callDay(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}
/**
 * Returns an error health once one chat has failed `rounds` (default 3) rounds in a row, or undefined so a single
 * flaky round (Feishu occasionally answers 2200 for one chat and recovers by itself) keeps `history` green.
 */
export function historyFailureHealth(failures: ReadonlyMap<string, number>, errors: readonly string[], rounds = 3): Health | undefined {
  const count = Math.max(0, ...failures.values())
  return count >= rounds
    ? health('error', 'pollFailures', { count: String(count), error: errors.join(' / ') })
    : undefined
}
