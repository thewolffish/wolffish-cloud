/**
 * The flows that live on a settings card but are not a single value.
 *
 * A capability toggle, an MCP server, a phone pairing, a factory
 * reset — none of these is a row you type a value into, and all of them are
 * what someone actually came to the page to do. They are registered against
 * the SAME card ids the scalar rows use (`services.brave`, `channels.cli`, …)
 * so they appear on the card the user is already looking at, rather than
 * behind a separate top-level command they have to know exists.
 *
 * Every flow returns an exit code and does its own reading-back: a handler may
 * normalise, a locked core capability may refuse, an OS registration may fail,
 * and reporting the request as though it were the result is how a settings
 * screen ends up lying.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  bytes,
  c,
  confirm,
  g,
  heading,
  icon,
  interactive,
  keyValue,
  out,
  question,
  shortPath,
  table,
  wrapText
} from '../lib/ui.mjs'
import { pair } from './pair.mjs'
import { pathCommand, service } from './service.mjs'
import { capabilities, variables } from './settings.mjs'
import { isQuit, outOfRange, usage, USAGE_RANGES } from './workspace.mjs'

/**
 * A numbered menu. Returns the chosen item, or null for "leave it alone" —
 * blank, a bad number, or no TTY to ask on.
 */
export async function pick(items, { label = (item) => String(item), prompt = null } = {}) {
  if (items.length === 0) return null
  for (;;) {
    items.forEach((item, i) => {
      out(`   ${c.cyan(String(i + 1).padStart(2))}. ${label(item, i)}`)
    })
    out()
    if (!interactive()) return null
    const answer = (
      await question(`  ${c.dim(prompt ?? `1-${items.length}, blank cancels`)}: `)
    ).trim()
    if (!answer || isQuit(answer)) return null
    const chosen = items[Number.parseInt(answer, 10) - 1]
    // Ask again rather than dumping the caller back a level. A mistyped number
    // that silently cancels the whole flow is the single most common way a menu
    // reads as "I pressed a key and nothing happened".
    if (!chosen) {
      outOfRange(items.length)
      out()
      continue
    }
    return chosen
  }
}

// ─── Models ─────────────────────────────────────────────────────────────────
// One lane: the model is a pick from the org's catalog (see `model.chat`);
// there are no provider keys and no local models to manage.

// ─── Channels ───────────────────────────────────────────────────────────────

/**
 * The CLI card's two facts, together: is the command findable, and will the
 * daemon come back after a reboot. The card offers an action for each, so the
 * view that sits above them has to answer for both — showing only autostart
 * left "did the PATH install work?" unanswerable from the page that installs it.
 */
async function cliStatus(client) {
  // Named for what they are, not `path`/`service` — those shadow this module's
  // own imports and read as the wrong thing three lines later.
  const [shim, autostart] = await Promise.all([
    client.invoke('cli:pathStatus', process.env.PATH ?? null).catch(() => null),
    client.invoke('service:status').catch(() => null)
  ])
  heading('The wfc command')
  keyValue([
    ['on PATH', shim?.installed ? c.green('yes') : c.red('no')],
    ['shim', c.gray(shortPath(shim?.target ?? '—'))],
    ['resolves to', shim?.resolved ? c.gray(shortPath(shim.resolved)) : c.gray('nothing')]
  ])
  if (shim?.shadowedBy) {
    out(`  ${icon.warn()} ${c.yellow(`another wfc runs first: ${shortPath(shim.shadowedBy)}`)}`)
  }
  if (shim?.needsPathEntry && shim.profileHint) {
    out(`  ${icon.warn()} ${c.yellow('its folder is not on your PATH')}`)
    out(`  ${c.bold(shim.profileHint)}`)
  }

  heading('Autostart')
  keyValue([
    ['registered', autostart?.active ? c.green('yes') : c.yellow('no')],
    ['mechanism', c.gray(String(autostart?.mechanism ?? 'unknown'))],
    ['start as', c.gray(autostart?.mode === 'headless' ? 'background service' : 'login item')],
    ...(autostart?.location ? [['location', c.gray(shortPath(autostart.location))]] : [])
  ])
  if (autostart?.warning) out(`  ${icon.warn()} ${c.yellow(autostart.warning)}`)
  return 0
}

/**
 * Take the shim back off the PATH, and say what actually holds afterwards —
 * `cli:pathStatus` is the answer, not the request.
 */
async function removeCliPath(client) {
  const before = await client.invoke('cli:pathStatus', process.env.PATH ?? null).catch(() => null)
  if (!before?.installed) {
    out(c.gray('  the wfc command is not installed'))
    return 0
  }
  out(c.gray(`  ${shortPath(before.target)}`))
  if (!(await confirm('  remove it? you can install it again from here', false))) return 0
  await client.invoke('cli:uninstallPath')
  const after = await client.invoke('cli:pathStatus', process.env.PATH ?? null).catch(() => null)
  if (after?.installed) {
    out(`${icon.fail()} ${c.red('still installed')}`)
    return 1
  }
  out(`${icon.ok()} removed`)
  // A shell that has already resolved `wfc` keeps its cached answer until
  // it is told otherwise, so the command appearing to still exist is expected
  // rather than a failed removal.
  out(c.gray('  your current shell may still remember it — open a new one, or: hash -r'))
  return 0
}

/** Unregister autostart, then report what the OS says, not what we asked. */
async function removeAutostart(client) {
  const before = await client.invoke('service:status').catch(() => null)
  if (!before?.active) {
    out(c.gray('  autostart is not registered'))
    return 0
  }
  if (!(await confirm('  remove the autostart registration?', false))) return 0
  const after = await client.invoke('service:uninstall').catch(() => null)
  if (after?.active) {
    out(`${icon.fail()} ${c.red('still registered')}`)
    if (after.warning) out(c.gray(`  ${after.warning}`))
    return 1
  }
  out(`${icon.ok()} removed ${c.gray(`(${after?.mechanism ?? before.mechanism})`)}`)
  return 0
}

/**
 * What the daemon actually knows about the phone.
 *
 * The fields are `pairing.*` and `tunnel.*` — this used to read `device.name`,
 * `pairedAt` and `connected` off the top level, none of which exist, so a live
 * iPhone rendered as "Phone / — / offline". A view whose every row is a
 * fallback is worse than no view: it does not look broken, it looks like bad
 * news.
 */
async function mobileStatus(client) {
  const status = await client.invoke('mobile:status').catch(() => null)
  heading('Phone')
  if (!status?.paired) {
    out(c.gray('  no phone paired'))
    out(c.gray('  pair one from here, or: wfc pair phone --code'))
    return 0
  }
  const bridge = status.bridge ?? {}
  const BRIDGE = {
    connected: c.green('connected'),
    connecting: c.gray('connecting'),
    reconnecting: c.yellow('reconnecting'),
    error: c.red('error'),
    idle: c.gray('off')
  }
  for (const p of status.phones ?? []) {
    const model = [p.model, p.osVersion].filter(Boolean).join(' · ')
    keyValue([
      ['device', String(p.name || 'Phone')],
      ...(model ? [['model', c.gray(model)]] : []),
      ...(p.appVersion ? [['app', c.gray(String(p.appVersion))]] : []),
      ['paired', p.pairedAt ? new Date(p.pairedAt).toLocaleString() : c.gray('—')],
      ['last seen', p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString() : c.gray('never')],
      ['app open', p.connected ? c.green('yes — on the bridge') : c.gray('no')]
    ])
    out()
  }
  keyValue([
    ['org bridge', BRIDGE[bridge.status] ?? c.gray(String(bridge.status ?? 'off'))],
    ['api', c.gray(String(status.apiBase ?? '—'))]
  ])
  if (bridge.lastError) out(`  ${icon.warn()} ${c.yellow(String(bridge.lastError))}`)
  return 0
}

async function mobileUnpair(client) {
  if (!(await confirm(c.red('  unpair this phone entirely?'), false))) return 0
  await client.invoke('mobile:unpair')
  out(`${icon.ok()} unpaired`)
  return 0
}

/**
 * Per-model reasoning effort — the brain button, as a menu.
 *
 * Effort is stored per MODEL, not per provider, and which levels a model
 * honours is a property of the model. Both facts live in the daemon
 * (reasoning.ts), so this asks rather than guesses: a menu offering "max" to a
 * model that has no max is a setting that silently does nothing.
 */
async function reasoningEffort(client) {
  const snapshot = await client.invoke('cli:snapshot').catch(() => ({}))
  const provider = snapshot?.llm?.brainProvider
  const model = snapshot?.llm?.brainModel
  heading('Reasoning effort')
  if (!provider || !model) {
    out(c.yellow('  no brain is configured yet'))
    return 1
  }
  const info = await client.invoke('runtime:reasoningModes', { provider, model }).catch(() => null)
  const modes = info?.modes ?? []
  keyValue([
    ['model', c.bold(String(model))],
    ['provider', c.gray(String(provider))]
  ])
  out()
  if (modes.length <= 1) {
    out(c.gray(`  ${model} has no reasoning control — it thinks the same way every turn`))
    return 0
  }
  const LABELS = {
    off: 'Off — answer directly',
    on: 'On — think before answering',
    high: 'High — think hard',
    max: 'Max — think as long as it needs'
  }
  const chosen = await pick(modes, {
    label: (mode) =>
      `${LABELS[mode] ?? mode}${mode === info?.current ? c.green(' ' + g.current) : ''}`,
    prompt: `1-${modes.length}, blank keeps ${info?.current ?? 'the current one'}`
  })
  if (!chosen) return 0
  await client.invoke('runtime:setThinkingMode', model, chosen)
  out(`${icon.ok()} ${model} → ${LABELS[chosen] ?? chosen}`)
  return 0
}

// ─── Capabilities and skills ────────────────────────────────────────────────

/**
 * Install a capability from a folder or a zip.
 *
 * The desktop has an import button; the terminal had list-and-toggle only, so
 * a skill written on a laptop could not be put on a server at all — the whole
 * point of a server being that you put things on it.
 */
async function importCapability(client) {
  heading('Install a capability')
  out(wrapText(c.gray('A folder with a SKILL.md in it, or a .zip of one.'), 2))
  const answer = (await question(`  ${c.bold('path')}: `)).trim()
  if (!answer) return 0
  const resolved = answer.startsWith('~')
    ? path.join(os.homedir(), answer.slice(1))
    : path.resolve(answer)
  if (!(await fs.stat(resolved).catch(() => null))) {
    out(`${icon.fail()} ${c.red(`nothing at ${shortPath(resolved)}`)}`)
    return 1
  }
  const result = await client
    .invoke('cerebellum:importCapability', resolved)
    .catch((error) => ({ ok: false, error: error?.message }))
  if (result?.ok === false) {
    out(`${icon.fail()} ${c.red(result.error ?? result.reason ?? 'import failed')}`)
    return 1
  }
  out(`${icon.ok()} installed ${c.bold(result?.name ?? shortPath(resolved))}`)
  out(c.gray('  it is live now — no restart'))
  return 0
}

/** Remove a capability that was installed rather than built in. */
async function deleteCapability(client) {
  const all = await client.invoke('cerebellum:listCapabilities').catch(() => [])
  // Core capabilities cannot be removed any more than they can be turned off.
  const removable = all.filter((cap) => cap.locked !== true && cap.core !== true)
  heading('Remove a capability')
  if (removable.length === 0) {
    out(c.gray('  nothing removable — the rest are core'))
    return 0
  }
  const victim = await pick(removable, {
    label: (cap) =>
      `${cap.name}${cap.description ? c.gray(`  ${cap.description.slice(0, 60)}`) : ''}`
  })
  if (!victim) return 0
  if (!(await confirm(c.red(`  delete ${c.bold(victim.name)}? its files go too`), false))) return 0
  const result = await client
    .invoke('cerebellum:deleteCapability', victim.name)
    .catch((error) => ({ ok: false, error: error?.message }))
  if (result?.ok === false) {
    out(`${icon.fail()} ${c.red(result.error ?? 'failed')}`)
    return 1
  }
  out(`${icon.ok()} removed ${victim.name}`)
  return 0
}

/** Re-read every capability from disk — after editing one by hand over SSH. */
async function reloadCapabilities(client) {
  const before = await client.invoke('cerebellum:listCapabilities').catch(() => [])
  await client.invoke('cerebellum:reload').catch(() => undefined)
  const after = await client.invoke('cerebellum:listCapabilities').catch(() => [])
  out(`${icon.ok()} reloaded ${c.gray(`${after.length} capabilities`)}`)
  const added = after.filter((cap) => !before.some((prev) => prev.name === cap.name))
  const gone = before.filter((cap) => !after.some((next) => next.name === cap.name))
  for (const cap of added) out(c.green(`  + ${cap.name}`))
  for (const cap of gone) out(c.gray(`  - ${cap.name}`))
  return 0
}

/** The servers, as they stand. */
async function mcpList(client) {
  const servers = await client.invoke('mcp:list').catch(() => [])
  heading(`MCP servers ${c.gray(`(${servers.length})`)}`)
  if (servers.length === 0) {
    out(c.gray('  none connected'))
    return 0
  }
  table(
    ['name', 'state', 'tools', 'target'],
    servers.map((server) => [
      server.name ?? server.id,
      server.enabled === false
        ? c.gray('off')
        : server.status === 'ready'
          ? c.green('ready')
          : c.yellow(server.status ?? 'connecting'),
      String(server.toolCount ?? server.tools?.length ?? 0),
      c.gray(String(server.target ?? '').slice(0, 40))
    ])
  )
  return 0
}

/**
 * Add an MCP server — with the two things most real ones need.
 *
 * Command servers usually want environment variables (an API token is the
 * common case) and hosted ones usually want a header. `mcp:add` has taken both
 * all along; the terminal simply never asked, so any server needing either was
 * added, failed to connect, and gave no clue which piece was missing. Both
 * prompts are skipped by pressing enter, so the simple case stays two lines.
 */
async function mcpAdd(client) {
  heading('Add an MCP server')
  const target = (
    await question(`  ${c.bold('command or URL')} ${c.dim('(e.g. npx -y @scope/server)')}: `)
  ).trim()
  if (!target) return 0
  const name = (await question(`  ${c.dim('name, blank derives one')}: `)).trim()

  const isUrl = /^https?:\/\//i.test(target)
  const env = isUrl ? undefined : await keyValuePairs('environment variables', 'FOO=bar')
  const headers = isUrl
    ? (await keyValuePairs('headers', 'Authorization: Bearer …')).map(([key, value]) => ({
        key,
        value,
        // Anything carrying a credential is marked so the listing masks it.
        sensitive: /authorization|token|key|secret/i.test(key)
      }))
    : undefined

  const result = await client.invoke('mcp:add', {
    target,
    name: name || undefined,
    env: env && env.length ? Object.fromEntries(env) : undefined,
    headers: headers && headers.length ? headers : undefined
  })
  if (result?.ok === false) {
    out(`${icon.fail()} ${c.red(result.error ?? 'failed')}`)
    return 1
  }
  out(`${icon.ok()} added ${result?.server?.name ?? name ?? target}`)
  if (result?.server?.state === 'needs-auth') {
    out(c.gray('  it needs sign-in — use "Authorize one" on this card'))
  }
  return 0
}

/** Collect `k=v` / `k: v` lines until a blank one. */
async function keyValuePairs(what, example) {
  out(c.gray(`  ${what} — one per line, blank when done ${c.dim(`(${example})`)}`))
  const pairs = []
  for (;;) {
    const line = (await question(`  ${c.dim(what.slice(0, -1) ?? what)}: `)).trim()
    if (!line) return pairs
    const at = line.search(/[=:]/)
    if (at <= 0) {
      out(c.yellow('    needs a name and a value — try NAME=value'))
      continue
    }
    pairs.push([line.slice(0, at).trim(), line.slice(at + 1).trim()])
  }
}

/** OAuth sign-in for a hosted server that asked for it. */
async function mcpAuthorize(client, server) {
  const result = await client
    .invoke('mcp:authorize', server.id)
    .catch((error) => ({ ok: false, error: error?.message }))
  if (result?.ok === false) {
    out(`${icon.fail()} ${c.red(result.error ?? 'failed')}`)
    return 1
  }
  out(`${icon.ok()} ${server.name ?? server.id} authorized`)
  return 0
}

/** Replace a server's headers — the hosted equivalent of rotating a key. */
async function mcpHeaders(client, server) {
  const headers = (await keyValuePairs('headers', 'Authorization: Bearer …')).map(
    ([key, value]) => ({ key, value, sensitive: /authorization|token|key|secret/i.test(key) })
  )
  const result = await client
    .invoke('mcp:setHeaders', server.id, headers)
    .catch((error) => ({ ok: false, error: error?.message }))
  if (result?.ok === false) {
    out(`${icon.fail()} ${c.red(result.error ?? 'failed')}`)
    return 1
  }
  out(`${icon.ok()} ${headers.length} header${headers.length === 1 ? '' : 's'} set`)
  return 0
}

/** Pick one server, then do one thing to it. */
function mcpOne(title, run) {
  return async function act(client) {
    const servers = await client.invoke('mcp:list').catch(() => [])
    heading(title)
    if (servers.length === 0) {
      out(c.gray('  none connected'))
      return 0
    }
    const chosen = await pick(servers, {
      label: (server) =>
        `${server.name ?? server.id}${server.enabled === false ? c.gray(' · off') : ''}`
    })
    if (!chosen) return 0
    return run(client, chosen)
  }
}

const mcpToggle = mcpOne('Turn a server on or off', async (client, server) => {
  await client.invoke('mcp:setEnabled', server.id, server.enabled === false)
  out(`${icon.ok()} ${server.name} ${server.enabled === false ? 'on' : 'off'}`)
  return 0
})

const mcpTest = mcpOne('Test a server', async (client, server) => {
  const result = await client.invoke('mcp:test', server.id).catch(() => ({ ok: false }))
  out(
    result?.ok
      ? `${icon.ok()} ${server.name} responded ${c.gray(`(${result.toolCount ?? 0} tools)`)}`
      : `${icon.fail()} ${c.red(result?.error ?? 'no response')}`
  )
  return result?.ok ? 0 : 1
})

const mcpRemove = mcpOne('Remove a server', async (client, server) => {
  if (!(await confirm(`  remove ${c.bold(server.name ?? server.id)}?`, false))) return 0
  await client.invoke('mcp:remove', server.id)
  out(`${icon.ok()} removed ${server.name ?? server.id}`)
  return 0
})

// ─── Knowledge ──────────────────────────────────────────────────────────────

/** The last-run records the Knowledge cards show. Reads only. */
function knowledgeRuns(kind) {
  return async function lastRuns(client) {
    const runs = await client.invoke('runtime:getCompactionRuns').catch(() => ({}))
    heading(kind === 'reflection' ? 'Reflection' : 'Compaction')
    const rows =
      kind === 'reflection'
        ? [
            ['nightly reflection', runs.reflection],
            ['deep clean', runs.deepClean]
          ]
        : [
            ['daily compaction', runs.daily],
            ['weekly consolidation', runs.weekly]
          ]
    keyValue(
      rows.map(([name, run]) => [
        name,
        run?.at
          ? `${new Date(run.at).toLocaleString()}${run.ok === false ? c.red(' · failed') : ''}`
          : c.gray('never')
      ])
    )
    return 0
  }
}

/** Run one of the nightly jobs now, on its own. */
function runNow(channel, name) {
  return async function start(client) {
    out(c.gray(`  ${name} — running now, in the background`))
    const result = await client
      .invoke(channel)
      .catch((error) => ({ ok: false, error: error?.message }))
    if (result?.ok === false) {
      out(`${icon.fail()} ${c.red(result.error ?? 'failed to start')}`)
      return 1
    }
    out(`${icon.ok()} done`)
    return 0
  }
}

// ─── Data ───────────────────────────────────────────────────────────────────

/**
 * What is on disk. A VIEW — looking at your disk usage is not the first step
 * of erasing it, and pairing the two put a y/N about wiping the workspace in
 * front of anyone who only wanted the numbers.
 */
async function dataUsage(client) {
  const analytics = await client.invoke('data:getAnalytics').catch(() => null)
  heading('Disk usage')
  if (!analytics) {
    out(c.gray('  unavailable'))
    return 1
  }
  // The Data panel's own six metrics, computed its way. Printing every numeric
  // field instead was how "cpuPercent" came out as "0.0968 B" — bytes is not a
  // unit that applies to a percentage or a core count, and a formatter applied
  // by default rather than by meaning will always eventually say something
  // untrue.
  const cpuShare = analytics.cpuCount > 0 ? analytics.cpuPercent / analytics.cpuCount : null
  const cpu =
    cpuShare === null
      ? `${Number(analytics.cpuPercent ?? 0).toFixed(1)}%`
      : cpuShare > 0 && cpuShare < 0.05
        ? 'Less than 0.1%'
        : `${cpuShare.toFixed(1)}%`

  keyValue([
    ['workspace', bytes(analytics.workspaceBytes)],
    ['knowledge', bytes(analytics.hippocampusBytes)],
    ['corpus', bytes(analytics.corpusBytes)],
    ['prefrontal', bytes(analytics.prefrontalBytes)],
    ['ram', `${bytes(analytics.ramBytes)} / ${bytes(analytics.totalRamBytes)}`],
    ['cpu', cpu]
  ])

  if (analytics.totalDiskBytes > 0) {
    const used = analytics.totalDiskBytes - analytics.freeDiskBytes
    const percent = Math.round((used / analytics.totalDiskBytes) * 100)
    out()
    keyValue([
      [
        'disk',
        `${bytes(used)} of ${bytes(analytics.totalDiskBytes)} used ${c.gray(`${percent}%`)}`
      ],
      ['free', bytes(analytics.freeDiskBytes)]
    ])
  }
  return 0
}

/** Erase everything. Its own row, and it asks before it does anything. */
async function factoryReset(client) {
  heading('Factory reset')
  out(wrapText(c.red('This erases the workspace: conversations, knowledge, settings, keys.'), 2))
  out(c.gray('  It cannot be undone from here.'))
  out()
  if (!(await confirm(c.red('  factory reset this machine?'), false))) {
    out(c.gray('  nothing changed'))
    return 0
  }
  // Two gates, and the second one has to be typed. A single y/N on a
  // destructive, unrecoverable action is one stray keystroke from a wiped
  // workspace — and this one runs on servers reached over SSH.
  const typed = (await question(`  ${c.dim('type RESET to confirm')}: `)).trim()
  if (typed !== 'RESET') {
    out(c.gray('  nothing changed'))
    return 0
  }
  await client.invoke('app:factoryReset')
  out(`${icon.ok()} workspace reset`)
  return 0
}

// ─── Test buttons ───────────────────────────────────────────────────────────

/**
 * The "Test connection" every service panel has.
 *
 * The credential comes from the daemon's own config, never from the user
 * retyping it: the CLI only ever sees a mask, the desktop panel tests what is
 * in its form, and the equivalent here is testing what is on disk. It stays
 * in this process and is never printed.
 */
function tester(title, run) {
  return async function test(client) {
    heading(title)
    out(c.gray('  testing…'))
    const result = await run(client).catch((error) => ({ ok: false, error: error?.message }))
    if (result?.ok === false || result?.passed === false) {
      out(`${icon.fail()} ${c.red(result?.error ?? result?.kind ?? 'failed')}`)
      return 1
    }
    out(`${icon.ok()} ${c.green(result?.detail ?? 'works')}`)
    return 0
  }
}

// Brave Search is provided by the organization (one key behind the API's
// /v1/search lane), so there is no key here to test — the check reads the
// lane's live status and this account's allowance.
const testBrave = tester('Brave Search', async (client) => {
  const status = await client.invoke('brave:status', { refresh: true })
  if (status?.state !== 'ready') {
    const why = {
      disabled: 'turned off by your organization',
      unconfigured: 'not set up yet by your organization',
      signed_out: 'sign in first',
      unreachable: `cannot reach your organization${status?.error ? ` (${status.error})` : ''}`
    }
    return { ok: false, error: why[status?.state] ?? 'lane status unknown' }
  }
  const cap = status.dailyCap > 0 ? String(status.dailyCap) : 'unlimited'
  return {
    ok: true,
    detail: `provided by your organization — ${status.usedToday} of ${cap} searches used today, $${status.pricePerQueryUsd.toFixed(3)} each`
  }
})

const testExtension = tester('Browser Extension', async (client) => {
  const result = await client.invoke('browserExtension:testConnection', null)
  const passed = result?.passed ?? 0
  const steps = result?.steps ?? result?.results?.length ?? 0
  return {
    ok: steps > 0 && passed === steps,
    error: steps === 0 ? 'no browser is connected' : `${passed}/${steps} checks passed`,
    detail: `${passed}/${steps} checks passed`
  }
})

/**
 * The local speech engines. Both panels are an install button plus a status
 * line, and both installs are long — the CLI's honest form is to say what is
 * there, then run it in the foreground and report what came back.
 */
function engine(kind, title) {
  return async function manageEngine(client) {
    const status = await client.invoke(`${kind}:installStatus`).catch(() => null)
    heading(title)
    keyValue([
      ['installed', status?.installed ? c.green('yes') : c.yellow('no')],
      ...(status?.version ? [['version', c.gray(String(status.version))]] : []),
      ...(status?.path ? [['path', c.gray(shortPath(String(status.path)))]] : [])
    ])
    out()
    if (status?.installed) {
      out(c.gray('  nothing to do — reinstall only if it stopped working'))
    }
    if (
      !(await confirm(`  ${status?.installed ? 'reinstall' : 'install'} the engine now?`, false))
    ) {
      return 0
    }
    out(c.gray('  installing — this downloads a few hundred MB and takes a while'))
    const result = await client
      .invoke(`${kind}:install`)
      .catch((error) => ({ ok: false, error: error?.message }))
    if (result?.ok === false) {
      out(`${icon.fail()} ${c.red(result.error ?? 'install failed')}`)
      return 1
    }
    out(`${icon.ok()} installed`)
    return 0
  }
}

/**
 * Rebuild the usage ledger from the corpus. The desktop panel's Sync button —
 * the fix for a report that has drifted, which is exactly the thing someone
 * doubts when they are reading the numbers from a terminal.
 */
/** Where the extension lives, and whether a browser is actually talking to us. */
async function extensionStatus(client) {
  const [status, extensionPath, config] = await Promise.all([
    client.invoke('browserExtension:status').catch(() => null),
    client.invoke('browserExtension:getExtensionPath').catch(() => null),
    client.invoke('browserExtension:getConfig').catch(() => null)
  ])
  heading('Browser extension')
  keyValue([
    ['server', status?.running ? c.green('listening') : c.gray('off')],
    ['port', c.gray(String(config?.port ?? status?.port ?? '—'))],
    [
      'browsers',
      status?.clients?.length
        ? status.clients.map((client_) => client_.browser ?? client_.id).join(', ')
        : c.gray('none connected')
    ],
    ['load from', c.gray(shortPath(String(extensionPath ?? '—')))]
  ])
  out()
  out(
    wrapText(
      c.gray(
        'Load that folder as an unpacked extension in the browser (chrome://extensions → Developer mode → Load unpacked). On a headless box there is no browser to load it into — the extension is for a machine with a screen.'
      ),
      2
    )
  )
  return 0
}

async function usageSync(client) {
  out(c.gray('  re-reading every logged turn…'))
  const result = await client
    .invoke('usage:sync')
    .catch((error) => ({ ok: false, error: error?.message }))
  if (result?.ok === false) {
    out(`${icon.fail()} ${c.red(result.error ?? 'failed')}`)
    return 1
  }
  out(`${icon.ok()} ledger rebuilt`)
  return 0
}

// ─── Variables and capabilities ─────────────────────────────────────────────

async function setVariable(client) {
  const current = await client.invoke('variables:list').catch(() => [])
  heading('Set a variable')
  const name = (await question(`  ${c.bold('name')}: `)).trim()
  if (!name) return 0
  const existing = current.find((entry) => entry.name === name)
  // A variable already marked sensitive stays hidden while it is retyped —
  // the flag is about the value, not about which screen is editing it.
  const value = (
    await question(`  ${c.bold('value')}${existing?.sensitive ? c.dim(' (hidden)') : ''}: `, {
      hidden: existing?.sensitive === true
    })
  ).trim()
  if (!value) {
    out(c.gray('  nothing entered — unchanged'))
    return 0
  }
  const next = current.filter((entry) => entry.name !== name)
  next.push({ name, value, sensitive: existing?.sensitive === true })
  await client.invoke('variables:save', next)
  out(`${icon.ok()} ${name}`)
  return 0
}

async function removeVariable(client) {
  const current = await client.invoke('variables:list').catch(() => [])
  heading('Remove a variable')
  if (current.length === 0) {
    out(c.gray('  none'))
    return 0
  }
  const victim = await pick(current, { label: (entry) => entry.name })
  if (!victim) return 0
  await client.invoke(
    'variables:save',
    current.filter((entry) => entry.name !== victim.name)
  )
  out(`${icon.ok()} removed ${victim.name}`)
  return 0
}

async function toggleCapability(client) {
  const list = await client.invoke('cerebellum:listCapabilities').catch(() => [])
  heading('Turn a capability on or off')
  // Core capabilities accept the call and stay on, so offering them is
  // offering a button that does nothing.
  const switchable = list.filter((capability) => !capability.core)
  if (switchable.length === 0) {
    out(c.gray('  nothing switchable'))
    return 0
  }
  const chosen = await pick(switchable, {
    label: (capability) =>
      `${String(capability.name).padEnd(22)}${capability.enabled ? c.green('on') : c.gray('off')}`
  })
  if (!chosen) return 0
  return capabilities(client, [chosen.enabled ? 'off' : 'on', chosen.name])
}

// ─── The registry ───────────────────────────────────────────────────────────

/**
 * Flows, keyed by the card they belong to.
 *
 * `view: true` marks one that only LOOKS — no writes, no confirmations, no
 * chance of changing anything. Views are listed before actions on their card
 * and drawn without the chevron, because the distinction is the one that
 * matters when you are scanning a menu on a machine you care about: reading
 * your disk usage should never be step one of erasing it, and it used to be.
 */
export const ACTIONS = [
  { section: 'model.chat', label: 'Reasoning effort', run: reasoningEffort },

  {
    section: 'channels.cli',
    label: 'The wfc command and autostart',
    view: true,
    run: cliStatus
  },
  {
    section: 'channels.cli',
    label: 'Install the wfc command on your PATH',
    run: (client) => pathCommand(client, ['install'])
  },
  // Every install has its removal beside it. A card that can only add leaves
  // the terminal as the only way back out of a change the card itself made.
  { section: 'channels.cli', label: 'Remove the wfc command', run: removeCliPath },
  {
    section: 'channels.cli',
    label: 'Register autostart',
    run: (client) => service(client, ['install'])
  },
  { section: 'channels.cli', label: 'Remove autostart', run: removeAutostart },
  { section: 'channels.mobile', label: 'Paired phone', view: true, run: mobileStatus },
  {
    section: 'channels.mobile',
    label: 'Pair a phone — QR code',
    run: (client) => pair(client, ['phone'])
  },
  {
    section: 'channels.mobile',
    label: 'Pair a phone — typed code (for a headless box)',
    run: (client) => pair(client, ['phone', '--code'])
  },
  { section: 'channels.mobile', label: 'Unpair', run: mobileUnpair },

  { section: 'services.brave', label: 'Check the org lane', run: testBrave },
  {
    section: 'services.tts',
    label: 'Engine — status and install',
    run: engine('tts', 'Text-to-Speech')
  },
  {
    section: 'services.stt',
    label: 'Engine — status and install',
    run: engine('stt', 'Speech-to-Text')
  },
  {
    section: 'channels.browser',
    label: 'Connection and install path',
    view: true,
    run: extensionStatus
  },
  { section: 'channels.browser', label: 'Test the connection', run: testExtension },

  { section: 'mcp.servers', label: 'Connected servers', view: true, run: mcpList },
  { section: 'mcp.servers', label: 'Add a server', run: mcpAdd },
  { section: 'mcp.servers', label: 'Turn one on or off', run: mcpToggle },
  { section: 'mcp.servers', label: 'Test one', run: mcpTest },
  {
    section: 'mcp.servers',
    label: 'Authorize one (OAuth)',
    run: mcpOne('Authorize', mcpAuthorize)
  },
  { section: 'mcp.servers', label: 'Set headers on one', run: mcpOne('Headers', mcpHeaders) },
  { section: 'mcp.servers', label: 'Remove one', run: mcpRemove },

  {
    section: 'variables.list',
    label: 'Prompt variables',
    view: true,
    run: (client) => variables(client, [])
  },
  { section: 'variables.list', label: 'Set one', run: setVariable },
  { section: 'variables.list', label: 'Remove one', run: removeVariable },

  {
    section: 'capabilities.list',
    label: 'Capabilities',
    view: true,
    run: (client) => capabilities(client, [])
  },
  { section: 'capabilities.list', label: 'Turn one on or off', run: toggleCapability },
  {
    section: 'capabilities.list',
    label: 'Install one from a folder or zip',
    run: importCapability
  },
  { section: 'capabilities.list', label: 'Remove one', run: deleteCapability },
  { section: 'capabilities.list', label: 'Reload them from disk', run: reloadCapabilities },

  {
    section: 'knowledge.compaction',
    label: 'Last runs',
    view: true,
    run: knowledgeRuns('compaction')
  },
  {
    section: 'knowledge.reflection',
    label: 'Last runs',
    view: true,
    run: knowledgeRuns('reflection')
  },
  {
    section: 'knowledge.reflection',
    label: 'Run a reflection now',
    run: runNow('runtime:runReflectionNow', 'reflection')
  },
  {
    section: 'knowledge.reflection',
    label: 'Run a deep clean now',
    run: runNow('runtime:runDeepCleanNow', 'deep clean')
  },

  { section: 'usage.report', label: 'Tokens and cost', view: true, run: usageReport },
  { section: 'usage.report', label: 'Re-sync the ledger', run: usageSync },
  { section: 'data.workspace', label: 'Disk usage', view: true, run: dataUsage },
  { section: 'data.workspace', label: 'Factory reset', run: factoryReset }
]

/**
 * Usage, with the range picker the panel has.
 *
 * The ids are `UsageTimeRange`, not paraphrases of it. An earlier version
 * offered "month", which is not one of them: the handler built a Date from
 * undefined and the rejection unwound the whole browser. Ranges the app does
 * not define do not silently mean something near enough — they crash.
 */
async function usageReport(client) {
  heading('Usage')
  const range = await pick(USAGE_RANGES, {
    label: (entry) => entry.label,
    prompt: 'pick a range, blank cancels'
  })
  if (!range) return 0
  return usage(client, range.value, {})
}

/** The flows on one card, in order. */
export function actionsFor(sectionId) {
  return ACTIONS.filter((action) => action.section === sectionId)
}
