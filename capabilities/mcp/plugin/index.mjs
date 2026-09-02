/**
 * mcp — Wolffish manages its own MCP server connections.
 *
 * Tools to list, add, test, enable, disable, remove, and authorize the
 * Model Context Protocol servers whose tools become available to the agent.
 *
 * All state lives in the main process's McpManager, reached through the `mcp`
 * host bridge injected at init (PluginContext.mcp) — the exact same methods
 * the Settings → MCP IPC handlers call. So the agent's view and the UI can
 * never drift: an agent-driven add/test/remove pushes the same status update
 * the settings page renders, and a manual change in settings shows up here.
 * Nothing is touched by hand.
 */

// MCP-management bridge, injected at init by the main process.
let mcp

const toolDefinitions = [
  {
    name: 'mcp_list',
    description:
      "List every configured MCP server: its name, whether it's a local command (stdio) or a remote URL, its live status, and how many tools it currently exposes. Call this first so you can reference a server by name or number for the other tools.",
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'mcp_add',
    description:
      'Add and immediately connect a new MCP server. Provide a command for a local (stdio) server or an http(s) URL for a remote one; the transport is auto-detected. Its tools become available on the next turn.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'The stdio command line (e.g. "uvx tafsir-mcp") or the remote http(s) URL (e.g. "https://mcp.example.com/mcp").'
        },
        name: {
          type: 'string',
          description: 'Optional display name; derived from the command/URL when omitted.'
        },
        env: {
          type: 'object',
          description:
            'Optional environment variables for a stdio server, as a flat object of string values. Ignored for remote URLs.'
        }
      },
      required: ['target']
    }
  },
  {
    name: 'mcp_test',
    description:
      'Re-check a server now (verify it works, or kick a stuck one back into connecting). Identify it by name, slug, or number from mcp_list.',
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'The server to test — its name, slug, or 1-based number from mcp_list.'
        }
      },
      required: ['server']
    }
  },
  {
    name: 'mcp_enable',
    description: 'Enable a disabled server so it connects again. Identify it by name, slug, or number.',
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'The server to enable — its name, slug, or 1-based number from mcp_list.'
        }
      },
      required: ['server']
    }
  },
  {
    name: 'mcp_disable',
    description:
      "Disable a server without deleting it — its tools drop out and it stops reconnecting until re-enabled. Keeps its config and sign-in. Identify it by name, slug, or number.",
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'The server to disable — its name, slug, or 1-based number from mcp_list.'
        }
      },
      required: ['server']
    }
  },
  {
    name: 'mcp_remove',
    description:
      'Permanently remove a server connection and everything it owns (config, stored sign-in). Identify it by name, slug, or number.',
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'The server to remove — its name, slug, or 1-based number from mcp_list.'
        }
      },
      required: ['server']
    }
  },
  {
    name: 'mcp_authorize',
    description:
      "Start the OAuth sign-in flow for a remote server that needs authorization. Opens the user's browser; does NOT complete on its own — tell the user to finish, then confirm with mcp_test/mcp_list. Remote (URL) servers only.",
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'The server to sign in to — its name, slug, or 1-based number from mcp_list.'
        }
      },
      required: ['server']
    }
  }
]

function missingBridge() {
  return {
    success: false,
    error: 'MCP management is unavailable in this runtime (no host bridge wired).'
  }
}

const STATE_LABEL = {
  connected: 'connected',
  connecting: 'connecting',
  'needs-auth': 'needs sign-in',
  offline: 'offline',
  disabled: 'disabled'
}

/**
 * Resolve a user-supplied reference (name, slug, or 1-based number from the
 * last mcp_list) to a server snapshot. Case-insensitive on name/slug.
 */
function resolveServer(servers, ref) {
  const raw = typeof ref === 'string' ? ref.trim() : ''
  if (!raw) return { error: 'provide a `server` — its name, slug, or number from mcp_list.' }

  // 1-based number from the list ordering.
  if (/^\d+$/.test(raw)) {
    const idx = Number(raw) - 1
    if (idx < 0 || idx >= servers.length) {
      return { error: `no server numbered ${raw} — there ${servers.length === 1 ? 'is 1 server' : `are ${servers.length} servers`}. Run mcp_list.` }
    }
    return { server: servers[idx] }
  }

  const lower = raw.toLowerCase()
  const byExact = servers.filter(
    (s) => s.id === raw || s.slug.toLowerCase() === lower || s.name.toLowerCase() === lower
  )
  if (byExact.length === 1) return { server: byExact[0] }
  if (byExact.length > 1) {
    return { error: `"${raw}" matches ${byExact.length} servers — reference it by its number from mcp_list instead.` }
  }

  const byPartial = servers.filter((s) => s.name.toLowerCase().includes(lower))
  if (byPartial.length === 1) return { server: byPartial[0] }
  if (byPartial.length > 1) {
    return { error: `"${raw}" matches ${byPartial.length} servers — be more specific or use the number from mcp_list.` }
  }
  return { error: `no server matches "${raw}". Run mcp_list to see the exact names.` }
}

function describeServer(s, index) {
  const kind = s.transport === 'http' ? 'remote' : 'local'
  const status = STATE_LABEL[s.state] ?? s.state
  const tools = s.state === 'connected' ? ` · ${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : ''
  const lines = [`${index}. **${s.name}** — ${status}${tools} (${kind})`, `   \`${s.target}\``]
  if (s.state === 'offline' && s.error) lines.push(`   issue: ${s.error.split('\n')[0]}`)
  return lines.join('\n')
}

function listServers() {
  if (!mcp) return missingBridge()
  const servers = mcp.list()
  if (servers.length === 0) {
    return {
      success: true,
      output:
        'No MCP servers are configured yet. Use `mcp_add` with a command (local server) or an http(s) URL (remote server).'
    }
  }
  const lines = [`## MCP servers (${servers.length})`, '']
  servers.forEach((s, i) => lines.push(describeServer(s, i + 1)))
  return { success: true, output: lines.join('\n').trim() }
}

async function addServer(args) {
  if (!mcp) return missingBridge()
  const target = typeof args?.target === 'string' ? args.target.trim() : ''
  if (!target) return { success: false, error: 'mcp_add: provide a `target` (a command or an http(s) URL).' }
  const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : undefined
  const env =
    args?.env && typeof args.env === 'object' && !Array.isArray(args.env) ? normalizeEnv(args.env) : undefined

  const result = await mcp.add({ target, name, env })
  if (!result.ok) return { success: false, error: `mcp_add: ${result.error}` }

  const s = result.server
  const status = STATE_LABEL[s.state] ?? s.state
  if (s.state === 'connected') {
    return {
      success: true,
      output: `Added **${s.name}** and connected — ${s.toolCount} tool${s.toolCount === 1 ? '' : 's'} now available (they become callable on your next turn).`
    }
  }
  if (s.state === 'needs-auth') {
    return {
      success: true,
      output: `Added **${s.name}**. It needs sign-in — call \`mcp_authorize\` with "${s.name}", then have the user finish in their browser.`
    }
  }
  return {
    success: true,
    output: `Added **${s.name}** (${status}). It keeps trying to connect in the background — check \`mcp_test\` or \`mcp_list\` in a moment.`
  }
}

function normalizeEnv(obj) {
  const env = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k === 'string' && k.trim()) env[k.trim()] = String(v)
  }
  return Object.keys(env).length > 0 ? env : undefined
}

async function testServer(args) {
  if (!mcp) return missingBridge()
  const found = resolveServer(mcp.list(), args?.server)
  if (found.error) return { success: false, error: `mcp_test: ${found.error}` }
  const result = await mcp.test(found.server.id)
  if (result.ok) {
    return {
      success: true,
      output: `**${found.server.name}** is reachable — ${result.toolCount ?? 0} tool${result.toolCount === 1 ? '' : 's'}${result.durationMs != null ? ` in ${result.durationMs} ms` : ''}.`
    }
  }
  return {
    success: false,
    error: `mcp_test: **${found.server.name}** is not reachable — ${result.error ?? 'unknown error'}`
  }
}

async function setEnabled(args, enabled, verb) {
  if (!mcp) return missingBridge()
  const found = resolveServer(mcp.list(), args?.server)
  if (found.error) return { success: false, error: `mcp_${verb}: ${found.error}` }
  const result = await mcp.setEnabled(found.server.id, enabled)
  if (!result.ok) return { success: false, error: `mcp_${verb}: ${result.error ?? 'failed'}` }
  return {
    success: true,
    output: enabled
      ? `Enabled **${found.server.name}** — it's connecting now; its tools return on your next turn.`
      : `Disabled **${found.server.name}** — its tools are no longer available. Its configuration is kept; re-enable it anytime.`
  }
}

async function removeServer(args) {
  if (!mcp) return missingBridge()
  const found = resolveServer(mcp.list(), args?.server)
  if (found.error) return { success: false, error: `mcp_remove: ${found.error}` }
  const name = found.server.name
  const result = await mcp.remove(found.server.id)
  if (!result.ok) return { success: false, error: `mcp_remove: ${result.error ?? 'failed'}` }
  return { success: true, output: `Removed **${name}** and cleaned up its configuration and any sign-in.` }
}

async function authorizeServer(args) {
  if (!mcp) return missingBridge()
  const found = resolveServer(mcp.list(), args?.server)
  if (found.error) return { success: false, error: `mcp_authorize: ${found.error}` }
  if (found.server.transport !== 'http') {
    return { success: false, error: `mcp_authorize: **${found.server.name}** is a local server — sign-in only applies to remote (URL) servers.` }
  }
  const result = await mcp.authorize(found.server.id)
  if (result.ok) {
    return { success: true, output: `Signed in to **${found.server.name}** — it's connected now.` }
  }
  return {
    success: true,
    output: `Opened the sign-in page for **${found.server.name}** in the browser. Ask the user to finish signing in, then confirm with \`mcp_test\`. (${result.error ?? 'awaiting the user'})`
  }
}

const plugin = {
  name: 'mcp',
  tools: toolDefinitions,
  async init(context) {
    mcp = context?.mcp
  },
  async execute(toolName, args) {
    switch (toolName) {
      case 'mcp_list':
        return listServers()
      case 'mcp_add':
        return addServer(args ?? {})
      case 'mcp_test':
        return testServer(args ?? {})
      case 'mcp_enable':
        return setEnabled(args ?? {}, true, 'enable')
      case 'mcp_disable':
        return setEnabled(args ?? {}, false, 'disable')
      case 'mcp_remove':
        return removeServer(args ?? {})
      case 'mcp_authorize':
        return authorizeServer(args ?? {})
      default:
        return { success: false, error: `mcp: unknown tool ${toolName}` }
    }
  }
}

export default plugin
