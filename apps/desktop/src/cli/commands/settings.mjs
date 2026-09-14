/**
 * Reading and writing ONE setting, and the two list-shaped flows that are not
 * settings at all: prompt variables, capabilities.
 *
 * Everything here goes through the same handlers the desktop panels call. The
 * browser (settings-browser.mjs) walks the page → card → row hierarchy; this
 * file is what it calls once a row or a flow is chosen, and what scripts call
 * directly by id.
 */
import { c, heading, icon, out, pad, table, wrapText } from '../lib/ui.mjs'

/**
 * Names that mean "this is a credential". Matching on the NAME rather than
 * asking is deliberate: the desktop has a checkbox next to the field, and a
 * terminal prompt for every variable would be a question asked ten times to
 * catch the one that mattered.
 */
const SENSITIVE_NAME = /(key|token|secret|password|passwd|pwd|credential|auth)/i

export async function getSetting(client, id, { json } = {}) {
  const cards = await client.invoke('cli:describeSettings')
  const card = cards.find((entry) => entry.id === id)
  if (!card) {
    out(c.red(`unknown setting: ${id}`))
    suggest(cards, id)
    return 1
  }
  if (json) {
    out(JSON.stringify(card, null, 2))
    return 0
  }
  heading(card.label)
  if (card.description) out(wrapText(c.gray(card.description), 2))
  out()
  const rows = [
    ['id', card.id],
    ['value', card.display]
  ]
  if (card.actual) rows.push(['registered', card.actual])
  if (card.options?.length) rows.push(['options', card.options.map((o) => o.value).join(', ')])
  const keyWidth = Math.max(...rows.map(([k]) => k.length))
  for (const [key, value] of rows) out(`  ${c.gray(pad(key, keyWidth))}  ${value}`)
  out()
  return 0
}

export async function setSetting(client, id, value) {
  const result = await client.invoke('cli:setSetting', { id, value })
  if (!result?.ok) {
    out(`${icon.fail()} ${c.red(result?.error ?? 'failed')}`)
    if (String(result?.error ?? '').startsWith('unknown setting')) {
      const cards = await client.invoke('cli:describeSettings')
      suggest(cards, id)
    }
    return 1
  }
  // Read back rather than echoing the input: the handler may normalize, and a
  // setting whose OS registration failed must not report success.
  const cards = await client.invoke('cli:describeSettings')
  const card = cards.find((entry) => entry.id === id)
  out(`${icon.ok()} ${c.bold(card?.label ?? id)} ${c.gray('→')} ${c.cyan(card?.display ?? value)}`)
  if (card?.actual) out(c.gray(`  registered: ${card.actual}`))
  return 0
}

function suggest(cards, id) {
  const needle = String(id).toLowerCase()
  const close = cards
    .map((card) => card.id)
    .filter((candidate) => candidate.toLowerCase().includes(needle.split('.').pop() ?? needle))
    .slice(0, 6)
  if (close.length > 0) {
    out(c.gray('  did you mean:'))
    for (const candidate of close) out(`    ${candidate}`)
  } else {
    out(c.gray('  list them all with: wfc settings list'))
  }
}

/** `wfc vars` — prompt variables, the one list the phone also edits. */
export async function variables(client, args) {
  const [sub, name, ...valueParts] = args
  const current = await client.invoke('variables:list').catch(() => [])
  if (!sub || sub === 'list') {
    heading('Variables')
    if (current.length === 0) {
      out(c.gray('  none'))
      return 0
    }
    table(
      ['name', 'value'],
      current.map((v) => [v.name, v.sensitive ? c.gray('•••••') : v.value])
    )
    return 0
  }
  if (sub === 'set') {
    if (!name) {
      out(c.red('usage: wfc vars set <name> <value>'))
      return 2
    }
    const value = valueParts.join(' ')
    const next = current.filter((v) => v.name !== name)
    /**
     * A variable whose name reads like a credential is stored sensitive, so
     * `wfc vars` masks it the way the desktop does. Every CLI-created
     * variable used to be `sensitive: false`, which meant a key put in from the
     * terminal printed in full on every later listing — the one surface where
     * the listing lands in scrollback.
     */
    const sensitive = SENSITIVE_NAME.test(name)
    next.push({ name, value, sensitive })
    if (sensitive) out(c.gray('  stored as a secret — it will be masked when listed'))
    await client.invoke('variables:save', next)
    out(`${icon.ok()} ${name}`)
    return 0
  }
  if (sub === 'rm' || sub === 'remove') {
    await client.invoke(
      'variables:save',
      current.filter((v) => v.name !== name)
    )
    out(`${icon.ok()} removed ${name}`)
    return 0
  }
  out(c.red(`unknown: wfc vars ${sub}`))
  return 2
}

/** `wfc capabilities` — the same list and toggles the panel shows. */
export async function capabilities(client, args) {
  const [sub, name] = args
  const list = await client.invoke('cerebellum:listCapabilities').catch(() => [])
  if (!sub || sub === 'list') {
    heading('Capabilities')
    table(
      ['name', 'tools', 'state', 'description'],
      list.map((cap) => [
        cap.name,
        String(cap.toolCount ?? 0),
        cap.core ? c.gray('core') : cap.enabled ? c.green('on') : c.gray('off'),
        String(cap.description ?? '').slice(0, 60)
      ])
    )
    out()
    out(c.gray('  wfc capabilities on|off <name>'))
    return 0
  }
  if (sub === 'on' || sub === 'off') {
    if (!name) {
      out(c.red(`usage: wfc capabilities ${sub} <name>`))
      return 2
    }
    try {
      await client.invoke('cerebellum:toggleCapability', name, sub === 'on')
    } catch (err) {
      out(`${icon.fail()} ${c.red(err.message)}`)
      return 1
    }
    // Read back: a locked core capability accepts the call and stays on, so
    // echoing the request would report a change that did not happen.
    const after = await client.invoke('cerebellum:listCapabilities').catch(() => [])
    const entry = after.find((cap) => cap.name === name)
    if (!entry) {
      out(`${icon.fail()} ${c.red(`unknown capability: ${name}`)}`)
      return 1
    }
    if (entry.enabled !== (sub === 'on')) {
      out(
        `${icon.warn()} ${c.yellow(`${name} is ${entry.enabled ? 'on' : 'off'}`)}` +
          (entry.core ? c.gray(' — core capabilities cannot be switched off') : '')
      )
      return 1
    }
    out(`${icon.ok()} ${name} ${sub}`)
    return 0
  }
  out(c.red(`unknown: wfc capabilities ${sub}`))
  return 2
}
