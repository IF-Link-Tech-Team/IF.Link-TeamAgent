import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpExecutor } from '../src/executor/acp.ts'
import { WorkerSlots } from '../src/executor/dsh.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Assignment, Ticket } from '../src/core/index.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A minimal ACP agent: initialize, session/new, one text update, a finished prompt turn. */
const agent = `const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', line => {
  const message = JSON.parse(line)
  const { id, method } = message
  if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } })
  else if (method === 'session/new') send({ jsonrpc: '2.0', id, result: { sessionId: 's1' } })
  else if (method === 'session/set_config_option') send({ jsonrpc: '2.0', id, result: { configOptions: [] } })
  else if (method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } })
    setTimeout(() => send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }), 5)
  } else if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
})
`

describe('ACP executor', () => {
  it('starts a session, prompts it, and reports waiting when the turn ends without a status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'teamagent-acp-')); dirs.push(root)
    const script = join(root, 'agent.cjs'); writeFileSync(script, agent)
    const cwd = join(root, 'ticket'); require('node:fs').mkdirSync(cwd)
    const calls: string[] = []
    const now = new Date().toISOString()
    const ticket: Ticket = { id: 't1', title: 'Title', decisionId: 'd', mandate: { strength: 'explicit' } as never,
      channels: [], assignments: [{ id: 'a1', state: 'pending', createdAt: now } as Assignment], inputs: [], undelivered: [], createdAt: now, updatedAt: now,
      origin: { triggerId: 'tr1', triggerIds: ['tr1'] }, execution: { name: 'ticket', directory: cwd, assignment: 'Do it', runtime: 'fake', model: 'm' } }
    const settings = SettingsSchema.parse({})
    settings.runtimes.fake = { enabled: true, protocol: 'acp', command: process.execPath, args: [script], env: {}, envFile: '', promptFiles: [],
      modelMode: 'config', modelArg: '', concurrency: 1, maxWallMinutes: 1, maxTurns: 5 }
    const executor = new AcpExecutor({
      context: { subprocess: {} } as never,
      engine: {
        assignmentStarted: () => { calls.push('started'); ticket.assignments[0]!.state = 'running' },
        inputsDelivered: () => {}, inputsRead: () => {}, turnEnded: () => { calls.push('ended') },
        deliveryFailed: () => {}, report: (_id: string, report: { state: string }) => { calls.push(`report:${report.state}`) },
        assignmentInterrupted: () => {},
      } as never,
      store: { tickets: { get: (id: string) => id === 't1' ? ticket : undefined }, triggers: { get: () => undefined }, settings: () => settings,
        atomic: (run: () => void) => run(), set: () => {}, get: () => undefined, delete: () => {} } as never,
      effects: { enqueue: () => {} } as never,
      machine: { stateDir: root, memoryDir: join(root, 'memory') } as never,
      lifetime: new AbortController().signal,
      slots: new WorkerSlots(() => [], () => 3),
      prompts: { current: () => ({ config: {} }), compose: () => 'worker prompt' } as never,
      mcp: { issue: () => ({ token: 't', socket: join(root, 'mcp.sock') }), revoke: () => {} },
      health: { set: () => {} } as never,
      environment: () => [],
      closing: () => false,
      paused: () => false,
      relay: () => {},
    })
    await executor.launchNow({ ticketId: 't1', assignmentId: 'a1' })
    await vi.waitFor(() => expect(calls).toContain('report:waiting'), { timeout: 3000 })
    expect(calls).toContain('started')
    expect(calls).toContain('ended')
    executor.shutdown()
  })
})
