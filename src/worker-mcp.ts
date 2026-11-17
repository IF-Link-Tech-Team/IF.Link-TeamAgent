/**
 * Stdio MCP relay for an external worker runtime.
 *
 * The harness starts it as its `teamagent` MCP server; it forwards newline-delimited JSON-RPC to the plugin's Unix
 * socket and writes the answers back. The token and ticket come from the environment the executor set for this launch.
 *
 * A harness may also read this server from a shared configuration file, so a run without that environment — a person
 * using the harness directly — gets an empty server instead of a failed one. Losing the socket mid-run degrades the
 * same way: the worker keeps its own tools and reports what it could not do.
 */
import { connect, type Socket } from 'node:net'

const socketPath = process.env.TEAMAGENT_MCP_SOCKET
const token = process.env.TEAMAGENT_MCP_TOKEN
const ticket = process.env.TEAMAGENT_MCP_TICKET
const configured = !!socketPath && !!token && !!ticket

const PROTOCOL_VERSION = '2025-06-18'
const EMPTY_TOOLS = { tools: [] as unknown[] }

/** One JSON-RPC reply the local fallback writes when no socket serves this run. */
function local(message: { id?: unknown; method?: unknown }): void {
  if (message.id === undefined) return
  const method = typeof message.method === 'string' ? message.method : ''
  const reply = (result?: unknown, error?: { code: number; message: string }): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...error ? { error } : { result } })}\n`)
  }
  if (method === 'initialize') return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} },
    serverInfo: { name: 'teamagent', version: '1.0.0' } })
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply(EMPTY_TOOLS)
  if (method === 'tools/call') return reply({ content: [{ type: 'text',
    text: 'The Team Agent bridge is not connected for this run; no orchestrator tool is available.' }], isError: true })
  if (method.startsWith('notifications/')) return
  reply(undefined, { code: -32601, message: `Unsupported method ${method}` })
}

if (!configured) {
  process.stderr.write('teamagent MCP relay: no ticket environment; serving an empty tool list\n')
  let buffer = ''
  process.stdin.on('data', chunk => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) return
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      try { local(JSON.parse(line) as { id?: unknown; method?: unknown }) } catch { /* Not a JSON-RPC record. */ }
    }
  })
} else {
  const socket: Socket = connect(socketPath!)
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ token, ticket })}\n`)
    process.stdin.pipe(socket)
    socket.pipe(process.stdout)
  })
  socket.on('error', error => {
    process.stderr.write(`teamagent MCP relay: ${error.message}\n`)
    process.exit(1)
  })
  socket.on('close', () => process.exit(0))
  process.stdin.on('end', () => socket.end())
}
