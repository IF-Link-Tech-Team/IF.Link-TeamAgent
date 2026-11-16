/** External worker runtime over the Agent Client Protocol: one ACP process and session per ticket. */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream } from '@agentclientprotocol/sdk'
import type { ClientConnection, ContentBlock, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { key, latestAssignment, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import type { Assignment, EngineForExecutor, Executor, Ticket, TicketInput, Trigger } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import type { RuntimeProfile, Settings } from '../policy.ts'
import { KV } from '../kv.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { Variable } from '../app/execution-environment.ts'
import type { Prompts } from '../app/prompts.ts'
import type { HealthEntry } from '../infra/health.ts'
import { packagePath } from '../infra/paths.ts'
import type { WorkerMcpServer } from '../app/mcp-server.ts'
import type { WorkerSlots } from './dsh.ts'
import { inputMessage, mandateInstructions, sourceTrigger, triggerMessage, transient } from './dsh.ts'
import { prepareWorkspace } from './workspace.ts'

const now = (): string => new Date().toISOString()
/** How many turns one ticket may run before the runtime is stopped and reported waiting. */
const MAX_TURNS = 200
/** Grace between `session/cancel` and SIGTERM, and between SIGTERM and SIGKILL. */
const CANCEL_GRACE_MS = 10_000
/** The worker prompt's fixed harness contract; it names the MCP tools without assuming a client's tool-name prefix. */
const RUNTIME_CONTRACT = [
  'You are the worker of this ticket. The `teamagent` MCP server holds the authoritative tools:',
  '`orchestrator_read` reads the ticket and its thread, `orchestrator_ack` acknowledges a human request,',
  '`orchestrator_report` reports progress, ready, blocked, failed or dropped, and `orchestrator_thread_follow`,',
  '`orchestrator_thread_unrelated` and `orchestrator_trigger_handback` manage threads and out-of-scope messages.',
  'Before ending any turn, call `orchestrator_report`. If you need a person, report blocked with one concrete question.',
  'Team memory is in `memory/`; read it before a decision. Team skills are in `.teamagent/skills`; read the matching `SKILL.md` before Feishu or GitHub operations.',
  'Work only inside this ticket directory; never merge a pull request, close an Issue or expose private chat content.',
].join('\n')

/** What `AcpExecutor` needs from the Runtime. */
export interface AcpExecutorHost {
  readonly context: Pick<Context, 'subprocess'>
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'atomic' | 'set' | 'get' | 'delete'>
  readonly effects: Pick<Effects, 'enqueue'>
  readonly machine: Pick<Machine, 'stateDir' | 'memoryDir'>
  readonly lifetime: AbortSignal
  readonly slots: WorkerSlots
  readonly prompts: Pick<Prompts, 'compose' | 'current'>
  readonly mcp: Pick<WorkerMcpServer, 'issue' | 'revoke'>
  readonly health: HealthEntry
  environment(ticket: Ticket): Variable[]
  closing(): boolean
  paused(): boolean
  /** A message for the main Session, used when a turn ends without a report. */
  relay(requestId: string, text: string): void
}

/** One live ACP process and session for a ticket. */
interface AcpRun {
  ticketId: string
  assignmentId: string
  runtime: string
  model: string
  child: ChildProcess
  conn: ClientConnection
  sessionId: string
  cwd: string
  token: string
  transcript: string
  lastText: string
  turns: number
  stopping: boolean
  startedAt: number
  turn?: { startedAt: string; claimed: string[]; timer: ReturnType<typeof setTimeout> }
  pending: { text: string; ids: string[] }[]
}

/** Expand a leading `~` so a profile stored in settings can name a user-local binary. */
const expandHome = (path: string): string => path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

/** Read KEY=VALUE lines from a private env file; comments and blank lines are ignored. */
async function readEnvFile(path: string): Promise<Record<string, string>> {
  if (!path) return {}
  try {
    const text = await readFile(expandHome(path), 'utf8')
    return Object.fromEntries(text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).flatMap(line => {
      const at = line.indexOf('=')
      return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1)]] : []
    }))
  } catch { return {} }
}

/** Replace the prompt block between its markers, or append it when the file has none. */
function mergePrompt(current: string, block: string): string {
  const start = '<!-- teamagent:begin -->', end = '<!-- teamagent:end -->'
  const from = current.indexOf(start), to = current.indexOf(end, from + start.length)
  if (from >= 0 && to >= 0) return `${current.slice(0, from)}${block}${current.slice(to + end.length).replace(/^\n/, '')}`
  return `${current}${!current || current.endsWith('\n') ? '' : '\n'}${block}\n`
}

/** Write the worker prompt into every file its runtime reads, plus a copy under `.teamagent/`. */
async function writePrompt(cwd: string, files: string[], text: string): Promise<void> {
  const block = `<!-- teamagent:begin -->\n${text}\n<!-- teamagent:end -->`
  await mkdir(join(cwd, '.teamagent'), { recursive: true })
  await writeFile(join(cwd, '.teamagent', 'prompt.md'), `${text}\n`)
  for (const file of files.length ? files : ['AGENTS.md']) {
    const path = join(cwd, file)
    let current = ''
    try { current = await readFile(path, 'utf8') } catch { /* A new prompt file. */ }
    await writeFile(path, mergePrompt(current, block))
  }
}

/**
 * Runs Assignments on an ACP agent (Claude Code, Kimi Code, Antigravity, …).
 *
 * It starts one process and session per ticket, injects the worker prompt through AGENTS.md/CLAUDE.md, gives the agent
 * the `teamagent` MCP tools over a Unix socket, and maps ACP turn completion onto the Engine's Assignment facts. Reports
 * come from the MCP tools; a turn that ends without one becomes a `waiting` report with its last words.
 */
export class AcpExecutor {
  private readonly runs = new Map<string, AcpRun>()

  constructor(private readonly host: AcpExecutorHost) {}

  /** Runs a queued launch: prepare the workspace, start the runtime, and hand it the assignment. */
  async launchNow({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.host.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment) }
    catch (error) {
      if (this.host.closing() || error instanceof Later) throw error
      this.fail(ticketId, `Runtime launch failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally { this.host.slots.free(ticketId) }
  }

  /** Hands the ticket's waiting Inputs to its running session, or queues them behind the current turn. */
  async deliverNow(ticketId: string): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
    const run = this.runs.get(ticketId)
    if (!ticket || !assignment || !run) throw new Later('The worker is not running yet')
    for (const id of [...ticket.undelivered]) {
      const current = this.host.store.tickets.get(ticketId)
      const input = current?.inputs.find(item => item.id === id)
      if (!current || !input) continue
      const text = this.inputText(current, input)
      this.host.engine.inputsDelivered(ticketId, assignment.id, [id])
      if (run.turn) run.pending.push({ text, ids: [id] })
      else await this.prompt(run, text, [id])
    }
  }

  /** Cancels the session and stops its process tree. */
  stop(ticket: Ticket): void {
    const run = this.runs.get(ticket.id)
    if (run) void this.close(run, 'Ticket ended')
  }

  /** Closes every session; the host is shutting down. */
  shutdown(): void {
    for (const run of [...this.runs.values()]) void this.close(run, 'Host stopped')
  }

  /** Reports interrupted Assignments and re-queues pending external launches after a restart. */
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (!ticket.execution?.runtime || ticket.execution.runtime === 'dsh') continue
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) { this.host.engine.assignmentInterrupted(ticket.id, running.id); continue }
      if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.host.effects.enqueue('launch', latest.id,
        { ticketId: ticket.id, assignmentId: latest.id })
    }
  }

  /** The live session id and runtime of a ticket, for the panel and for a later resume. */
  sessionOf(ticketId: string): { runtime: string; sessionId: string } | undefined {
    const run = this.runs.get(ticketId)
    return run ? { runtime: run.runtime, sessionId: run.sessionId } : undefined
  }

  /** How many external workers hold a slot. */
  activeCount(): number { return [...this.runs.values()].filter(run => !run.stopping).length }

  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const settings = this.host.store.settings()
    const runtime = ticket.execution?.runtime ?? 'dsh'
    const profile = settings.runtimes[runtime]
    if (!profile?.enabled) throw new Error(`Worker runtime ${runtime} is not enabled`)
    if (profile.protocol !== 'acp') throw new Error(`Worker runtime ${runtime} is not an ACP runtime`)
    const cwd = ticket.execution?.directory ?? ''
    if (!cwd) throw new Error('The ticket has no workspace directory')
    if (!await stat(cwd).then(() => true, () => false)) {
      await prepareWorkspace(ticket, this.host)
      if (!current()) return
    }
    const prompt = this.promptText(ticket)
    await writePrompt(cwd, profile.promptFiles, prompt)
    // The worker reads the same Source skills a DSH Session registers, from a stable path inside its ticket.
    const skills = join(cwd, '.teamagent', 'skills')
    await rm(skills, { recursive: true, force: true })
    await cp(packagePath('skills'), skills, { recursive: true, force: true }).catch(() => { /* A package without skills still works. */ })
    const issued = this.host.mcp.issue(ticket.id)
    const transcript = join(cwd, '.teamagent', 'transcript.ndjson')
    await mkdir(join(cwd, '.teamagent'), { recursive: true })
    await appendFile(transcript, `${JSON.stringify({ at: now(), event: 'launch', runtime, model: ticket.execution?.model ?? '' })}\n`)
    const child = spawn(this.command(profile, ticket.execution?.model ?? ''), this.args(profile, ticket.execution?.model ?? '', cwd), {
      cwd, env: await this.environment(profile, ticket, issued), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    if (!child.stdin || !child.stdout) throw new Error('The runtime did not expose stdio')
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
    const run: AcpRun = { ticketId: ticket.id, assignmentId: assignment.id, runtime, model: ticket.execution?.model ?? '', child, conn: undefined!,
      sessionId: '', cwd, token: issued.token, transcript, lastText: '', turns: 0, stopping: false, startedAt: Date.now(), pending: [] }
    this.runs.set(ticket.id, run)
    child.stderr?.on('data', (chunk: Buffer) => { void appendFile(join(cwd, '.teamagent', 'runtime.log'), chunk.toString('utf8')) })
    child.on('exit', (code, signal) => {
      if (run.stopping) return
      this.fail(ticket.id, `Runtime exited (${code ?? signal ?? 'unknown'})`)
    })
    const app = client({ name: 'dsh-superagent' })
    app.onNotification('session/update', (context: { params: SessionNotification }) => { this.update(run, context.params) })
    app.onRequest('session/request_permission', context => this.permission(context.params))
    run.conn = app.connect(stream)
    const init = await run.conn.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'dsh-superagent', version: '0.1.0' } })
    const mcpServers = [{ name: 'teamagent', command: process.execPath, args: [packagePath('lib', 'worker-mcp.js')], env: [
      { name: 'TEAMAGENT_MCP_SOCKET', value: issued.socket },
      { name: 'TEAMAGENT_MCP_TOKEN', value: issued.token },
      { name: 'TEAMAGENT_MCP_TICKET', value: ticket.id }] }]
    const saved = this.host.store.get(KV.runtime.sessions(ticket.id))
    if (saved?.sessionId && saved.runtime === runtime) {
      run.sessionId = saved.sessionId
      const loaded = await run.conn.agent.request('session/load', { sessionId: saved.sessionId, cwd, mcpServers })
        .then(() => true, () => false)
      if (!loaded) run.sessionId = ''
    }
    if (!run.sessionId) {
      const created = await run.conn.agent.request('session/new', { cwd, mcpServers }) as { sessionId: string }
      run.sessionId = created.sessionId
    }
    if (ticket.execution?.model && profile.modelMode === 'config') {
      await run.conn.agent.request('session/set_config_option', { sessionId: run.sessionId, configId: 'model',
        value: ticket.execution.model }).catch(() => { /* A runtime without a model option keeps its default. */ })
    }
    this.host.store.atomic(() => this.host.store.set(KV.runtime.sessions(ticket.id),
      { runtime, sessionId: run.sessionId, at: now() }))
    this.host.health.set({ state: 'ready', detail: `${runtime} is available` })
    const first = this.assignmentText(ticket)
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
    run.turn = undefined
    void this.prompt(run, first, [])
  }

  /** The command for one launch, replacing `{model}` in an arg-mode template. */
  private command(profile: RuntimeProfile, model: string): string {
    return expandHome(profile.command.replaceAll('{model}', model))
  }

  /** The arguments for one launch: profile args, an optional model flag, and `{cwd}`/`{model}` substitution. */
  private args(profile: RuntimeProfile, model: string, cwd: string): string[] {
    const args = profile.args.map(arg => arg.replaceAll('{model}', model).replaceAll('{cwd}', cwd))
    if (profile.modelMode === 'arg' && profile.modelArg.trim()) args.push(...profile.modelArg.trim().split(/\s+/)
      .map(arg => arg.replaceAll('{model}', model)))
    return args
  }

  /** The child environment: the host's, the profile's non-secret values, a private env file, and this ticket's variables. */
  private async environment(profile: RuntimeProfile, ticket: Ticket, issued: { token: string; socket: string }): Promise<NodeJS.ProcessEnv> {
    const variables = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    return { ...process.env, ...profile.env, ...await readEnvFile(profile.envFile), ...variables,
      PATH: [join(this.host.machine.stateDir, 'worker-bin'), process.env.PATH ?? ''].filter(Boolean).join(':'),
      TEAMAGENT_MCP_SOCKET: issued.socket, TEAMAGENT_MCP_TOKEN: issued.token, TEAMAGENT_MCP_TICKET: ticket.id }
  }

  /** The worker prompt: the configured worker sections, the mandate note, and the harness contract. */
  private promptText(ticket: Ticket): string {
    const config = this.host.prompts.current().config
    return `${this.host.prompts.compose(config, 'worker', this.host.environment(ticket))}\n\n${mandateInstructions(ticket.mandate)}\n\n${RUNTIME_CONTRACT}\n`
  }

  /** The first message: the assignment, the originating request, and how to report. */
  private assignmentText(ticket: Ticket): string {
    const source = sourceTrigger(this.host, ticket)
    return [
      `Ticket ${ticket.id}: ${ticket.title}`,
      ticket.execution?.assignment ? `Assignment: ${ticket.execution.assignment}` : '',
      source ? `Original request from ${source.actor.id}:\n${source.text}` : '',
      'Start by reading what you need with orchestrator_read; report with orchestrator_report before you end a turn.',
    ].filter(Boolean).join('\n\n')
  }

  /** One Input as the text a person or a Source wrote, with the trigger card when it carries one. */
  private inputText(ticket: Ticket, input: TicketInput): string {
    const trigger = input.kind === 'trigger' ? this.host.store.triggers.get(input.triggerId) : undefined
    const card = trigger ? triggerMessage(trigger, {}) : undefined
    return inputMessage(input, card) ?? (trigger?.text ?? '')
  }

  /** Appends an ACP update to the transcript and keeps the last agent text for a synthesized report. */
  private update(run: AcpRun, notification: SessionNotification): void {
    void appendFile(run.transcript, `${JSON.stringify({ at: now(), update: notification.update })}\n`)
    const update = notification.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') run.lastText += update.content.text
  }

  /** Answers a permission request: the worker already runs with full access, so allow and remember the choice. */
  private permission(request: { options: { optionId: string; kind: string }[] }): RequestPermissionResponse {
    const option = request.options.find(item => item.kind === 'allow_always') ?? request.options.find(item => item.kind === 'allow_once') ?? request.options[0]
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
  }

  /** Runs one prompt turn and maps its completion to the Engine. */
  private async prompt(run: AcpRun, text: string, claimed: string[]): Promise<void> {
    if (run.stopping || this.host.closing()) return
    const startedAt = now()
    const timer = setTimeout(() => {
      const ticket = this.host.store.tickets.get(run.ticketId)
      if (ticket && liveTicket(ticket)) this.host.engine.report(run.ticketId, { state: 'waiting',
        summary: `The turn exceeded its ${this.wallClock(run)}-minute wall-clock limit and was stopped.` })
      void this.close(run, 'The turn exceeded its wall-clock limit')
    }, this.wallClock(run) * 60_000)
    timer.unref?.()
    run.turn = { startedAt, claimed, timer }
    run.lastText = ''
    run.turns += 1
    try {
      await run.conn.agent.request('session/prompt', { sessionId: run.sessionId, prompt: [{ type: 'text', text }] })
      await this.turnEnded(run, claimed, startedAt)
    } catch (error) {
      if (!run.stopping) this.fail(run.ticketId, `Runtime turn failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
      if (run.turn?.timer === timer) run.turn = undefined
    }
  }

  /** Maps a finished turn to `turnEnded`, read Inputs, and a synthesized waiting report when no status was sent. */
  private async turnEnded(run: AcpRun, claimed: string[], startedAt: string): Promise<void> {
    const ticket = this.host.store.tickets.get(run.ticketId)
    if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== run.assignmentId) return
    this.host.engine.turnEnded(run.ticketId, run.assignmentId)
    if (claimed.length) this.host.engine.inputsRead(run.ticketId, claimed)
    const report = latestAssignment(ticket)?.report
    const terminal = !!report && report.at >= startedAt && report.state !== 'progress'
    if (terminal && report.state !== 'ready') {
      await this.close(run, `Reported ${report.state}`)
      return
    }
    if (!terminal && !ticket.attention) {
      const summary = run.lastText.trim() || 'The worker ended its turn without a status report; ask for one with orchestrator_ticket_request_status.'
      this.host.engine.report(run.ticketId, { state: 'waiting', summary: summary.slice(0, 4000) })
      if (run.lastText.trim()) this.host.relay(`acp:${run.ticketId}:${startedAt}`, run.lastText.trim().slice(0, 1200))
    }
    const limit = this.host.store.settings().runtimes[run.runtime]?.maxTurns ?? MAX_TURNS
    if (run.turns >= limit) { await this.close(run, 'The ticket reached its turn limit'); return }
    const next = run.pending.shift()
    if (next) { run.turn = undefined; void this.prompt(run, next.text, next.ids) }
  }

  /** The wall-clock limit of the ticket's runtime profile, in minutes. */
  private wallClock(run: AcpRun): number {
    return this.host.store.settings().runtimes[run.runtime]?.maxWallMinutes ?? 60
  }

  /** Reports a runtime failure on the ticket and closes the run. */
  private fail(ticketId: string, detail: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && runningAssignment(ticket)
    if (ticket && assignment && liveTicket(ticket) && !this.host.closing()) {
      this.host.engine.report(ticketId, { state: 'failed', summary: detail.slice(0, 1000) })
    }
    this.host.health.set({ state: 'error', detail })
    const run = this.runs.get(ticketId)
    if (run) void this.close(run, detail)
  }

  /** Cancels the session, stops its process tree, revokes its token, and forgets the run. */
  private async close(run: AcpRun, reason: string): Promise<void> {
    if (run.stopping) return
    run.stopping = true
    this.host.mcp.revoke(run.token)
    this.runs.delete(run.ticketId)
    try { run.conn.agent.notify('session/cancel', { sessionId: run.sessionId }) } catch { /* The process may already be gone. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
    const pid = run.child.pid
    if (pid) {
      try { process.kill(-pid, 'SIGTERM') } catch { try { run.child.kill('SIGTERM') } catch { /* Already gone. */ } }
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* Already gone. */ } }, CANCEL_GRACE_MS).unref?.()
    }
    void appendFile(run.transcript, `${JSON.stringify({ at: now(), event: 'close', reason })}\n`).catch(() => { /* Best effort. */ })
  }
}
