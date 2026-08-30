/**
 * automations — Wolffish manages its own heartbeat.
 *
 * Tools to list, create, edit, delete, check, and run the scheduled jobs
 * declared in brain/brainstem/heartbeat.md. Every job is a `## <schedule>`
 * heading plus a plain instruction body; the brainstem parses that file,
 * registers a cron job for each, and runs the body as an autonomous agent
 * turn when the job fires.
 *
 * All shared state — the heartbeat file, the live cron scheduler, the
 * schedule parser, the run-on-demand path — is reached through the
 * `automations` host bridge injected at init (PluginContext.automations),
 * NOT touched by hand here. That bridge is implemented over the very same
 * Brainstem the scheduler runs on, so the agent's view of "what automations
 * exist and when they fire" can never drift from the engine that fires them.
 */

// Automation-management bridge, injected at init by the main process.
let automations

const toolDefinitions = [
  {
    name: 'automation_list',
    description:
      "List every configured automation (heartbeat job): its schedule heading, the plain-English timing, the instruction it runs, whether the schedule is valid, and whether it's running right now. Use this before editing, deleting, or running one so you reference it by the correct number or label.",
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'automation_create',
    description:
      'Create a new automation that runs autonomously on a schedule. Writes a new entry to the heartbeat and registers it live. Provide the schedule (one of the exact forms) and the instruction to run when it fires.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['single', 'workflow'],
          description:
            "Which chat mode the automation runs in — 'single' or 'workflow'. Optional."
        },
        schedule: {
          type: 'string',
          description:
            'The schedule. YOU choose one-time vs recurring from the user\'s wording. ONE-TIME (runs once, then deletes itself) — use for "in 15 minutes", "in 2 days", "at 3pm", "tomorrow", "remind me once": "In (15m)" / "In (2h)" / "In (2d)" (relative — minutes, hours, or days), or "Once (2026-06-27 14:30)" (absolute, 24h local time). RECURRING — use for "every", "each", "daily", "from now on": "Every (5m)" / "Every (2h)", "Hourly (30)", "Daily (08:00)" / "Nightly (23:00)", "Weekday (09:00)", "Weekly (Monday 09:30)", "Monthly (1 09:00)", "Cron (0 9 * * 1,3,5)", or "Startup". Default to one-time for a specific future moment; only make it recurring when the user clearly wants repetition.'
        },
        instruction: {
          type: 'string',
          description:
            "The natural-language instruction to run when the job fires. Self-contained (the job has no chat context), with tools available and tool calls auto-approved. No markdown headings (no lines starting with '## ')."
        }
      },
      required: ['schedule', 'instruction']
    }
  },
  {
    name: 'automation_edit',
    description:
      "Change an existing automation's schedule and/or its instruction. Identify it by the 1-based number from automation_list or its exact schedule label. Provide schedule, instruction, or both — whatever you omit is kept.",
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['single', 'workflow'],
          description:
            "Which chat mode the automation runs in — 'single' or 'workflow'. Optional."
        },
        identifier: {
          type: 'string',
          description: 'The automation to edit — its number from automation_list, or its exact schedule label (e.g. "Daily (08:00)").'
        },
        schedule: {
          type: 'string',
          description: 'New schedule (same forms as automation_create). Omit to keep the current schedule.'
        },
        instruction: {
          type: 'string',
          description: 'New instruction body. Omit to keep the current instruction.'
        }
      },
      required: ['identifier']
    }
  },
  {
    name: 'automation_delete',
    description:
      'Permanently remove an automation so it stops firing. Identify it by the 1-based number from automation_list or its exact schedule label.',
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The automation to delete — its number from automation_list, or its exact schedule label.'
        }
      },
      required: ['identifier']
    }
  },
  {
    name: 'automation_check',
    description:
      'Check runtime status of the automations: which one (if any) is running right now, and how each one\'s last run went (completed, failed with the error, or skipped because another was running). Use this to verify an automation works or to review recent activity.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'automation_run',
    description:
      'Run an automation immediately instead of waiting for its schedule — the way to test one. It runs in the background as a sealed conversation; read the outcome with automation_check. Identify it by number or schedule label.',
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The automation to run now — its number from automation_list, or its exact schedule label.'
        }
      },
      required: ['identifier']
    }
  }
]

// ---------------------------------------------------------------------------
// automation_list
// ---------------------------------------------------------------------------

async function listAutomations() {
  if (!automations) return missingBridge()
  const raw = await loadHeartbeat()
  const blocks = parseActiveBlocks(raw)
  const live = automations.listJobs()

  if (blocks.length === 0) {
    return {
      success: true,
      output:
        'No automations are configured yet. Use `automation_create` to add one (see the "automations" skill for the schedule syntax).'
    }
  }

  const lines = [`## Automations (${blocks.length})`, '']
  for (const b of blocks) {
    const preview = automations.previewSchedule(b.label)
    const job = matchLiveJob(live, b)
    const valid = preview.ok
    const timing = valid ? preview.human : '⚠ invalid schedule — will NOT run'
    const runningTag = job && job.running ? ' · **running now**' : ''
    const modeTag = b.mode ? ` · mode: ${b.mode}` : ''
    lines.push(`${b.index}. **${b.label}** — ${timing}${runningTag}${modeTag}`)
    if (valid && preview.cron) lines.push(`   cron: \`${preview.cron}\``)
    lines.push(`   ${oneLine(b.body) || '(no instruction)'}`)
    // Attached files and working folders are part of what this automation IS —
    // the run sees both, so a list that hid them would misdescribe the job.
    for (const file of b.files ?? []) lines.push(`   file: \`${file}\``)
    for (const dir of b.dirs ?? []) lines.push(`   working folder: \`${dir}\``)
    if (job) lines.push(`   ${formatLastRun(job)}`)
    lines.push('')
  }
  lines.push(
    'Edit or delete by the number above (or the exact label). Memory compaction jobs are configured in Settings → Hippocampus and are not listed here.'
  )
  return { success: true, output: lines.join('\n').trim() }
}

// ---------------------------------------------------------------------------
// automation_create
// ---------------------------------------------------------------------------

async function createAutomation(args) {
  if (!automations) return missingBridge()
  const rawSchedule = typeof args?.schedule === 'string' ? args.schedule.trim() : ''
  const instruction = typeof args?.instruction === 'string' ? args.instruction.trim() : ''
  const modeArg = typeof args?.mode === 'string' ? args.mode.trim().toLowerCase() : ''
  const iconArg = typeof args?.icon === 'string' ? args.icon.trim() : ''

  if (!rawSchedule) return { success: false, error: 'automation_create: provide a `schedule`.' }
  if (!instruction) return { success: false, error: 'automation_create: provide an `instruction` to run.' }
  if (modeArg && modeArg !== 'single' && modeArg !== 'workflow') {
    return { success: false, error: "automation_create: `mode` must be 'single' or 'workflow'." }
  }
  // The icon rides the file as `icon: <emoji>` — one whitespace-free token.
  // A malformed pick falls back to the default rather than failing the create.
  const icon = /^\S{1,16}$/.test(iconArg) ? iconArg : '🫀'

  const badBody = checkInstruction(instruction)
  if (badBody) return { success: false, error: badBody }

  // "In (15m)" / "In (2h)" is sugar — resolve it to an absolute one-time
  // "Once (YYYY-MM-DD HH:MM)" now, so what's stored is reload-safe.
  const resolved = resolveSchedule(rawSchedule)
  if (resolved.error) return { success: false, error: `automation_create: ${resolved.error}` }
  const schedule = resolved.heading

  const preview = automations.previewSchedule(schedule)
  if (!preview.ok) return { success: false, error: `automation_create: ${preview.error}` }
  const onceGuard = preview.kind === 'once' ? checkOnceTime(preview.runAt) : null
  if (onceGuard) return { success: false, error: `automation_create: ${onceGuard}` }

  // Every automation is stamped with a mode at creation — the caller's pick,
  // else whatever chat mode the user is running right now.
  const mode = modeArg || (automations.getGlobalMode ? await automations.getGlobalMode() : 'single')

  const raw = await loadHeartbeat()
  const next = insertBlock(raw, normalizeHeading(schedule), composeBody({ mode, icon }, instruction))
  const result = await automations.writeHeartbeat(next)
  if (!result.ok) {
    return { success: false, error: `automation_create: couldn't save — ${result.error ?? 'unknown error'}` }
  }

  const isOnce = preview.kind === 'once'
  const tail = isOnce
    ? "It fires once, by itself, then deletes itself — don't `automation_run` it to \"test\" (that would consume it early; it still fires at its set time). It runs unattended with tool calls auto-approved."
    : 'Test it now with `automation_run` (runs in the background), then `automation_check` to see the result. It runs unattended with tool calls auto-approved; up to three automations run at once, and extra fires queue.'
  return {
    success: true,
    output: [
      `Created ${isOnce ? 'one-time ' : ''}automation "${normalizeHeading(schedule)}" — runs ${preview.human}.`,
      '',
      `It will run this instruction autonomously when it fires:`,
      `> ${oneLine(instruction)}`,
      '',
      tail
    ].join('\n')
  }
}

// ---------------------------------------------------------------------------
// automation_edit
// ---------------------------------------------------------------------------

async function editAutomation(args) {
  if (!automations) return missingBridge()
  const identifier = typeof args?.identifier === 'string' ? args.identifier.trim() : `${args?.identifier ?? ''}`.trim()
  const newSchedule = typeof args?.schedule === 'string' ? args.schedule.trim() : ''
  const newInstruction = typeof args?.instruction === 'string' ? args.instruction.trim() : ''
  const newMode = typeof args?.mode === 'string' ? args.mode.trim().toLowerCase() : ''

  if (!identifier) return { success: false, error: 'automation_edit: provide an `identifier` (number or label).' }
  if (!newSchedule && !newInstruction && !newMode) {
    return { success: false, error: 'automation_edit: provide a new `schedule`, `instruction`, or `mode`.' }
  }
  if (newMode && newMode !== 'single' && newMode !== 'workflow') {
    return { success: false, error: "automation_edit: `mode` must be 'single' or 'workflow'." }
  }

  const raw = await loadHeartbeat()
  const blocks = parseActiveBlocks(raw)
  const target = findTarget(blocks, identifier)
  if (target.error) return { success: false, error: target.error }

  // Resolve "In (...)" sugar to an absolute "Once (...)" before validating.
  let resolvedHeading = target.block.label
  if (newSchedule) {
    const resolved = resolveSchedule(newSchedule)
    if (resolved.error) return { success: false, error: `automation_edit: ${resolved.error}` }
    resolvedHeading = resolved.heading
    const preview = automations.previewSchedule(resolvedHeading)
    if (!preview.ok) return { success: false, error: `automation_edit: ${preview.error}` }
    const onceGuard = preview.kind === 'once' ? checkOnceTime(preview.runAt) : null
    if (onceGuard) return { success: false, error: `automation_edit: ${onceGuard}` }
  }
  if (newInstruction) {
    const badBody = checkInstruction(newInstruction)
    if (badBody) return { success: false, error: badBody }
  }

  const heading = normalizeHeading(resolvedHeading)
  const body = newInstruction || target.block.body
  // Preserve the block's mode stamp across edits unless explicitly changed;
  // the project binding and icon always survive a plugin rewrite.
  const mode = newMode || target.block.mode

  const next = applyEdit(
    raw,
    target.block,
    heading,
    composeBody(
      {
        mode,
        project: target.block.project,
        icon: target.block.icon,
        files: target.block.files,
        dirs: target.block.dirs
      },
      body
    )
  )
  const result = await automations.writeHeartbeat(next)
  if (!result.ok) {
    return { success: false, error: `automation_edit: couldn't save — ${result.error ?? 'unknown error'}` }
  }

  const preview = automations.previewSchedule(heading)
  return {
    success: true,
    output: `Updated automation "${heading}"${preview.ok ? ` — now runs ${preview.human}` : ''}. It runs unattended with tool calls auto-approved; up to three automations run at once, and extra fires queue. Verify with \`automation_check\` (or \`automation_run\` to test).`
  }
}

// ---------------------------------------------------------------------------
// automation_delete
// ---------------------------------------------------------------------------

async function deleteAutomation(args) {
  if (!automations) return missingBridge()
  const identifier = typeof args?.identifier === 'string' ? args.identifier.trim() : `${args?.identifier ?? ''}`.trim()
  if (!identifier) return { success: false, error: 'automation_delete: provide an `identifier` (number or label).' }

  const raw = await loadHeartbeat()
  const blocks = parseActiveBlocks(raw)
  const target = findTarget(blocks, identifier)
  if (target.error) return { success: false, error: target.error }

  const label = target.block.label
  const next = applyDelete(raw, target.block)
  const result = await automations.writeHeartbeat(next)
  if (!result.ok) {
    return { success: false, error: `automation_delete: couldn't save — ${result.error ?? 'unknown error'}` }
  }

  return { success: true, output: `Deleted automation "${label}". It will no longer fire.` }
}

// ---------------------------------------------------------------------------
// automation_check
// ---------------------------------------------------------------------------

async function checkAutomations() {
  if (!automations) return missingBridge()
  const live = automations.listJobs()

  // Detached procedure runs share the brainstem's run pool but are NOT
  // automations (ids namespaced "procedure:"). Don't report them here as
  // running automations — that would contradict the list below and hand the
  // user wrong status.
  const runningAutomations = automations
    .getRunningJobs()
    .filter((job) => !job.id.startsWith('procedure:'))

  const lines = ['## Automation status', '']
  if (runningAutomations.length > 0) {
    for (const job of runningAutomations) {
      lines.push(`▶ **Running now:** "${job.label}" — started ${relativeTime(job.startedAt)}.`)
    }
    lines.push(
      "Runs finish on their own and land in history; re-running automation_check won't speed them up, so don't poll in a loop — just tell the user they're still running."
    )
  } else {
    lines.push('Nothing is running right now.')
  }
  lines.push('')

  if (live.length === 0) {
    lines.push('No automations are configured.')
    return { success: true, output: lines.join('\n') }
  }

  lines.push(`### ${live.length} scheduled`)
  for (const job of live) {
    lines.push(`- **${job.label}** (${job.human}) — ${formatLastRun(job)}`)
  }
  return { success: true, output: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// automation_run
// ---------------------------------------------------------------------------

async function runAutomation(args) {
  if (!automations) return missingBridge()
  const identifier = typeof args?.identifier === 'string' ? args.identifier.trim() : `${args?.identifier ?? ''}`.trim()
  if (!identifier) return { success: false, error: 'automation_run: provide an `identifier` (number or label).' }

  // Resolve the identifier the SAME way automation_list/edit/delete do — against
  // the parsed file blocks — so a number means the same row the user just saw.
  // (Resolving against the live job list instead would skew the numbering
  // whenever an invalid-schedule heading exists, and run the wrong automation.)
  const raw = await loadHeartbeat()
  const blocks = parseActiveBlocks(raw)
  const target = findTarget(blocks, identifier)
  if (target.error) return { success: false, error: target.error }

  // Translate the chosen block to the live registered job (by id) so we run
  // exactly that one. A block with no live job is an unregistered/ghost entry.
  const job = matchLiveJob(automations.listJobs(), target.block)
  if (!job) {
    const preview = automations.previewSchedule(target.block.label)
    const why = preview.ok
      ? 'it is not registered with the scheduler yet — re-check automation_list.'
      : `its schedule is invalid (${preview.error}). Fix it with automation_edit, then run it.`
    return { success: false, error: `Can't run "${target.block.label}" — ${why}` }
  }

  const outcome = automations.runJobNow(job.id)
  if (!outcome.ok) return { success: false, error: `automation_run: ${outcome.error ?? 'could not run.'}` }
  // Accepted but not started, in two flavours that need OPPOSITE advice: a
  // queued fire runs by itself the moment a slot frees (re-running it only
  // coalesces and wastes a turn), while a coalesced one is already covered by
  // a fire of this same job in flight. Neither is a failure, and neither is
  // worth waiting on.
  if (!outcome.started) {
    const waiting =
      outcome.state === 'coalesced'
        ? `"${job.label}" is already in flight — this fire joined it rather than starting a second run.`
        : `"${job.label}" is queued — every run slot is busy (${outcome.running ?? 3} in progress; automations, procedures, compaction and reflection share the pool). It starts on its own as soon as one frees.`
    return {
      success: true,
      output: `${waiting} Do NOT re-run it or poll automation_check in a loop — tell the user it is lined up, and check once later only if they ask how it went.`
    }
  }
  return {
    success: true,
    output: `Started "${job.label}" in the background — it runs as its own sealed conversation and appears in history when it finishes. It runs to completion on its own. Do NOT call automation_check in a loop waiting for it: you can't pause between tool calls, so polling just burns turns and cannot make it finish any sooner. Reply to the user now that it's running. Only if they later ask how it went, call automation_check ONCE — or point them to the conversation in history.`
  }
}

// ---------------------------------------------------------------------------
// Heartbeat-file parsing & editing
// ---------------------------------------------------------------------------

/** Char ranges covered by HTML comments — the example block must stay untouched. */
function commentRanges(raw) {
  const ranges = []
  const re = /<!--[\s\S]*?-->/g
  let m
  while ((m = re.exec(raw)) !== null) ranges.push([m.index, m.index + m[0].length])
  return ranges
}

function inComment(pos, ranges) {
  return ranges.some(([s, e]) => pos >= s && pos < e)
}

/**
 * Parse the ACTIVE automations out of the raw heartbeat.md: every `## heading`
 * that is NOT inside an HTML comment, with its instruction body and the exact
 * char offsets needed to edit/delete it in place. Mirrors how the brainstem
 * detects headings (comment-stripped, `## ` prefix), but keeps offsets so edits
 * never disturb the surrounding prose or the commented example block.
 */
function parseActiveBlocks(raw) {
  const ranges = commentRanges(raw)
  const headings = []
  let offset = 0
  for (const line of raw.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m && !inComment(offset, ranges)) {
      headings.push({ label: m[1], headingStart: offset, lineEnd: offset + line.length + 1 })
    }
    offset += line.length + 1
  }

  const blocks = []
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    let end = i + 1 < headings.length ? headings[i + 1].headingStart : raw.length
    // Never let a body swallow the example comment block.
    for (const [s] of ranges) {
      if (s >= h.lineEnd && s < end) end = s
    }
    const rawBody = raw
      .slice(h.lineEnd, end)
      .replace(/^---+\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const { body, mode, project, icon, files, dirs } = splitMarkers(rawBody)
    blocks.push({
      index: i + 1,
      label: h.label,
      body,
      mode,
      project,
      icon,
      files,
      dirs,
      headingStart: h.headingStart,
      end
    })
  }
  return blocks
}

/**
 * Collapse runs of 3+ newlines to 2, but ONLY outside HTML comments — the
 * commented example block contains intentional double-blank-lines and must
 * survive an edit byte-for-byte. Tidies the active region's spacing without
 * ever touching the examples.
 */
function tidyOutsideComments(raw) {
  const re = /<!--[\s\S]*?-->/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(raw)) !== null) {
    out += raw.slice(last, m.index).replace(/\n{3,}/g, '\n\n')
    out += m[0]
    last = m.index + m[0].length
  }
  out += raw.slice(last).replace(/\n{3,}/g, '\n\n')
  return out
}

/**
 * Per-job settings ride the block body's LEADING non-empty lines as plain
 * markers — `mode: single|workflow`, `project: <id>`, `icon: <emoji>` — in
 * any order, blank lines allowed between them. The engine (brainstem
 * splitMarkers) and the Automations page parse and strip the same lines —
 * keep the three parsers in sync. Bodies exposed by parseActiveBlocks are
 * always CLEAN (markers split off), so label+body matching against live
 * jobs stays symmetric, and edits COMPOSE the markers back so a plugin
 * rewrite never drops a job's project binding, icon, attached files or
 * working directories.
 */
const MODE_MARKER_RE = /^mode:\s*(single|workflow)\s*$/i
const PROJECT_MARKER_RE = /^project:\s*(\S+)\s*$/i
const ICON_MARKER_RE = /^icon:\s*(\S+)\s*$/i
// Attached files and working directories — REPEATABLE, and their value is a
// whole path (spaces and all), so these take the rest of the line.
const FILE_MARKER_RE = /^file:\s*(.+?)\s*$/i
const DIR_MARKER_RE = /^dir:\s*(.+?)\s*$/i

function splitMarkers(body) {
  const lines = body.split('\n')
  let mode = null
  let project = null
  let icon = null
  const files = []
  const dirs = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (line === '') {
      i++
      continue
    }
    const m = MODE_MARKER_RE.exec(line)
    if (m) {
      mode = m[1].toLowerCase()
      i++
      continue
    }
    const p = PROJECT_MARKER_RE.exec(line)
    if (p) {
      project = p[1]
      i++
      continue
    }
    const ic = ICON_MARKER_RE.exec(line)
    if (ic) {
      icon = ic[1]
      i++
      continue
    }
    const f = FILE_MARKER_RE.exec(line)
    if (f) {
      files.push(f[1])
      i++
      continue
    }
    const d = DIR_MARKER_RE.exec(line)
    if (d) {
      dirs.push(d[1])
      i++
      continue
    }
    break
  }
  return { body: lines.slice(i).join('\n').trim(), mode, project, icon, files, dirs }
}

function composeBody(markers, body) {
  const lines = []
  if (markers.mode) lines.push(`mode: ${markers.mode}`)
  if (markers.project) lines.push(`project: ${markers.project}`)
  if (markers.icon) lines.push(`icon: ${markers.icon}`)
  for (const file of markers.files ?? []) lines.push(`file: ${file}`)
  for (const dir of markers.dirs ?? []) lines.push(`dir: ${dir}`)
  return lines.length > 0 ? `${lines.join('\n')}\n\n${body.trim()}` : body.trim()
}

function formatBlock(heading, body) {
  return `## ${heading}\n\n${body.trim()}\n`
}

/** Insert a new block into the active area — before the example comment if present. */
function insertBlock(raw, heading, body) {
  const block = formatBlock(heading, body)
  const firstComment = raw.search(/<!--/)
  if (firstComment >= 0) {
    const head = raw.slice(0, firstComment).replace(/\s+$/, '')
    const tail = raw.slice(firstComment)
    return `${head}\n\n${block}\n${tail}`
  }
  return `${raw.replace(/\s+$/, '')}\n\n${block}\n`
}

function applyEdit(raw, block, heading, body) {
  const replacement = `${formatBlock(heading, body)}\n`
  return tidyOutsideComments(raw.slice(0, block.headingStart) + replacement + raw.slice(block.end))
}

function applyDelete(raw, block) {
  return tidyOutsideComments(raw.slice(0, block.headingStart) + raw.slice(block.end))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function missingBridge() {
  return {
    success: false,
    error:
      'Automation management is unavailable in this context (no host bridge). This should not happen inside the app — report it.'
  }
}

/**
 * Read heartbeat.md with line endings normalized to \n. The engine tolerates
 * \r?\n, but our block bodies are sliced verbatim — normalizing here keeps them
 * matching the engine's \n-joined bodies (so matchLiveJob works on a CRLF file)
 * and keeps a rewritten file from ending up with mixed endings.
 */
async function loadHeartbeat() {
  return String((await automations.readHeartbeat()) || '').replace(/\r\n/g, '\n')
}

/** Strip a leading "## " the model may have included in the schedule arg. */
function normalizeHeading(schedule) {
  return schedule.trim().replace(/^#+\s*/, '').trim()
}

// "In (15m)" / "In (2h)" / "In (2d)" relative-delay sugar. Resolved to an
// absolute one-time "Once (...)" so the persisted heading is reload-safe (a
// relative form would reset its countdown on every scheduler reload).
const IN_RE =
  /^In\s*\(\s*(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*\)$/i
const MAX_ONCE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000

/** Format an epoch as the local-time heading "Once (YYYY-MM-DD HH:MM)". */
function formatLocalOnce(epoch) {
  const d = new Date(epoch)
  const p = (n) => String(n).padStart(2, '0')
  return `Once (${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())})`
}

/** Resolve "In (Nm/Nh/Nd)" to an absolute "Once (...)"; pass any other form through. */
function resolveSchedule(schedule) {
  const text = normalizeHeading(schedule)
  const m = IN_RE.exec(text)
  if (!m) {
    // Catch an "In (...)"-shaped input that didn't match (bad number/unit) and
    // explain the accepted forms, instead of letting it fail as a generic
    // "invalid schedule" downstream.
    if (/^In\s*\(/i.test(text)) {
      return {
        error: '"In (...)" takes a positive number plus m, h, or d — e.g. In (15m), In (2h), In (2d).'
      }
    }
    return { heading: text }
  }
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) {
    return { error: 'The delay in "In (...)" must be a positive number — e.g. In (15m), In (2h), In (2d).' }
  }
  const unit = m[2].toLowerCase()
  const ms = unit.startsWith('d')
    ? n * 24 * 60 * 60 * 1000
    : unit.startsWith('h')
      ? n * 60 * 60 * 1000
      : n * 60 * 1000
  return { heading: formatLocalOnce(Date.now() + ms) }
}

/** Bounds-check a resolved one-time fire time: must be future and within 30 days. */
function checkOnceTime(runAt) {
  if (typeof runAt !== 'number') return null
  const now = Date.now()
  if (runAt <= now) {
    return 'that time is already in the past — pick a future time (e.g. "In (15m)" or a later "Once (...)").'
  }
  if (runAt - now > MAX_ONCE_AHEAD_MS) {
    return "that's more than 30 days out — use a recurring schedule (Daily/Weekly/Monthly) for far-future jobs."
  }
  return null
}

/** Reject instruction bodies heartbeat.md's block grammar can't hold verbatim. */
function checkInstruction(instruction) {
  if (/^##\s+/m.test(instruction)) {
    return 'The instruction contains a line starting with "## ", which the heartbeat parser reads as a new automation heading. Rephrase it without markdown headings (plain sentences and "-" bullets are fine).'
  }
  if (/^---+\s*$/m.test(instruction)) {
    return 'The instruction contains a dashed separator line ("---"), which the heartbeat parser drops from the body. Remove it — a blank line separates sections just as well.'
  }
  // HTML-comment delimiters in the body could splice into the example comment
  // block and corrupt the file. They never belong in a plain instruction.
  if (instruction.includes('<!--') || instruction.includes('-->')) {
    return 'The instruction contains an HTML comment delimiter ("<!--" or "-->"), which the heartbeat file uses to hide its examples. Remove it — write the instruction as plain prose.'
  }
  return null
}

/** Match a parsed file block to a live scheduled job (by label+body, then label). */
function matchLiveJob(live, block) {
  return (
    live.find((j) => j.label === block.label && j.body.trim() === block.body.trim()) ??
    live.find((j) => j.label === block.label) ??
    null
  )
}

/** Resolve an identifier (1-based list number OR exact label) to a file block. */
function findTarget(blocks, identifier) {
  if (blocks.length === 0) {
    return { error: 'There are no automations to edit or delete. Use automation_create first.' }
  }
  const asNum = Number(identifier)
  if (Number.isInteger(asNum)) {
    if (asNum >= 1 && asNum <= blocks.length) return { block: blocks[asNum - 1] }
    return { error: `There is no automation #${asNum}. There ${blocks.length === 1 ? 'is 1' : `are ${blocks.length}`}. Run automation_list.` }
  }
  const lower = identifier.toLowerCase()
  const exact = blocks.filter((b) => b.label.toLowerCase() === lower)
  if (exact.length === 1) return { block: exact[0] }
  if (exact.length > 1) {
    return { error: `"${identifier}" matches ${exact.length} automations — use the number from automation_list instead.` }
  }
  return { error: `No automation matches "${identifier}". Run automation_list to see the exact labels and numbers.` }
}

function formatLastRun(job) {
  if (!job.lastStatus || !job.lastRunAt) return 'not run yet this session'
  const when = relativeTime(job.lastRunAt)
  if (job.lastStatus === 'failed') return `last run ${when}: **failed** — ${job.lastError ?? 'unknown error'}`
  if (job.lastStatus === 'skipped') return `last run ${when}: skipped (another automation was running)`
  return `last run ${when}: completed`
}

function relativeTime(epochMs) {
  const diff = Date.now() - epochMs
  if (diff < 0) return 'just now'
  const sec = Math.round(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

/** Collapse an instruction body to a single line for compact display. */
function oneLine(text) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  name: 'automations',
  tools: toolDefinitions,
  async init(context) {
    automations = context?.automations
  },
  async execute(toolName, args) {
    switch (toolName) {
      case 'automation_list':
        return listAutomations()
      case 'automation_create':
        return createAutomation(args ?? {})
      case 'automation_edit':
        return editAutomation(args ?? {})
      case 'automation_delete':
        return deleteAutomation(args ?? {})
      case 'automation_check':
        return checkAutomations()
      case 'automation_run':
        return runAutomation(args ?? {})
      default:
        return { success: false, error: `automations: unknown tool ${toolName}` }
    }
  }
}

export default plugin
