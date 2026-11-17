/** A loopback MCP server over a Unix socket: it gives an external worker runtime the orchestrator tools of its ticket. */
import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Tool } from './tools/tool.ts'

/** What the MCP server needs from the Runtime: the ticket's tools and the state directory holding its socket. */
export interface WorkerMcpDeps {
  readonly stateDir: string
  /** The executor tools of one ticket, built the same way a DSH worker Session gets them. */
  tools(ticketId: string): Tool[]
  readonly lifetime: AbortSignal
}

/** The handshake line a relay sends before any MCP message. */
interface Handshake { token?: unknown; ticket?: unknown }

/**
 * Serves MCP (initialize, tools/list, tools/call, ping) to external worker runtimes over one Unix socket.
 *
 * Each launch gets a random token bound to its ticket, so a harness cannot call another ticket's tools. Tokens are
 * in-memory: a restart relaunches its workers and issues new ones.
 */
export class WorkerMcpServer {
  private server?: Server
  private readonly tokens = new Map<string, string>()
  private readonly sockets = new Set<Socket>()
  private disposed = false

  constructor(private readonly host: WorkerMcpDeps) {}

  /** The socket path; it is inside the state directory, which only the operator can read. */
  get socketPath(): string { return join(this.host.stateDir, 'worker-mcp.sock') }

  /** Starts listening, replacing a stale socket left by a previous process. */
  install(): void {
    if (this.server) return
    mkdirSync(this.host.stateDir, { recursive: true, mode: 0o700 })
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath)
    const server = createServer(socket => this.accept(socket))
    server.on('error', () => { /* A health entry reports launch failures; a socket error must not crash the host. */ })
    server.listen(this.socketPath)
    this.server = server
    this.host.lifetime.addEventListener('abort', () => this.dispose(), { once: true })
  }

  /** Issues a token for one ticket's launch and returns what the harness needs to reach the server. */
  issue(ticketId: string): { token: string; socket: string } {
    const token = randomUUID()
    this.tokens.set(token, ticketId)
    return { token, socket: this.socketPath }
  }

  /** Drops a token when its launch ends, so a stale process cannot call tools after the ticket moved on. */
  revoke(token: string): void { this.tokens.delete(token) }

  /** Stops listening and closes every open connection. */
  dispose(): void {
    this.disposed = true
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.tokens.clear()
    this.server?.close()
    this.server = undefined
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath)
  }

  private accept(socket: Socket): void {
    if (this.disposed) { socket.destroy(); return }
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => this.sockets.delete(socket))
    let buffer = '', ticket: string | undefined
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const at = buffer.indexOf('\n')
        if (at < 0) return
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line) continue
        if (ticket === undefined) {
          ticket = this.handshake(line)
          if (!ticket) { socket.destroy(); return }
          continue
        }
        this.message(socket, ticket, line).catch(() => { /* A malformed message answers itself; nothing else to do. */ })
      }
    })
  }

  /** Reads the first line and resolves the ticket its token names; an unknown or mismatched token closes the socket. */
  private handshake(line: string): string | undefined {
    let value: Handshake
    try { value = JSON.parse(line) as Handshake } catch { return undefined }
    if (typeof value.token !== 'string' || typeof value.ticket !== 'string') return undefined
    const ticket = this.tokens.get(value.token)
    return ticket === value.ticket ? ticket : undefined
  }

  private async message(socket: Socket, ticketId: string, line: string): Promise<void> {
    let request: { id?: unknown; method?: unknown; params?: unknown }
    try { request = JSON.parse(line) as typeof request } catch { this.reply(socket, null, undefined, { code: -32700, message: 'Parse error' }); return }
    const id = request.id
    const method = typeof request.method === 'string' ? request.method : ''
    try {
      const result = await this.call(method, request.params, ticketId)
      if (id !== undefined) this.reply(socket, id, result)
    } catch (error) {
      if (id !== undefined) this.reply(socket, id, undefined, { code: -32603, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async call(method: string, params: unknown, ticketId: string): Promise<unknown> {
    switch (method) {
      case 'initialize': return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'teamagent', version: '1.0.0' } }
      case 'notifications/initialized': return undefined
      case 'ping': return {}
      case 'tools/list': return { tools: this.host.tools(ticketId).map(tool => ({ name: tool.name, description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema) })) }
      case 'tools/call': {
        const { name, arguments: args } = z.object({ name: z.string(), arguments: z.unknown().default({}) }).parse(params)
        const tool = this.host.tools(ticketId).find(item => item.name === name)
        if (!tool) throw new Error(`Unknown tool ${name}`)
        const value = await tool.execute(tool.schema.parse(args), new AbortController().signal)
        return { content: [{ type: 'text', text: JSON.stringify(value) }] }
      }
      default: throw new Error(`Unsupported MCP method ${method}`)
    }
  }

  private reply(socket: Socket, id: unknown, result?: unknown, error?: { code: number; message: string }): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...error ? { error } : { result } })}\n`)
  }
}
