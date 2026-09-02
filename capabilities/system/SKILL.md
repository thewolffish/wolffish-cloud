---
name: system
description: Open and close applications, open files/folders/URLs, and control machine power (restart, shutdown, sleep, lock, logout)
triggers:
  - open app
  - open application
  - launch
  - launch app
  - start app
  - run app
  - open spotify
  - open safari
  - open chrome
  - open notes
  - open finder
  - close app
  - close application
  - quit app
  - quit application
  - kill app
  - force quit
  - what apps are open
  - what's open
  - running apps
  - open applications
  - list apps
  - switch app
  - open folder
  - open file
  - open url
  - open link
  - open in browser
  - reveal in finder
  - show in finder
  - show in explorer
  - open downloads
  - open desktop
  - restart
  - reboot
  - restart my computer
  - restart my mac
  - shut down
  - shutdown
  - power off
  - turn off
  - sleep
  - go to sleep
  - lock
  - lock screen
  - log out
  - logout
  - sign out
tools:
  - name: app_open
    description: Open (launch) an application by name, optionally with a file or URL to open in it.
    parameters:
      name:
        type: string
        required: false
        description: Application name, e.g. "Safari", "Visual Studio Code".
      target:
        type: string
        required: false
        description: Optional file path or URL to open with the app (or with the default app if name is omitted).
  - name: app_quit
    description: Quit (close) a running application by name. Graceful by default; set force to kill it immediately.
    parameters:
      name:
        type: string
        required: false
        description: Application name to quit, e.g. "Spotify".
      force:
        type: boolean
        required: false
        description: Force-kill instead of quitting gracefully (may lose unsaved work). Default false.
  - name: app_list
    description: List the applications currently open (visible GUI apps).
    parameters: {}
  - name: open_path
    description: Open a file, folder, or URL with the OS default handler (file in its app, folder in the file manager, URL in the browser).
    parameters:
      path:
        type: string
        required: false
        description: Absolute path, ~-path, folder, or URL to open.
      reveal:
        type: boolean
        required: false
        description: Reveal/highlight the item in the file manager instead of opening it. Default false.
  - name: system_power
    description: Control the machine power state — restart, shutdown, sleep, lock, or logout.
    parameters:
      action:
        type: string
        enum: [restart, shutdown, sleep, lock, logout]
        description: Which power action to perform.
danger_patterns:
  - pattern: 'system_power[\s\S]*"action"\s*:\s*"(restart|shutdown|reboot|logout)"'
    level: destructive
    reason: Restarting, shutting down, or logging out closes every app — unsaved work may be lost
confirm_patterns:
  - pattern: 'app_quit[\s\S]*"force"\s*:\s*true'
    reason: Force-killing an app skips its save prompt — unsaved work may be lost
---

# System & application control

Open and close apps, open files/folders/URLs in their default handler, and
control the machine's power state. These tools issue native OS commands, so
they work without the browser or computer-use automation.

## When to use

- The user names an app to open or close ("open Spotify", "close Chrome").
- The user wants to open a file, folder, or link with its default app
  ("open my Downloads folder", "open this PDF", "open github.com").
- The user asks to restart, shut down, sleep, lock, or log out the machine.
- You need to know what apps are currently open before acting.

## Tools

- `app_open` — launch an app by name; optionally open a file/URL in it.
- `app_quit` — quit an app by name (graceful by default; `force` to kill it).
- `app_list` — list the currently open GUI apps.
- `open_path` — open a file/folder/URL with the OS default handler; `reveal`
  shows a file in the file manager instead of opening it.
- `system_power` — `restart` · `shutdown` · `sleep` · `lock` · `logout`.

## Rules

- **Match the user's intent exactly.** "Close X" → `app_quit` (graceful). Only
  pass `force: true` if they explicitly say force/kill or a graceful quit
  already failed — it can lose unsaved work.
- **`restart`, `shutdown`, and `logout` require confirmation** and will be
  shown to the user for approval before running. Don't call them speculatively;
  only when the user clearly asked. `sleep` and `lock` run without a prompt.
- **Prefer `open_path` over the shell.** To open a file/folder/URL, use
  `open_path`, not `shell_exec` with `open`/`xdg-open`/`start`.
- **Use the real app name.** On macOS that's the display name ("Visual Studio
  Code", not "code"). If a quit fails, the name may be wrong — `app_list` shows
  what's actually open.
- **Connected channels are not apps.** Telegram and WhatsApp are messaging
  channels Wolffish connects to, not local apps — never `app_open`, `app_quit`,
  or `app_list` them (or osascript a "Telegram"/"WhatsApp" window) to send or
  read messages. Use the channel tools (`telegram_send`, `whatsapp_send`, …)
  instead. `app_open` is only for launching unrelated local apps the user
  explicitly named.
- These commands target the **local machine** the user is sitting at.
