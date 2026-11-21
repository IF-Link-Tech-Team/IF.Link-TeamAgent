/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { type Clock, systemClock } from './clock.ts'
import { Engine, key, reasonText, type DomainEvent, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy/index.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup-errors.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { AcpExecutor } from '../executor/acp.ts'
import { DispatchExecutor } from '../executor/dispatch.ts'
import { WorkerMcpServer } from './mcp-server.ts'
import { ticketCard } from './cards.ts'
import { Actions } from './actions.ts'
import { MainAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store/index.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkDeps } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { ReactionPicker, type ReactionChooser } from './reaction-picker.ts'
import { Gestures } from './gestures.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import type { HealthEntry } from '../infra/health.ts'
import { Sessions } from './sessions.ts'
import { ModelRouter } from './model-router.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceDeps } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MainAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly router: ModelRouter
  readonly executor: DispatchExecutor
  readonly mcp: WorkerMcpServer
  readonly assessor: MainAssessor
  readonly actions: Actions
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly mainSessionId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void, private readonly clock: Clock = systemClock) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      // Journal entries live on disk, so index them once at startup; searches then only notice files that changed since.
      store.indexJournal(machine.memoryDir)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const mainSessionId = this.mainSessionId = store.get(KV.runtime.mainSessionId) ?? store.get(KV.legacy.mainSessionId)
        ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.mainSessionId, mainSessionId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkDeps = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceDeps = { store, pages: new TextCache(4_000_000), prompts, commands, mainSessionId, context: ctx,
        memoryDir: machine.memoryDir,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), mainSessionId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        routeFor: role => this.router.preferred(role === 'orchestrator' ? 'main' : 'worker'),
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      const mcp = this.mcp = new WorkerMcpServer({ stateDir: machine.stateDir, lifetime: this.lifetime,
        tools: id => {
          const ticket = store.tickets.get(id)
          return ticket ? executorTools(this.toolHost, ticket) : []
        } })
      const dsh = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, mainSessionId, get router() { return runtime.router }, registerEffects: false,
        closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      const acp = new AcpExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, machine, lifetime: this.lifetime,
        slots: dsh.workerSlots, prompts, mcp, health: board.claim('worker:acp', { state: 'paused', detail: 'No external runtime launched yet' }),
        environment, closing: () => this.closing(), paused: () => this.paused(), relay: (id, text) => sessions.relay(id, text) })
      this.executor = new DispatchExecutor({ store, effects, dsh, acp, paused: () => this.paused() })
      this.assessor = new MainAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(mainSessionId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const marks = this.reactionChooser(store, board.claim('marks', { state: 'ready', detail: 'No mark picked yet' }))
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, marks, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources, { degraded: this.router.degraded() })
      // Kept in memory: a Source reads it to decide whether a model call is worth it, and a restart may refresh it.
      const activity: { lastEventAt?: number; lastHumanAt?: number; humanTriggers: number } = { humanTriggers: 0 }
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, now: () => new Date(this.clock.now()).toISOString(),
        gestures: new Gestures(store, Date.now, () => store.settings().policy.gestures),
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
        emit: event => this.announce(event, { store, sources, sessions, outbox, activity,
          configured: () => setup.configured(), repository: () => setup.deployment.repository }) })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      // After the engine: routing only needs the settings, the health board, the main Session id, and the DSH LLM service.
      this.router = new ModelRouter({ context: ctx, store, mainSessionId, health: board.claim('model-fallback') })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger),
        activity: () => activity,
        // A Source gets one bounded completion, not an Agent: extraction must not grow into a Worker.
        complete: async (prompt, maxTokens = 700) => {
          const model = store.settings().eval.model ?? runtime.router.preferred('main')
          if (!model) throw new Error('No model configured for Source intake')
          let text = ''
          const stream = ctx.llm.stream({ provider: model.provider, model: model.model, maxTokens,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] })
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta') text += chunk.text
            else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
              throw new Error(`Source intake model failed: ${chunk.reason.failure.code}`)
            }
          }
          return text
        } }
      this.actions = new Actions({ engine, main: engine, store, requestPass: () => { this.passes.request() },
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } })
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources, actions: this.actions,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
      }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  /**
   * The emoji picker the Outbox calls. Its account and model come from the Marks settings on every pick, falling back to
   * the environment; without either it stays quiet and a Channel draws its own mark.
   */
  private reactionChooser(store: Store, health: HealthEntry): ReactionChooser {
    const account = () => {
      const config = store.settings().marks
      return { config, account: config.account || process.env.CLOUDFLARE_ACCOUNT_ID || '',
        token: config.token || process.env.CLOUDFLARE_WORKERS_AI_API_KEY || process.env.CLOUDFLARE_API_KEY || '' }
    }
    const chooser: ReactionChooser = { pick: async message => {
      const { config, account: accountId, token } = account()
      if (!config.enabled) {
        health.set({ state: 'paused', detail: 'Mark picking is off', at: new Date().toISOString() })
        return undefined
      }
      if (!accountId || !token) {
        health.set({ state: 'paused', detail: 'Set the Cloudflare account and token in the Marks settings, or in CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_WORKERS_AI_API_KEY',
          at: new Date().toISOString() })
        return undefined
      }
      return new ReactionPicker({ store, health }, { account: accountId, token, model: config.model, timeoutMs: config.timeoutMs }).pick(message)
    } }
    // Report the starting state once; a later save is reflected by the next pick.
    const initial = account()
    if (!initial.config.enabled) health.set({ state: 'paused', detail: 'Mark picking is off', at: new Date().toISOString() })
    else if (!initial.account || !initial.token) health.set({ state: 'paused',
      detail: 'Set the Cloudflare account and token in the Marks settings', at: new Date().toISOString() })
    else health.set({ state: 'ready', detail: 'Ready to pick an emoji', at: new Date().toISOString() })
    return chooser
  }

  /**
   * What the main Session hears of a domain event: a notice, a follow-up relay, and the chat messages a Ticket's end sends.
   * Held back while the main Session is carrying out its own command (`quiet`), so it is not told what it just did.
   */
  private announce(event: DomainEvent, deps: { store: Store; sources: SourceRegistry; sessions: Sessions; outbox: Outbox;
    activity: { lastEventAt?: number; lastHumanAt?: number; humanTriggers: number }; configured: () => boolean; repository: () => string }): void {
    const { store, sources, sessions, outbox, activity } = deps
    activity.lastEventAt = Date.parse(event.at)
    if (event.type === 'trigger.received' && store.triggers.get(event.data.triggerId)?.human) {
      activity.lastHumanAt = activity.lastEventAt
      activity.humanTriggers += 1
    }
    // Notify the main Session only about domain events it did not initiate itself.
    const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
    if (notice) sessions.notify(...notice)
    // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
    // and of one for an ended ticket once it resumes, unless it routed the message there itself.
    const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
    const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
    if (followup) sessions.relay(followup.id, followup.text)
    // Notify the ticket's conversations whenever it ends via a pull request.
    const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
    if (ended && deps.configured()) {
      const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
      for (const message of pullEndNotices(ended, request, deps.repository())) outbox.send(message)
    }
  }

  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    // Before any Session may send a request: routing listeners and the main Session's recovery probe.
    this.router.install()
    this.mcp.install()
    this.executor.install()
    await this.sessions.ensure(this.mainSessionId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, actions, executor, health, machine, mainSessionId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, actions, executor, health, machine, mainSessionId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog(),
      routes: () => this.router.routeStates() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.mainSessionId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.mcp.dispose()
      this.sessions.dispose()
      this.router.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
