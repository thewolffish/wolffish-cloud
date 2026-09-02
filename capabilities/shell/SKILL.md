---
name: shell
description: Execute shell commands on the local system
triggers:
  - run
  - execute
  - command
  - terminal
  - shell
  - bash
  - npm
  - npx
  - git
  - pip
  - docker
  - brew
  - curl
  - wget
  - zsh
  - powershell
  - cmd
  - script
  - process
  - grep
  - find
  - ls
  - mkdir
  - chmod
  - sudo
  - ssh
  - tar
  - zip
  - unzip
  - python
  - java
  - go
  - cargo
  - yarn
  - pnpm
  - make
  - cmake
  - install
  - compile
  - build
  - deploy
  - test
  - debug
  - output
  - background
  - kill
  - dev server
  - start server
  - port
  - localhost
  - cli
  - console
  - stdout
  - stderr
  - exit code
  - return code
  - environment variable
  - env var
  - which
  - where
  - PATH
  - cron
  - cronjob
  - systemctl
  - service
  - daemon
  - restart
  - stop
  - running
  - pid
  - top
  - htop
  - ps
  - disk
  - df
  - du
  - free
  - uptime
  - whoami
  - hostname
  - ifconfig
  - ip address
  - network
  - ping
  - traceroute
  - nslookup
  - dig
  - scp
  - rsync
  - awk
  - sed
  - xargs
  - tee
  - nohup
  - screen
  - tmux
  - run in terminal
  - execute command
  - run this
  - run a command
  - open terminal
tools:
  - name: shell_exec
    description: Run a shell command and return its output. Default cwd is the user home directory. Commands run until they exit — only set a timeout when you have a good reason to expect fast completion. Elevation commands (sudo, doas) authenticate automatically through the app's saved admin session (at most one native password dialog per app run, handled app-side) — no TTY needed, nothing for you to handle, works identically from workflow agents and scheduled turns. Set background=true for long-lived processes (dev servers, watchers).
    parameters:
      command:
        type: string
        description: The command to execute
      cwd:
        type: string
        required: false
        description: Working directory (default user home). If you set cwd, it must be an absolute path that exists on the system. Otherwise omit it — defaults to the user's home directory.
      timeout:
        type: number
        required: false
        description: Optional timeout in ms. Default is no timeout — commands run until they exit. Only set this when you have a good reason to expect fast completion. Ignored when background is true.
      background:
        type: boolean
        required: false
        description: Start the command detached and return immediately with its PID. Use for any process that does not exit on its own (npm run dev, vite, nodemon, http servers, watchers). stdio is set to /dev/null — redirect inside the command (e.g. > /tmp/log 2>&1) if you want to read output later.
danger_patterns:
  - pattern: 'rm\s+(-rf|--recursive)'
    level: destructive
    reason: Recursive force delete
  - pattern: 'sudo\s+'
    level: destructive
    reason: Privilege escalation — runs with admin rights via the app's saved sudo session
  - pattern: 'mkfs'
    level: block
    reason: Format disk
  - pattern: 'dd\s+if='
    level: block
    reason: Raw disk write
  - pattern: 'chmod\s+777'
    level: destructive
    reason: Open permissions
  - pattern: 'curl[^|]*\|\s*(bash|sh|zsh)'
    level: block
    reason: Remote shell execution
  - pattern: 'npm\s+publish'
    level: destructive
    reason: Publish to registry
  - pattern: 'git\s+push\s+.*--force'
    level: destructive
    reason: Force push
  - pattern: ':\(\)\s*\{\s*:\|:'
    level: block
    reason: Fork bomb
  - pattern: 'shutdown'
    level: destructive
    reason: System shutdown
confirm_patterns:
  - pattern: 'npm\s+install'
    reason: Installing packages
  - pattern: 'pip\s+install'
    reason: Installing packages
  - pattern: 'git\s+push'
    reason: Pushing code
  - pattern: 'docker\s+rm'
    reason: Removing containers
---

# Shell

## Interface

- Tool: `shell_exec`
- Method: runs commands via the host's preferred shell, detected once at startup:
  - **Unix:** `/bin/sh -c`
  - **Windows:** PowerShell 7+ (`pwsh`) if installed, else Windows PowerShell 5.1 (`powershell.exe`), else `cmd.exe`. Check the `<device>` block in your system prompt to see which one is active — it's reported as `shell:`.
- Timeout: none by default — commands run until they exit. You may pass an explicit timeout if you want fast failure on a command you expect to finish quickly.
- Elevation: `sudo` and `doas` commands are **fully supported**. The plugin detects them, pops a native OS password dialog (macOS: system dialog via osascript, Linux: zenity or kdialog), and injects the `-A` flag so no TTY is needed. On macOS and Linux the password is captured **once per app run** and held in memory, so every later privileged command is silent (Linux needs a GUI password tool — zenity/kdialog/ssh-askpass — and otherwise falls back to sudo's ~5-minute timestamp cache); Windows has no sudo. Either way the user sees one prompt, not one per command.
- stdin: set to `/dev/null` (EOF) so commands that unexpectedly wait for input fail fast instead of hanging.
- Returns combined stdout+stderr; truncated past ~100 KB

## Writing commands for the active shell

The selected shell determines the syntax that works. Mismatched syntax fails fast (the runtime classifies "is not recognized" / "syntax is incorrect" as non-retryable) — so you'll see one fast error rather than minutes of retries, but you still wasted a call.

- **PowerShell (pwsh or powershell.exe)** — use PowerShell cmdlets and operators. `Get-ChildItem` (or its alias `ls`/`dir`), `Get-Content` (`cat`/`type`), `Start-Process`, `$env:NAME` for env vars, `2>$null` to discard stderr.
  - On Windows PowerShell 5.1 specifically, `&&` and `||` chain operators do NOT exist — use `;` for unconditional chaining, or wrap in `if ($?) { ... }` for conditional. pwsh 7+ supports `&&`/`||` natively.
  - `where` is an alias for `Where-Object`; to find an executable use `where.exe foo` or `Get-Command foo`.
  - **Never append `2>&1`.** This tool already returns combined stdout+stderr, so it adds nothing — and on PowerShell it actively breaks the result. See "Never append 2>&1 on PowerShell" below.
- **cmd.exe** — classic cmd syntax. `dir`, `type`, `set FOO=bar`, `%ENV%` expansion, `2>nul`, `&&` / `||` work.
- **/bin/sh** — POSIX. `ls`, `cat`, `export FOO=bar`, `$ENV`, `2>/dev/null`, `&&` / `||`.

If you're unsure which dialect a command needs, prefer external `.exe` invocations (`where.exe`, `findstr.exe`, `cloudflared.exe`) — those work identically across all three shells.

## Timeout guidelines

**Default: no timeout.** Let commands run until they finish. Long
execution is normal in an agentic workflow — nothing is wasted while the
device runs a command, and most things self-terminate anyway.

Only set a timeout when you have a really good reason — when you know
for a fact the command should finish quickly and hanging would mean
something is wrong. For most commands, just let them run.

For processes that never exit on their own (dev servers, watchers,
daemons), use `background: true` — timeout is irrelevant.

## Elevation commands (sudo, doas, etc.)

`sudo` and `doas` commands **work normally** — no special handling needed
from your side. The plugin automatically:

1. Detects elevation keywords in the command
2. Pops a native OS password dialog (macOS system dialog, Linux zenity/kdialog)
3. Captures the password once and holds it in app memory for the whole app run (macOS and Linux); where no GUI capture tool exists it falls back to sudo's ~5-minute timestamp — one prompt per session, not per command
4. Injects the `-A` flag so sudo uses the dialog instead of a TTY
5. Runs the original command with the cached credential

If the user cancels the dialog or no GUI tool is available, the plugin
returns a non-retryable error immediately — it never hangs.

The admin session is **app-wide**: workflow agents and autonomous turns
(heartbeat jobs, procedures) share the exact same in-memory session as an
interactive chat turn. If you are a workflow agent, sudo works for you
exactly as described above — run the command; never report elevation back
to the master as a blocker unless the tool actually returned an
"operation not permitted" error.

On Windows, sudo does not exist. If a task requires admin privileges on
Windows (modifying system files, changing firewall rules, installing
system-wide services, editing the registry, etc.), do NOT use `sudo`,
`gsudo`, or `runas` in the command. Instead:

1. Tell the user: "This task requires administrator privileges. Please
   close Wolffish and relaunch it by right-clicking → Run as Administrator,
   then try this task again."
2. Do NOT retry the command or attempt workarounds — the user must restart
   Wolffish with elevated privileges first.
3. Once Wolffish is running as admin, all commands automatically have full
   privileges — just run them normally without any elevation prefix.

## Long-lived processes (dev servers, watchers, daemons)

`npm run dev`, `next dev`, `vite`, `vite preview`, `nodemon`, `python -m http.server`,
`cargo watch`, `live-server`, and any process that serves on a port or watches
files will never exit on its own. Set `background: true` and the tool returns
immediately with the PID — no `nohup`, no `&`, no `disown`.

Call 1 — start in background (returns in < 1 second with the PID):
```
command: "npm run dev > /tmp/myapp.log 2>&1"
cwd:     "/Users/me/Desktop/projects/myapp"
background: true
```

Call 2 — verify in a SEPARATE tool call (not chained with `&&`, not `;`):
```
command: "sleep 10 && curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 && echo ' up' || tail -30 /tmp/myapp.log"
timeout: 30000
```

Notes:
- With `background: true`, stdio is `/dev/null`. Redirect inside the command
  (`> /tmp/log 2>&1`) if you want to read output later.
- The PID is in the output. Save it if you may need to stop the process
  (`kill <pid>`).
- Never set `background: true` on a command that needs to return output
  (build steps, tests, status checks). Foreground is correct for those.
- Don't chain start + curl in a single foreground call — the server needs a
  moment to bind. Use one background call to start, then a foreground call
  to verify.

## Rules

- Always show the command to the user before running it.
- Chain dependent commands so a failure stops the chain — but the operator is
  shell-specific, so check `shell:` in the `<device>` block first:
  - `/bin/sh`, `cmd.exe`, `pwsh` 7+ → `&&`
  - **Windows PowerShell 5.1 (`shell: powershell`) → `&&` is a hard parse
    error** ("The token '&&' is not a valid statement separator in this
    version"). Use `cmd1; if ($?) { cmd2 }`, or `;` when you don't need the
    fail-fast.
- Never append `2>&1` — this tool already returns combined stdout+stderr, and
  on PowerShell the redirect turns a successful command into a reported
  failure. Details in the PowerShell pitfalls section.
- Prefer `git status` / `git diff` over `git status .` / `git diff .` (cleaner output).
- For long-running commands (builds, installs), warn the user first.
- If a command fails, read the error and try to fix it before retrying.
- Never run destructive commands without user approval — the safety gate
  enforces this, but assume nothing.

## Windows PowerShell pitfalls

These are the most common causes of wasted tool calls on Windows. Read this section if `<device>` shows `shell: powershell`.

### Never append `2>&1` on PowerShell

This is the single most expensive habit on Windows, because it *parses fine* — nothing errors, the result just comes back wrong.

Redirecting a **native** command's stderr into the success stream makes PowerShell wrap every stderr line in a `NativeCommandError` record. That leaves `$?` false, which makes `powershell -Command` exit **1 even when the child exited 0**. The tool classifies exit≠0 as failure, so a command that fully succeeded is reported to you as FAILED, with its real output buried under `CategoryInfo` / `FullyQualifiedErrorId` / tilde-underline noise.

Measured, same command both ways:

| command | exit | reported |
| --- | --- | --- |
| `node noisy.js 2>&1` | 1 | ❌ FAILED (stdout buried in an error blob) |
| `node noisy.js` | 0 | ✅ success (clean stdout) |

This bites every modern CLI, because they write progress to stderr: `npm`, `uv`, `pip`, `git`, `ffmpeg`, `cargo`, `docker`. A real example — `uv run --with pymupdf …` printed `pymupdf ready` and `Installed 1 package`, and came back FAILED purely because of a trailing `2>&1`.

**You never need it.** `shell_exec` already returns combined stdout+stderr (see Interface above). The runtime now strips a trailing bare `2>&1` on PowerShell as a backstop, but write commands without it:

**Broken:** `node script.mjs 2>&1`
**Correct:** `node script.mjs`

`> file 2>&1` (send stderr to a log) and `cmd 2>&1 | Select-String x` (send stderr through a pipe) are left alone — those are real uses. To *discard* stderr use `2>$null`.

### Don't wrap PowerShell in PowerShell

When the shell is already `powershell.exe` or `pwsh`, your command runs *inside* PowerShell. Do NOT wrap it in `powershell -Command "..."` — that spawns a child PowerShell and double-interpolates variables.

**Broken:** `powershell -Command "Get-Disk | Where-Object {$_.BusType -eq 'USB'}"`
The outer PowerShell sees `$_` inside double quotes, interpolates it to empty string, and the inner shell receives `{.BusType -eq 'USB'}` — a bare term error.

**Correct:** `Get-Disk | Where-Object {$_.BusType -eq 'USB'}`
Run PowerShell cmdlets directly. No wrapper needed.

If you absolutely must call `powershell -Command` (e.g. to force a specific PS version), use single-quoted here-strings or escape the `$` as `` `$ ``:
`powershell -Command 'Get-Disk | Where-Object {$_.BusType -eq \"USB\"}'`

### No `&` chaining — use `;`

`&` is **cmd.exe** syntax. In PowerShell it is the call operator (for running executables by path), not a command separator. Chaining with `&` produces a parser error.

**Broken:** `echo foo & echo bar & echo baz`
**Correct:** `echo foo; echo bar; echo baz`

For conditional chaining (run B only if A succeeds), there is no `&&` in PS 5.1. Use:
`command1; if ($?) { command2 }`

### Piping text to admin tools doesn't work

`echo list disk | diskpart` fails because:
1. `diskpart.exe` requires elevation — it will error with "requires elevation" unless Wolffish is running as admin.
2. Even elevated, piping `echo` to `diskpart` via PowerShell pipe doesn't reliably feed diskpart's interactive prompt.

**For diskpart, always use a script file:**
1. Write commands to a `.txt` file (one command per line)
2. Run `diskpart /s C:\path\to\script.txt`

### Windows tools that always require elevation

These tools will ALWAYS fail without admin privileges. Before using them, check if Wolffish is elevated:
`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`

If false, tell the user to relaunch Wolffish as admin. Do NOT retry — no workaround exists.

- `diskpart` — disk/partition management
- `bcdedit` — boot configuration
- `sfc` / `DISM` — system file repair
- `netsh` — network configuration
- `wmic` (some queries) — system management
- `chkdsk /f` — disk check with repair
- `format` (the standalone .exe) — volume formatting

### diskpart script best practices

When writing a diskpart script file, always include `select partition 1` (or the appropriate number) after `create partition primary` and before `format`. The `create partition` command does NOT auto-select the volume for formatting.

**Broken sequence:**
```
select disk 1
clean
create partition primary
format fs=ntfs quick        ← fails: "no volume selected"
assign
```

**Correct sequence:**
```
select disk 1
clean
create partition primary
select partition 1
format fs=ntfs quick
assign
```

### Drive letters change after disk operations

After `diskpart clean` + `create partition primary` + `format` + `assign`, Windows assigns the *next available* drive letter — which is often different from the original. Never verify the result using the old drive letter.

**Broken:** `Get-Partition -DriveLetter D | Format-Table` (D: may no longer exist)
**Correct:** `Get-Disk -Number 1 | Get-Partition | Format-Table` (query by disk number)

Rule: after any diskpart operation that destroys and recreates partitions, always verify by **disk number**, not by drive letter.

## Common patterns

**Unix:**
- Inspect the cwd: `ls -la`, `pwd`, `git status`.
- Inspect a file: `cat <path>` for short files, `wc -l <path>` for size.
- Search the codebase: `grep -rn 'foo' .` (or `rg 'foo'` if ripgrep is installed).
- Check Node version: `node -v`. Check Git version: `git --version`.

**Windows (PowerShell):**
- Inspect the cwd: `Get-ChildItem`, `Get-Location`, `git status`.
- Inspect a file: `Get-Content <path>` for short files, `(Get-Content <path>).Count` for line count.
- Search the codebase: `Select-String -Path .\* -Pattern 'foo' -Recurse` (or `rg 'foo'` if ripgrep is installed).
- Check elevation: `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
- List disks: `Get-Disk | Format-Table -AutoSize`
- List partitions on a disk: `Get-Disk -Number N | Get-Partition | Format-Table -AutoSize`
