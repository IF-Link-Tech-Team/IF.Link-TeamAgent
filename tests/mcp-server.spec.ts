import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WorkerMcpServer } from '../src/app/mcp-server.ts'
import type { Tool } from '../src/app/tools/tool.ts'

const dirs: string[] = []
const servers: WorkerMcpServer[] = []
const sockets: Socket[] = []
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) server.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A socket whose responses are read one JSON-RPC message at a time. */
function channel(path: string, token: string): { send(value: unknown): void; next(): Promise<Record<string, unknown>>; closed: Promise<boolean> } {
  const socket = connect(path)
  sockets.push(socket)
  let buffer = '', pending: ((value: Record<string, unknown>) => void)[] = [], queued: Record<string, unknown>[] = []
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) break
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      const value = JSON.parse(line) as Record<string, unknown>
      const waiter = pending.shift()
      if (waiter) waiter(value); else queued.push(value)
    }
  })
  const opened = new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const closed = new Promise<boolean>(resolve => socket.once('close', () => resolve(true)))
  return {
    send(value) { socket.write(`${JSON.stringify(value)}\n`) },
    async next() {
      await opened
      const value = queued.shift()
      return value ?? new Promise(resolve => pending.push(resolve))
    },
    closed,
  }
}

describe('worker MCP server', () => {
  it('answers initialize, lists the ticket tools and executes a call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamagent-mcp-')); dirs.push(dir)
    const tool: Tool = { name: 'orchestrator_report', description: 'Report a state', schema: z.object({ state: z.string() }),
      execute: async args => ({ ok: (args as { state: string }).state }) }
    const server = new WorkerMcpServer({ stateDir: dir, lifetime: new AbortController().signal, tools: () => [tool] })
    servers.push(server)
    server.install()
    const issued = server.issue('ticket-1')
    await new Promise(resolve => setTimeout(resolve, 50))
    const client = channel(issued.socket, issued.token)
    client.send({ token: issued.token, ticket: 'ticket-1' })
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    expect(await client.next()).toMatchObject({ id: 1, result: { protocolVersion: expect.any(String) } })
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(await client.next()).toMatchObject({ id: 2, result: { tools: [{ name: 'orchestrator_report' }] } })
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'orchestrator_report', arguments: { state: 'ready' } } })
    const called = await client.next()
    expect(called).toMatchObject({ id: 3, result: { content: [{ type: 'text', text: '{"ok":"ready"}' }] } })
  })

  it('refuses a token bound to another ticket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamagent-mcp-')); dirs.push(dir)
    const server = new WorkerMcpServer({ stateDir: dir, lifetime: new AbortController().signal, tools: () => [] })
    servers.push(server)
    server.install()
    const issued = server.issue('ticket-1')
    await new Promise(resolve => setTimeout(resolve, 50))
    const client = channel(issued.socket, issued.token)
    client.send({ token: issued.token, ticket: 'ticket-2' })
    client.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
    await expect(Promise.race([client.next(), client.closed])).resolves.toBe(true)
  })
})
