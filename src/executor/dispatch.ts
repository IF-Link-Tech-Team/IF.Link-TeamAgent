/** Dispatches one Assignment to the worker runtime its ticket was routed to, while keeping the existing DSH path intact. */
import type { AssessmentOutcome, Assignment, Executor, Ticket } from '../core/index.ts'
import type { Store } from '../app/store/index.ts'
import type { Effects } from '../app/effects.ts'
import { chooseRoute, type DispatchRoute } from '../app/dispatch.ts'
import type { DshExecutor } from './dsh.ts'
import type { AcpExecutor } from './acp.ts'

/** What the dispatcher needs from the Runtime. */
export interface DispatchExecutorDeps {
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly dsh: DshExecutor
  readonly acp: AcpExecutor
  paused(): boolean
}

/**
 * The Engine's Executor port: chooses the runtime of each launch by the ticket's prepared route and delegates.
 *
 * DSH keeps its existing launch/delivery code; ACP runtimes get the same Assignment facts through `AcpExecutor`. The
 * dispatcher owns the `launch` and `delivery` effects so both paths share one queue, one set of worker slots and one
 * pause switch.
 */
export class DispatchExecutor implements Executor {
  constructor(private readonly host: DispatchExecutorDeps) {}

  /** Adds the chosen route to the ticket's execution, after the DSH naming and assignment text are prepared. */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const base = this.host.dsh.prepare(ticket, outcome)
    const trigger = this.host.store.triggers.get(ticket.origin.triggerId)
    const route = chooseRoute(this.host.store.settings(), { type: outcome.type, difficulty: outcome.difficulty, needs: outcome.needs,
      labels: outcome.rules, source: trigger?.source, chat: trigger?.channel?.thread, text: trigger?.text })
    return { ...base, execution: { ...base.execution!, type: route.type, difficulty: route.difficulty, family: route.family,
      runtime: route.harness, model: route.model, routeId: route.routeId } }
  }

  /** Registers the one pair of effect handlers both runtimes share, and starts the DSH event listeners. */
  install(): void {
    this.host.dsh.install()
    this.host.effects.handle('launch', payload => this.launchNow(payload), { limit: () => this.host.paused() ? 0 : this.host.dsh.workerSlots.launches(),
      retry: [5000, 300_000] })
    this.host.effects.handle('delivery', payload => this.deliverNow(payload.ticketId), { limit: () => this.host.paused() ? 0 : 4, quiet: true })
  }

  /** Queues a launch; the effect reads the route after commit, so a rollback cannot start a worker. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /** Queues delivery of the ticket's waiting Inputs. */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }

  /** Ends the Assignment on the runtime that owns it. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    const runtime = ticket.execution?.runtime
    if (runtime && runtime !== 'dsh') this.host.acp.stop(ticket)
    else this.host.dsh.stop(ticket, assignment, reason)
  }

  /** Runs a queued launch on the runtime recorded in the ticket's execution. */
  async launchNow(payload: { ticketId: string; assignmentId: string }): Promise<void> {
    const runtime = this.host.store.tickets.get(payload.ticketId)?.execution?.runtime
    if (!runtime || runtime === 'dsh') return this.host.dsh.launchNow(payload)
    return this.host.acp.launchNow(payload)
  }

  /** Runs a queued delivery on the runtime recorded in the ticket's execution. */
  async deliverNow(ticketId: string): Promise<void> {
    const runtime = this.host.store.tickets.get(ticketId)?.execution?.runtime
    if (!runtime || runtime === 'dsh') return this.host.dsh.deliverNow(ticketId)
    return this.host.acp.deliverNow(ticketId)
  }

  /** Reports interrupted Assignments and re-queues pending launches on both runtimes. */
  resume(): void {
    this.host.dsh.resume()
    this.host.acp.resume()
  }

  /** How many open tickets currently run an Assignment, across both runtimes. */
  activeCount(): number {
    return this.host.dsh.activeCount() + this.host.acp.activeCount()
  }

  /** Stops every runtime; a host shutdown waits for the DSH side, which owns the longer background work. */
  async shutdown(): Promise<void> {
    this.host.acp.shutdown()
    await this.host.dsh.shutdown()
  }

  /** Releases both runtimes' listeners. */
  dispose(): void {
    this.host.acp.shutdown()
    this.host.dsh.dispose()
  }
}

/** The route of a ticket for the panel, without starting anything. */
export function ticketRoute(ticket: Ticket): DispatchRoute | undefined {
  const execution = ticket.execution
  if (!execution?.runtime) return undefined
  return { type: execution.type ?? 'code', difficulty: execution.difficulty ?? 'M', family: execution.family ?? 'deepseek',
    model: execution.model ?? '', harness: execution.runtime, account: '', routeId: execution.routeId ?? execution.runtime,
    degraded: false, reason: execution.routeId ?? execution.runtime }
}
