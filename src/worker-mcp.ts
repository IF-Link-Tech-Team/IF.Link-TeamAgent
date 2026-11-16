/**
 * Stdio MCP relay for an external worker runtime.
 *
 * The harness starts it as its `teamagent` MCP server; it forwards newline-delimited JSON-RPC to the plugin's Unix
 * socket and writes the answers back. The token and ticket come from the environment the executor set for this launch.
 */
import { connect } from 'node:net'

const socketPath = process.env.TEAMAGENT_MCP_SOCKET
const token = process.env.TEAMAGENT_MCP_TOKEN
const ticket = process.env.TEAMAGENT_MCP_TICKET
if (!socketPath || !token || !ticket) {
  process.stderr.write('teamagent MCP relay: TEAMAGENT_MCP_SOCKET, TEAMAGENT_MCP_TOKEN and TEAMAGENT_MCP_TICKET are required\n')
  process.exit(2)
}
const socket = connect(socketPath)
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
