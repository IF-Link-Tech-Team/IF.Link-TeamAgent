/**
 * The operations a person or the main Session asks for, written once: the main Session's tools and the management API
 * both call these, so a rule — such as which follow-up may be requeued — cannot hold on one surface and not the other.
 *
 * A tool call suppresses the notices its own command would raise; a panel action does not, because a person did it.
 * The Engine still emits the event either way; only the main Session's notification of it is held back.
 */
import { UserError, followupOwners, type EngineForPeople, type EngineForMainSession, type Ticket } from '../core/index.ts'
import type { Store } from './store/index.ts'

/** Who asked: the main Session through a tool, or a person through the panel. */
export type ActionOrigin = 'tool' | 'panel'

export interface ActionDeps {
  /** People's commands, which the Engine records as a person's: stop, retry, requeue, unsubscribe. */
  engine: Pick<EngineForPeople, 'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe'>
  /** The main Session's own commands: attach, note, ask for a status report. */
  main: Pick<EngineForMainSession, 'attach' | 'note' | 'requestStatus'>
  store: Pick<Store, 'triggers' | 'threads' | 'tickets'>
  /** Runs an Engine command without telling the main Session about the event it caused. */
  quietly<T>(run: () => T): T
  /** Schedules a pass to carry out work the command queued. */
  requestPass(): void
}

/** The operations of one surface: the main Session's tools (`tool`) or the management API (`panel`). */
export class Actions {
  constructor(private readonly deps: ActionDeps) {}

  /** Ends a stalled Assignment and starts a new one under the same Mandate. */
  retry(ticketId: string, _origin: ActionOrigin): Ticket { return this.deps.engine.retryTicket(ticketId) }

  /** Stops a ticket by a person, which withdraws its Mandate. */
  stop(ticketId: string, _origin: ActionOrigin): Ticket { return this.deps.engine.stopTicket(ticketId) }

  /** Sends a fact to a ticket's worker as context, granting nothing. */
  note(ticketId: string, text: string, _origin: ActionOrigin): Ticket { return this.deps.main.note(ticketId, text) }

  /** Asks an idle worker for a status report; false when the worker is not waiting, in which case nothing was sent. */
  requestStatus(ticketId: string, _origin: ActionOrigin): boolean { return this.deps.main.requestStatus(ticketId) }

  /** Attaches a Trigger to an existing ticket, which then receives it as context. */
  attach(ticketId: string, triggerId: string, note: string | undefined, origin: ActionOrigin): Ticket {
    return this.run(origin, () => this.deps.main.attach(ticketId, triggerId, note))
  }

  /**
   * Queues a Trigger for a fresh Eval.
   * A person's follow-up that reached a ticket is that ticket's worker's to judge, so the main Session may not take it
   * back. A person still may, from the panel: they outrank the worker that owns it.
   */
  requeue(triggerId: string, origin: ActionOrigin): boolean {
    const trigger = origin === 'tool' ? this.deps.store.triggers.get(triggerId) : undefined
    const owners = trigger ? followupOwners(trigger, this.deps.store) : []
    if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
    const queued = this.run(origin, () => this.deps.engine.reevaluate(triggerId))
    this.deps.requestPass()
    return queued
  }

  /** Drops every ticket's subscription to a thread. */
  unsubscribe(thread: string, origin: ActionOrigin): boolean { return this.run(origin, () => this.deps.engine.unsubscribe(thread)) }

  private run<T>(origin: ActionOrigin, work: () => T): T { return origin === 'tool' ? this.deps.quietly(work) : work() }
}
