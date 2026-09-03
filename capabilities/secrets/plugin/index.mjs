import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

// Secrets are the user's named variables (Settings > Variables), stored in
// config.json under the `variables` array as { name, value, sensitive }. This
// plugin reads and writes that same store so the agent can save a token the
// user pastes in chat without hand-editing config.json — the value then shows
// up in the Settings UI and in the agent's <variables> context block exactly
// like one added from the UI.
//
// config.json syncs to the organization's master record (encrypted at rest
// there), and every tool RESULT lands in the conversation transcript, which
// syncs as well. So the store is the place for a secret and a tool result is
// not: list_secrets masks every value, and get_secret returns a real value
// only on an explicit reveal: true.

let workspaceRoot = ''

const toolDefinitions = [
  {
    name: 'add_secret',
    description:
      "Save a secret or variable to the user's store (Settings > Variables) — the same place the user adds them from the UI. Use when the user shares an API key, token, password, or any reusable value and wants it saved. If a secret with the same name exists, its value is replaced. Never echo the value back in your reply.",
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Variable name the value is referenced by, e.g. "NOTION_TOKEN", "BASE_URL".'
        },
        value: { type: 'string', description: 'The secret/value to store.' },
        sensitive: {
          type: 'boolean',
          description:
            'Whether the value is a secret (masked in the Settings UI and in list_secrets). Defaults to true; pass false for non-secret config like a base URL.'
        }
      },
      required: ['name', 'value']
    }
  },
  {
    name: 'list_secrets',
    description:
      'List the saved secrets/variables (Settings > Variables) by name, each with a masked value (first and last two characters) and a sensitive flag — enough to know what exists without putting a value into the transcript. Call this before asking the user for any key/token/value. Need the real value for a tool call? Your <variables> context block already carries it; otherwise get_secret with reveal: true.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_secret',
    description:
      'Return ONE saved secret/variable by name. Without reveal: true you get the masked value only. With reveal: true the real value is returned — and it then sits in this tool result, which is part of the conversation transcript (synced to the organization), so reveal only when you must pass the value into another tool call and it is not already in your <variables> block. Never paste a revealed value into your reply.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact variable name, e.g. "NOTION_TOKEN".' },
        reveal: {
          type: 'boolean',
          description: 'Pass true to receive the real value instead of the masked one. Defaults to false.'
        }
      },
      required: ['name']
    }
  }
]

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(workspaceRoot, 'config.json')
}

async function readConfig() {
  const raw = await fs.readFile(configPath(), 'utf8')
  return JSON.parse(raw)
}

// Atomic write: stream to a sibling temp file, fsync, then rename(2) over the
// target. Mirrors the main process's writeConfigAtomic so a concurrent write or
// a crash can never leave a half-written config.json.
async function writeConfigAtomic(config) {
  const data = JSON.stringify(config, null, 2)
  const target = configPath()
  const tmp = path.join(
    workspaceRoot,
    `config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  let handle
  try {
    handle = await fs.open(tmp, 'w')
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    if (handle) await handle.close()
  }
  await fs.rename(tmp, target)
}

async function readVariables(tool) {
  let config
  try {
    config = await readConfig()
  } catch (err) {
    return { error: `${tool}: could not read config.json: ${errText(err)}` }
  }
  return { variables: Array.isArray(config?.variables) ? config.variables : [] }
}

// "sk••••4f2a" when the value is long enough that its ends give nothing
// away, "••••" otherwise.
function maskValue(value) {
  const s = String(value ?? '')
  if (s.length < 12) return '••••'
  return `${s.slice(0, 2)}••••${s.slice(-2)}`
}

// ---------------------------------------------------------------------------
// add_secret
// ---------------------------------------------------------------------------

async function addSecret(args) {
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  const value = typeof args?.value === 'string' ? args.value : ''
  // "add_secret" defaults to sensitive; only an explicit false opts out.
  const sensitive = !(args?.sensitive === false || args?.sensitive === 'false')

  if (!name) return { success: false, error: 'add_secret: name is required.' }
  if (value.trim().length === 0) return { success: false, error: 'add_secret: value is required.' }

  let config
  try {
    config = await readConfig()
  } catch (err) {
    return { success: false, error: `add_secret: could not read config.json: ${errText(err)}` }
  }
  if (!config || typeof config !== 'object') {
    return { success: false, error: 'add_secret: config.json is not a valid object.' }
  }

  const variables = Array.isArray(config.variables) ? config.variables : []
  const idx = variables.findIndex((v) => v && v.name === name)
  const existed = idx >= 0
  const entry = { name, value, sensitive }
  if (existed) variables[idx] = entry
  else variables.push(entry)
  config.variables = variables

  try {
    await writeConfigAtomic(config)
  } catch (err) {
    return { success: false, error: `add_secret: could not write config.json: ${errText(err)}` }
  }

  const tag = sensitive ? 'sensitive' : 'plain'
  const verb = existed ? 'Updated' : 'Saved'
  const note = existed ? ' (previous value replaced)' : ''
  return {
    success: true,
    output: `${verb} ${tag} secret \`${name}\`${note}. It's now in Settings > Variables and available to you through your <variables> block (or get_secret).`
  }
}

// ---------------------------------------------------------------------------
// list_secrets — names, masked values, sensitive flags. Never a real value:
// this output is transcript material.
// ---------------------------------------------------------------------------

async function listSecrets() {
  const { variables, error } = await readVariables('list_secrets')
  if (error) return { success: false, error }
  if (variables.length === 0) {
    return { success: true, output: 'No secrets or variables saved yet.' }
  }

  const lines = [`## Secrets & variables (${variables.length})`, '']
  for (const v of variables) {
    if (!v || typeof v.name !== 'string') continue
    const tag = v.sensitive ? 'sensitive' : 'plain'
    lines.push(`- \`${v.name}\` = ${maskValue(v.value)} (${tag})`)
  }
  lines.push(
    '',
    'Values are masked here. The real values are in your <variables> block; get_secret with reveal: true returns one on demand.'
  )
  return { success: true, output: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// get_secret — one value by name; real only on reveal: true.
// ---------------------------------------------------------------------------

async function getSecret(args) {
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (!name) return { success: false, error: 'get_secret: name is required.' }
  const reveal = args?.reveal === true || args?.reveal === 'true'

  const { variables, error } = await readVariables('get_secret')
  if (error) return { success: false, error }
  const entry = variables.find((v) => v && v.name === name)
  if (!entry) {
    return {
      success: false,
      error: `get_secret: no secret or variable named \`${name}\`. list_secrets shows what exists.`
    }
  }

  const tag = entry.sensitive ? 'sensitive' : 'plain'
  if (!reveal) {
    return {
      success: true,
      output: `\`${name}\` = ${maskValue(entry.value)} (${tag}, masked). Pass reveal: true to receive the real value — it will then be part of the transcript.`
    }
  }
  return {
    success: true,
    output: `\`${name}\` = ${String(entry.value ?? '')} (${tag}, revealed — use it in your tool call, never in your reply)`
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function errText(err) {
  if (!err) return 'unknown error'
  return err.message ? String(err.message).split(/\r?\n/)[0] : String(err)
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  name: 'secrets',
  tools: toolDefinitions,
  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? ''
  },
  async execute(toolName, args) {
    switch (toolName) {
      case 'add_secret':
        return addSecret(args ?? {})
      case 'list_secrets':
        return listSecrets()
      case 'get_secret':
        return getSecret(args ?? {})
      default:
        return { success: false, error: `secrets: unknown tool ${toolName}` }
    }
  }
}

export default plugin
