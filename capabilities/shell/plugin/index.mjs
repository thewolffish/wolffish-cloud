import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, chmod, constants, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const MAX_OUTPUT_BYTES = 100_000

function resolveCwd(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw || raw === '~') return homedir()
  if (raw.startsWith('~/')) return path.join(homedir(), raw.slice(2))
  return raw
}

// ---------------------------------------------------------------------------
// Shell detection (cached)
// ---------------------------------------------------------------------------

let shellPromise = null

async function probeWindowsShell() {
  const candidates = [
    { name: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command'], powershell: true },
    { name: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command'], powershell: true }
  ]
  for (const c of candidates) {
    try {
      await execFileP('where', [c.name], { windowsHide: true })
      return { bin: c.name, args: c.args, powershell: c.powershell }
    } catch {
      // not on PATH
    }
  }
  return { bin: 'cmd.exe', args: ['/c'] }
}

function detectShell() {
  if (shellPromise) return shellPromise
  if (process.platform !== 'win32') {
    shellPromise = Promise.resolve({ bin: '/bin/sh', args: ['-c'] })
    return shellPromise
  }
  shellPromise = probeWindowsShell().catch(() => ({ bin: 'cmd.exe', args: ['/c'] }))
  return shellPromise
}

/**
 * Drop a trailing bare `2>&1` when the shell is PowerShell.
 *
 * `2>&1` is a POSIX reflex and it parses fine in PowerShell, so it fails
 * silently rather than loudly: redirecting a NATIVE command's stderr into the
 * success stream makes PowerShell wrap every stderr line in a
 * NativeCommandError record, which leaves `$?` false, which makes
 * `powershell -Command` exit 1 — even when the child exited 0. A command that
 * fully succeeded then gets reported to the model as FAILED, with its real
 * output buried under CategoryInfo/FullyQualifiedErrorId noise. Measured:
 * `node noisy.js 2>&1` exits 1, the same command without it exits 0.
 *
 * The redirect buys nothing here regardless — execForeground already returns
 * combine(stdout, stderr) — so on PowerShell it is pure downside.
 *
 * Deliberately narrow. Only a TRAILING `2>&1` is dropped, and only when the
 * rest of the command has no other `>`: that leaves `cmd > out.log 2>&1`
 * (stderr belongs in the file) and `cmd 2>&1 | Select-String x` (stderr
 * belongs in the pipe) exactly as written. cmd.exe and /bin/sh are never
 * touched — POSIX behaviour is byte-for-byte unchanged.
 */
const TRAILING_STDERR_MERGE_RE = /\s+2>&1\s*$/

function stripRedundantStderrMerge(command, shell) {
  if (!shell?.powershell) return command
  const match = TRAILING_STDERR_MERGE_RE.exec(command)
  if (!match) return command
  const head = command.slice(0, match.index)
  if (head.includes('>')) return command
  return head.trim() || command
}

// ---------------------------------------------------------------------------
// Elevation detection
// ---------------------------------------------------------------------------

// Matches sudo, doas, pkexec, gsudo, runas anywhere in a command — at the
// start, after &&, after ||, after ;, or after whitespace.
const ELEVATION_RE = /(?:^|\s|&&|\|\||;)\s*(?:sudo|doas|pkexec|gsudo|runas)\s/i

// Narrower regex that captures the elevation keyword so we can rewrite it.
// Used to inject the -A flag into sudo/doas invocations.
const SUDO_INJECT_RE = /(?<=^|\s|&&|\|\||;)(\s*)(sudo|doas)(\s)/gi

// ---------------------------------------------------------------------------
// Cross-platform askpass: native OS password dialog
// ---------------------------------------------------------------------------

// Cached state so the user sees at most one password dialog per ~5 min window.
// After a successful prime, subsequent sudo calls within the cache window
// succeed silently. The askpass helper stays on disk until cleanup.
let askpassState = null // { askpassPath, tmpDir, env, primedAt }

// Injected at plugin init by the main process. On macOS we route elevation
// through this shared, app-lifetime password session so the user is prompted
// once per app run instead of per command. Null until init runs, and unused on
// non-macOS where the legacy per-session askpass path below still applies.
let sudoCtx = null

async function cleanupAskpass() {
  if (!askpassState) return
  const { tmpDir } = askpassState
  askpassState = null
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
}

// Returns the shell script body for the askpass helper on the current platform.
// The script must print the password to stdout and exit 0 on success, or
// exit non-zero on cancellation.
async function buildAskpassScript(message) {
  const escaped = (message || 'Wolffish needs admin access to run this command.').replace(
    /"/g,
    '\\"'
  )

  if (process.platform === 'darwin') {
    return `#!/bin/bash
set -e
osascript \\
  -e 'tell application "System Events" to activate' \\
  -e 'display dialog "${escaped}" default answer "" with hidden answer with title "Wolffish" buttons {"Cancel", "Authorize"} default button "Authorize"' \\
  -e 'text returned of result' 2>/dev/null
`
  }

  if (process.platform === 'linux') {
    // Probe for a GUI password tool. Wolffish is an Electron app so a
    // desktop environment is always present.
    const tools = [
      { cmd: 'zenity', args: () => `zenity --password --title="Wolffish" --text="${escaped}" 2>/dev/null` },
      { cmd: 'kdialog', args: () => `kdialog --password "${escaped}" --title "Wolffish" 2>/dev/null` },
      { cmd: 'ssh-askpass', args: () => `SSH_ASKPASS_REQUIRE=force ssh-askpass "${escaped}" 2>/dev/null` }
    ]

    for (const tool of tools) {
      try {
        await execFileP('which', [tool.cmd])
        return `#!/bin/bash\nset -e\n${tool.args()}\n`
      } catch {
        // not available
      }
    }

    return null // no GUI tool found
  }

  // Windows: sudo doesn't exist natively. Return null to trigger the
  // fast-fail path.
  return null
}

// Run a command and collect its output. Same pattern as the package-manager
// plugin's runSpawn — non-blocking, Promise-based.
function runCollect(cmd, args, env = process.env) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err?.message ?? String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => { stdout += c.toString().slice(0, 10_000) })
    child.stderr?.on('data', (c) => { stderr += c.toString().slice(0, 10_000) })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err?.message ?? String(err) }))
  })
}

// Commands that add a NEW directory to the persistent/login PATH — installers
// whose target dir isn't already on the running process's PATH. After one
// succeeds we re-read the PATH so the new tool is reachable by the next tool
// call without an app restart, the same staleness node_check / the ffmpeg
// resolver guard against. Excluded on purpose: npm -g / pip / cargo (their bin
// dirs are already on PATH) and apt/dnf/yum (install to /usr/bin, always on
// PATH) — a refresh there adds nothing and just fires needlessly. brew/port/snap
// ARE included: a GUI-launched app's minimal PATH lacks /opt/homebrew/bin,
// /opt/local/bin, /snap/bin.
const PATH_MUTATING_RE =
  /\b(?:winget|choco|scoop|msiexec|setx)\b|SetEnvironmentVariable|\b(?:brew|port|snap)\s+install\b/i

// Re-read the user's "real" PATH and merge any new entries into process.env.PATH
// so a tool just installed by a shell command is reachable by the next spawn. On
// Windows that's the registry (Machine + User scopes); elsewhere it's the login
// shell's PATH, which sources the rc files where Homebrew/nvm/etc. live.
// Append-only, deduped, best-effort — a failure leaves PATH untouched.
async function refreshWolffishPath() {
  const sep = process.platform === 'win32' ? ';' : ':'
  let raw = []
  try {
    if (process.platform === 'win32') {
      const script =
        "[Environment]::GetEnvironmentVariable('PATH','Machine');" +
        "[Environment]::GetEnvironmentVariable('PATH','User')"
      const { stdout } = await execFileP(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 5_000, windowsHide: true }
      )
      raw = stdout.split(/\r?\n/).flatMap((line) => line.split(';'))
    } else {
      const shell = process.env.SHELL || '/bin/sh'
      const { stdout } = await execFileP(
        shell,
        ['-ilc', 'printf "__WFPATH__%s__WFPATH__" "$PATH"'],
        { timeout: 5_000 }
      )
      const resolved = stdout.match(/__WFPATH__(.+?)__WFPATH__/)?.[1]
      raw = resolved ? resolved.split(':') : []
    }
  } catch {
    return // best-effort
  }
  const strip = (p) => p.trim().replace(/[\\/]+$/, '')
  const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const additions = raw.map(strip).filter(Boolean)
  if (additions.length === 0) return
  const current = (process.env.PATH ?? '')
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean)
  const seen = new Set(current.map((p) => key(strip(p))))
  let mutated = false
  for (const entry of additions) {
    const k = key(entry)
    if (seen.has(k)) continue
    seen.add(k)
    current.push(entry)
    mutated = true
  }
  if (mutated) process.env.PATH = current.join(sep)
}

/**
 * Ensure sudo credentials are cached. Shows a native OS password dialog
 * on the first call; subsequent calls within ~5 minutes are free.
 *
 * Returns { ok, env, error?, cancelled? }.
 * On success, `env` contains SUDO_ASKPASS pointing at the helper script.
 * The caller passes this env to the spawned command.
 */
async function ensureElevation() {
  // The askpass helper lives for the entire Wolffish session. We create it
  // once and reuse it. Since every sudo command gets the -A flag injected,
  // sudo itself will call the helper whenever its OS-level cache expires —
  // we don't need to proactively re-prime. The user sees a native password
  // dialog only when the OS actually needs credentials (controlled by
  // sudoers timestamp_timeout, typically 5–15 min, configurable by the user).
  if (askpassState) {
    return { ok: true, env: askpassState.env }
  }

  const script = await buildAskpassScript()
  if (!script) {
    if (process.platform === 'win32') {
      return {
        ok: false,
        error:
          'operation not permitted (elevation required). ' +
          'Windows does not use sudo. Run this command in an elevated terminal (Run as Administrator), ' +
          'or ask the user to execute it manually.'
      }
    }
    return {
      ok: false,
      error:
        'operation not permitted (elevation required). ' +
        'No GUI password tool found (tried zenity, kdialog, ssh-askpass). ' +
        'Install zenity (`apt install zenity`) or ask the user to run the command in their terminal.'
    }
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'wolffish-askpass-'))
  const askpassPath = path.join(tmpDir, 'askpass.sh')

  try {
    await writeFile(askpassPath, script, 'utf8')
    await chmod(askpassPath, 0o700)
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: `failed to create askpass helper: ${err?.message ?? String(err)}` }
  }

  const env = { ...process.env, SUDO_ASKPASS: askpassPath }

  // Prime sudo's credential cache on first use so the user sees the dialog
  // now rather than mid-command. After this, sudo re-prompts via the askpass
  // helper automatically when the OS cache expires.
  const auth = await runCollect('sudo', ['-A', '-v'], env)

  if (auth.code !== 0) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    const detail = (auth.stderr || '').trim()
    if (!detail || /cancel/i.test(detail)) {
      return {
        ok: false,
        cancelled: true,
        error:
          'operation not permitted (user cancelled the password dialog). ' +
          'Admin access is required to run this command. Try again when ready, ' +
          'or ask the user to run it in their terminal.'
      }
    }
    return {
      ok: false,
      error: `operation not permitted (sudo authentication failed): ${detail.slice(0, 300)}`
    }
  }

  askpassState = { askpassPath, tmpDir, env }
  return { ok: true, env }
}

/**
 * Rewrite a command so that bare `sudo` / `doas` invocations include the
 * -A flag, forcing them to use the SUDO_ASKPASS helper instead of a TTY.
 * This handles chained commands like `sudo cmd1 && sudo cmd2`.
 */
function injectAskpassFlag(command) {
  return command.replace(SUDO_INJECT_RE, (_, ws, keyword, trail) => {
    return `${ws}${keyword} -A${trail}`
  })
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const toolDefinitions = [
  {
    name: 'shell_exec',
    description: 'Run a shell command and return its combined stdout+stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory (default: user home)' },
        timeout: {
          type: 'number',
          description:
            'Optional timeout in ms. Default: omit and let the command run until it exits. Only set this when you have a good reason to expect fast completion. Ignored when background is true.'
        },
        background: {
          type: 'boolean',
          description:
            'Start the command detached and return immediately with its PID. Use for dev servers, watchers, daemons, or any process that does not exit on its own (npm run dev, vite, nodemon). stdio is set to /dev/null — redirect inside the command if you want to read output later (e.g. > /tmp/log 2>&1).'
        }
      },
      required: ['command']
    }
  }
]

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function clamp(buf, chunk) {
  if (buf.length >= MAX_OUTPUT_BYTES) return buf
  const room = MAX_OUTPUT_BYTES - buf.length
  return buf + chunk.toString().slice(0, room)
}

function combine(out, err) {
  const parts = []
  if (out) parts.push(out.trim())
  if (err) parts.push(err.trim())
  return parts.join('\n').trim()
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

async function execShell(args, signal) {
  if (signal?.aborted) return { success: false, error: 'Stopped by user.' }

  const command = String(args?.command ?? '').trim()
  if (!command) return { success: false, error: 'empty command' }

  const cwd = resolveCwd(args?.cwd)
  try {
    await access(cwd, constants.F_OK)
  } catch {
    return { success: false, error: `cwd does not exist or is not accessible: ${cwd}` }
  }

  const shell = await detectShell()
  const needsElevation = ELEVATION_RE.test(command)

  // --- Elevation handling ---
  // When the command contains sudo/doas/pkexec, we:
  // 1. Prime the credential cache via a native OS password dialog
  // 2. Inject the -A flag so sudo uses the askpass helper (not a TTY)
  // 3. Pass SUDO_ASKPASS in the environment
  // This guarantees the command never hangs waiting for terminal input.
  let execEnv = process.env
  let execCommand = command

  if (needsElevation) {
    let handled = false

    // Preferred path (macOS + Linux): the shared in-memory password session.
    // Acquire once, reuse for the app's lifetime — no dialog after the first
    // capture. Windows has no sudo, so we skip straight to the legacy guidance.
    if (sudoCtx && process.platform !== 'win32') {
      const auth = await sudoCtx.ensurePassword()
      if (auth.ok) {
        execEnv = { ...process.env, ...sudoCtx.getElevatedEnv() }
        execCommand = injectAskpassFlag(command)
        handled = true
      } else if (!auth.unsupported) {
        // The session attempted and was rejected (cancelled, wrong password,
        // not in sudoers). Surface that — don't fall back, which would just
        // re-prompt. Only `unsupported` (no GUI tool, infra error) falls
        // through to the legacy path below.
        return {
          success: false,
          error: auth.error ?? 'operation not permitted (elevation required)'
        }
      }
    }

    // Fallback: legacy per-session askpass dialog. Runs on Windows, when the
    // session is unavailable, or when the session reported it couldn't attempt
    // (e.g. no GUI password tool on Linux). Byte-for-byte the pre-session flow.
    if (!handled) {
      const elevation = await ensureElevation()
      if (!elevation.ok) {
        return { success: false, error: elevation.error }
      }
      execEnv = elevation.env
      execCommand = injectAskpassFlag(command)

      // Refresh the OS credential cache right before execution so the timer
      // resets. This is silent (no dialog) as long as the cache hasn't already
      // expired. If it has, sudo calls the askpass helper automatically.
      await runCollect('sudo', ['-A', '-v'], execEnv)
    }
  }

  // Applied after elevation rewriting so both dispatch paths get the same
  // command text. No-op on cmd.exe and /bin/sh.
  execCommand = stripRedundantStderrMerge(execCommand, shell)

  if (args?.background === true) {
    return execBackground({ command: execCommand, cwd, shell, env: execEnv })
  }

  const timeoutMs =
    typeof args?.timeout === 'number' && args.timeout > 0 ? args.timeout : 0

  const result = await execForeground({ command: execCommand, cwd, shell, timeoutMs, env: execEnv, signal })
  if (result.success) {
    // If the command installed something onto PATH, re-read the PATH so the new
    // tool is reachable by the next tool call without an app restart.
    if (PATH_MUTATING_RE.test(command)) {
      await refreshWolffishPath()
    }
    // NOTE: opened-file auto-surfacing was removed on purpose. Delivery is the
    // MODEL's job — it sends outputs with send_file; the harness never
    // appends delivery markers on its own.
  }
  return result
}

function execBackground({ command, cwd, shell, env }) {
  try {
    const child = spawn(shell.bin, [...shell.args, command], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    const pid = child.pid
    if (!pid) {
      return { success: false, error: 'failed to start background process (no PID returned)' }
    }
    child.unref()
    return { success: true, output: `Started in background, PID: ${pid}` }
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }
}

function execForeground({ command, cwd, shell, timeoutMs, env, signal }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(shell.bin, [...shell.args, command], {
        cwd,
        env,
        // stdin is 'ignore' so processes that unexpectedly block on input
        // get EOF immediately instead of hanging forever. stdout/stderr are
        // piped for capture.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      resolve({ success: false, error: err?.message ?? String(err) })
      return
    }

    let stdout = ''
    let stderr = ''
    let resolved = false
    let timer = null
    let onAbort = null
    const finish = (result) => {
      if (resolved) return
      resolved = true
      if (timer) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    // The command's shell spawns descendants; a plain child.kill leaves them
    // running. On Windows kill the whole tree via taskkill (same approach as
    // the cerebellum's npm-install backstop); elsewhere SIGKILL the shell.
    const killTree = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        // already dead
      }
    }

    // Stop the run mid-command: kill the process tree and resolve as a
    // failure so the agent can close the turn cleanly instead of waiting for
    // a long-running command to finish on its own.
    if (signal) {
      if (signal.aborted) {
        killTree()
        finish({ success: false, error: 'Stopped by user.', output: combine(stdout, stderr) })
        return
      }
      onAbort = () => {
        killTree()
        finish({ success: false, error: 'Stopped by user.', output: combine(stdout, stderr) })
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already dead
        }
        finish({
          success: false,
          error: `Command timed out after ${timeoutMs}ms`,
          output: combine(stdout, stderr)
        })
      }, timeoutMs)
    }

    child.stdout?.on('data', (chunk) => {
      stdout = clamp(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = clamp(stderr, chunk)
    })
    child.on('error', (err) => {
      finish({ success: false, error: err?.message ?? String(err) })
    })
    child.on('close', (code) => {
      const output = combine(stdout, stderr)
      if (code === 0) {
        finish({ success: true, output: output || '(no output)' })
        return
      }
      // Exit code 1 with no output at all is the universal "no match / nothing
      // found" signal for query tools — grep (1 = no lines matched), find/ls on
      // an absent path, test, and any pipeline ending in one of them. That is a
      // valid empty result, not a failure. Reporting it as a failure made the
      // motor retry a deterministic no-match three times and handed the model a
      // blind "(unknown)" error with zero signal. Surface it as a clean empty
      // result. Exit codes >= 2 still mean a real error (e.g. grep 2 = read
      // error) and fall through to the failure path below.
      if (code === 1 && !stdout.trim() && !stderr.trim()) {
        finish({ success: true, output: '(no matches — command exited 1 with no output)' })
        return
      }
      // `grep -c` (and `grep -c -r`) print a tally and exit 1 when the total
      // count is zero — "0" for a single file, "<file>:0" per file with -r.
      // The number IS the result, not an error, so the no-output guard above
      // misses it (stdout is "0", not empty) and the command lands in the
      // failure path, handing the model a blind "exited with code 1: 0". Treat
      // a stderr-free exit-1 whose stdout is only zero-counts as a clean empty
      // result and return the tally itself. grep only exits 1 here when every
      // count is zero (any match exits 0), so this never masks a real hit.
      if (code === 1 && !stderr.trim() && stdout.trim()) {
        const lines = stdout.trim().split(/\r?\n/)
        if (lines.every((l) => /^(?:.+:)?0$/.test(l.trim()))) {
          finish({ success: true, output: stdout.trim() })
          return
        }
      }
      const diagnostic = buildDiagnostic(stdout, stderr, command)
      const partial = stdout.trim().length > 100
      finish({
        success: false,
        exitCode: code,
        partial,
        error: diagnostic
          ? `Command exited with code ${code}: ${diagnostic}`
          : `Command exited with code ${code} (no output captured — if you redirected stderr with 2>/dev/null, drop it so the cause is visible)`,
        output
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function buildDiagnostic(stdout, stderr, command) {
  const err = stderr.trim()
  const out = stdout.trim()

  if (!err && ELEVATION_RE.test(command) && out.length < 200) {
    return `operation not permitted (non-interactive shell, elevation required)\n${out}`
  }

  if (err) {
    const errPart = err.slice(0, 300)
    const outPart = out.slice(0, 200)
    return outPart ? `${errPart}\n---\n${outPart}` : errPart
  }

  if (out.length <= 500) return out
  return `${out.slice(0, 250)}\n…\n${out.slice(-250)}`
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Risk descriptions (for the approval card UI)
// ---------------------------------------------------------------------------

const HIGH_RISK_RE =
  /\brm\s+(-rf|--recursive)|\bmkfs|\bdd\s+if=|chmod\s+777|curl[^|]*\|\s*(bash|sh|zsh)|:\(\)\s*\{\s*:\|:|shutdown|sudo\s+|git\s+push\s+.*--force|npm\s+publish/i
const MEDIUM_RISK_RE = /\b(npm|pip|brew|apt|dnf|cargo|gem)\s+install\b|git\s+push\b|docker\s+rm\b|rm\s+/i

function describeShellAction(command) {
  const cmd = String(command ?? '').trim()
  let risk = 'low'
  if (HIGH_RISK_RE.test(cmd)) risk = 'high'
  else if (MEDIUM_RISK_RE.test(cmd)) risk = 'medium'

  const verbMap = [
    [/^ls\b/, 'List files'],
    [/^pwd\b/, 'Print working directory'],
    [/^cat\b/, 'Print file contents'],
    [/^(?:open|xdg-open|start)\b/, 'Open file'],
    [/^cd\b/, 'Change directory'],
    [/^cp\b/, 'Copy files'],
    [/^mv\b/, 'Move/rename files'],
    [/^rm\s+(-rf|--recursive)/, 'Delete directory recursively'],
    [/^rm\b/, 'Delete files'],
    [/^mkdir\b/, 'Create directory'],
    [/^grep\b|^rg\b/, 'Search code'],
    [/^find\b/, 'Find files'],
    [/^git\s+status/, 'Check git status'],
    [/^git\s+diff/, 'Show git diff'],
    [/^git\s+log/, 'Show git log'],
    [/^git\s+push/, 'Push commits to remote'],
    [/^git\s+pull/, 'Pull from remote'],
    [/^git\s+commit/, 'Create git commit'],
    [/^npm\s+install/, 'Install npm dependencies'],
    [/^npm\s+run/, 'Run npm script'],
    [/^pip\s+install/, 'Install Python packages'],
    [/^docker\s+/, 'Run Docker command'],
    [/^brew\s+install/, 'Install with Homebrew'],
    [/^curl\b/, 'Make HTTP request']
  ]
  let description = 'Run shell command'
  for (const [re, label] of verbMap) {
    if (re.test(cmd)) {
      description = label
      break
    }
  }

  let impact
  if (/^rm\s+(-rf|--recursive)/.test(cmd)) {
    impact = 'Permanently deletes files. This cannot be undone.'
  } else if (/sudo\s+/.test(cmd)) {
    impact = 'Runs with elevated privileges (will prompt for your password via system dialog).'
  } else if (/git\s+push\s+.*--force/.test(cmd)) {
    impact = 'Force-pushes the branch — may overwrite remote history.'
  }

  const out = {
    title: 'Run shell command',
    description,
    command: cmd,
    risk
  }
  if (impact) out.impact = impact
  return out
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  name: 'shell',
  tools: toolDefinitions,
  async init(context) {
    sudoCtx = context?.sudo ?? null
  },
  describeAction(toolName, args) {
    if (toolName !== 'shell_exec') return null
    return describeShellAction(args?.command)
  },
  async execute(toolName, args, signal) {
    if (toolName !== 'shell_exec') {
      return { success: false, error: `shell: unknown tool ${toolName}` }
    }
    return execShell(args, signal)
  }
}

export default plugin
