/**
 * `zn mcp`: start the MCP server in stdio mode. The CLI process
 * effectively becomes the MCP server for as long as the calling
 * client (Claude Code, Claude Desktop, Codex) keeps the stdin pipe
 * open. We delegate to the same runMcpServer() the legacy
 * out/main/mcp.js entry uses; the one difference is which vault the
 * tools run against. `zn mcp` honours `--vault`, `--server` and
 * `--token` like every other command (#831), so an agent can be
 * pointed at a vault other than the one the desktop app has open,
 * or at a server, from its MCP client config alone. Without flags it
 * follows the environment and then the app, as before. A flag that
 * names nothing is reported on stderr at startup and the server still
 * starts; the CLI's usual "resolve, then fail the command" would leave
 * the MCP client with a dead server and no message.
 */

import { runMcpServer } from '../../mcp/server.js'
import type { ParsedArgs } from '../args.js'
import { resolveTarget } from '../vault-target.js'

export async function cmdMcp(args: ParsedArgs): Promise<void> {
  await runMcpServer({ resolveTarget: () => resolveTarget(args) })
  // The MCP SDK's connect() returns once stdin/stdout listeners are
  // wired up. Node's event loop keeps the process alive while those
  // listeners exist, but the CLI dispatcher would otherwise see this
  // promise resolve and call process.exit(0), tearing down stdin
  // before the client can send any requests. Awaiting indefinitely
  // here pins the process to whatever lifetime the parent client
  // (Claude Code / Desktop / Codex) chooses to give it.
  await new Promise<void>(() => {})
}
