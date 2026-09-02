---
name: computer-use
description: Desktop automation — see the screen and control mouse/keyboard with a verified-aim loop. Screenshots, native-resolution zoom for precise targeting, clicks that return a magnified proof of where they landed, typing, shortcuts, scrolling, drag-and-drop.
triggers:
  - screenshot
  - click
  - screen
  - desktop
  - browser
  - open app
  - navigate
  - scroll
  - type into
  - mouse
  - keyboard
  - what's on my screen
  - computer use
  - automate
  - UI
  - display
  - monitor
  - window
  - application
  - app
  - cursor
  - pointer
  - drag
  - drop
  - button
  - menu
  - toolbar
  - icon
  - taskbar
  - dock
  - finder
  - right click
  - double click
  - hotkey
  - shortcut
  - press key
  - enter text
  - what do you see
  - show me
  - look at screen
  - visual
  - GUI
  - interface
  - native app
  - system tray
  - notification center
  - control panel
  - system preferences
  - spotlight
  - launchpad
  - activity monitor
  - task manager
  - file explorer
  - terminal app
  - text editor
  - fullscreen
  - minimize
  - maximize
  - resize window
  - switch window
  - alt tab
  - cmd tab
  - copy paste
  - undo redo
  - select all
  - right click menu
  - context menu
  - pixel
  - coordinate
  - position
  - zoom in
  - magnify
  - what is on screen
  - see my screen
  - look at my screen
  - interact with desktop
  - control my computer
  - click on
  - move mouse to
requires:
  - node
tools:
  - name: computer_glow_on
    description: 'Turn ON the screen indicator: a blue glow along the display''s edges plus a centered translucent notice telling the user their screen is being captured and controlled. CRITICAL: this MUST be your FIRST action in every computer-use session — call it before the first computer_screenshot, so the user is never watched or controlled without the signal. Once on, the indicator follows your actions across displays automatically and stays on until you call computer_glow_off; NOTHING turns it off for you. It is invisible in screenshots and never blocks clicks — turning it on costs nothing and skipping it is a trust violation, not an optimization.'
    parameters:
      display_index:
        type: number
        required: false
        description: 'Display to show the indicator on first (default 0 = primary). It follows your captures and actions to other displays automatically.'
  - name: computer_glow_off
    description: 'Turn OFF the screen indicator. CRITICAL: this MUST be your LAST action when you finish controlling the screen — and equally when you give up, hit an error you cannot recover from, or hand back to the user. Nothing clears the indicator automatically: if you end a session without calling this, the user is falsely told their screen is still being watched. On = first action, off = last action, every session, no exceptions.'
    parameters: {}
  - name: computer_screenshot
    description: 'See the screen. If the screen indicator is not on yet, call computer_glow_on FIRST — it must precede the first capture of every session. Captures the chosen display (default 0 = primary) and returns the image plus a Frame line stating its exact pixel size and the cursor position (marked with a magenta crosshair). This image becomes the CURRENT FRAME. Every mouse coordinate you give afterwards must be a pixel position read from the current frame, with (0,0) at its top-left — translation to real screen position (display scaling, Retina, monitor offsets) is fully automatic, so never use screen-resolution values and never add display offsets yourself. Screenshot again whenever the screen may have changed (after clicks that open things, typing, scrolling, app switches, page loads) — acting on an outdated image is the main cause of wrong clicks. If the target is small, crowded, or you are not certain of its exact position, do not guess: zoom into it with computer_zoom first. If this tool ever reports that its image was omitted because the active model cannot view images, computer use is impossible — stop immediately and tell the user to switch to a vision-capable model.'
    parameters:
      display_index:
        type: number
        required: false
        description: 'Index of the display to capture (default 0 = primary). Use computer_list_displays to see all of them, and screenshot each index in turn to find the app you need.'
  - name: computer_zoom
    description: 'Magnify a rectangular region of the current frame, captured fresh at up to native resolution — the precision instrument for small targets and small text. Pass the region in current-frame pixels; you get back a sharp close-up that becomes the NEW current frame, so you then click using the close-up''s own coordinates (far more accurate than clicking from the full screenshot). Magnification depends on region size: a NARROW region magnifies a lot, a wide region barely at all — the result states the factor, and if it warns the zoom is weak (under 2x), do not aim at small controls from it: zoom again into the narrower slice it suggests. Recommended flow for any small target: screenshot → locate it roughly → zoom a region around it (for example 300x200) → click its exact pixel in the zoom. To act outside the zoomed region, take a fresh computer_screenshot first.'
    parameters:
      x:
        type: number
        description: 'Left edge of the region, in current-frame pixels'
      y:
        type: number
        description: 'Top edge of the region, in current-frame pixels'
      width:
        type: number
        description: 'Region width in current-frame pixels'
      height:
        type: number
        description: 'Region height in current-frame pixels'
  - name: computer_mouse_click
    description: 'Click at (x, y) in CURRENT-FRAME pixels — or omit both to click at the cursor''s present position (use that after aiming with computer_mouse_move). The result objectively reports whether this display visibly changed right after the click, measured from before/after captures. NO visible change when you expected an immediate local effect (a toggle, a menu, a closed tab) means the click almost certainly missed — re-locate the target instead of reporting success. But the check samples one display for under half a second, so slow-loading results, effects on another display, and tiny low-contrast changes can evade it: when the effect might be slow or elsewhere, wait and verify with computer_screenshot, and NEVER re-click a side-effectful control (send, submit, buy, delete) on the report alone. The result also includes a magnified close-up taken right after the click, with a crosshair and full-width hairlines on the exact point pressed: the hairlines must pass through the CENTER of your target, "close" is a miss. The close-up is the new current frame, so corrections use its finer coordinates. Pass target (a short phrase naming what you are clicking) so the result can echo what to verify against. If the click should change the screen (open a menu, dialog, page), follow up with computer_screenshot; clicking a window of another app also focuses that app. Never click coordinates you have not read from the current frame.'
    parameters:
      x:
        type: number
        required: false
        description: 'X in current-frame pixels (omit x and y to click at the current cursor position)'
      y:
        type: number
        required: false
        description: 'Y in current-frame pixels (omit x and y to click at the current cursor position)'
      button:
        type: string
        required: false
        enum:
          - left
          - right
          - middle
        description: 'Mouse button to click (default left)'
      double:
        type: boolean
        required: false
        description: 'Double-click instead of single click'
      target:
        type: string
        required: false
        description: 'What you are clicking, as a short phrase (e.g. ''the ✕ on the GitHub tab'') — echoed back so verification checks the right thing'
  - name: computer_mouse_move
    description: 'Aim without clicking: moves the cursor to (x, y) in current-frame pixels and returns a magnified close-up with a crosshair and hairlines at the new position so you can verify the aim before committing. This is the RELIABLE way to hit tiny targets (close buttons, checkboxes, small icons): move first, check that the hairlines pass through the target''s center, then call computer_mouse_click with no coordinates to press that exact point — if the aim is off, move again using the close-up''s finer coordinates. Pass target to state what you are aiming at. Also useful to trigger hover states (tooltips, hover menus).'
    parameters:
      x:
        type: number
        description: 'X in current-frame pixels'
      y:
        type: number
        description: 'Y in current-frame pixels'
      target:
        type: string
        required: false
        description: 'What you are aiming at, as a short phrase — echoed back so verification checks the right thing'
  - name: computer_mouse_drag
    description: 'Press and hold at the start point, glide to the end point, and release — for drag-and-drop, sliders, resizing, and selecting text. All four coordinates are current-frame pixels, so for a precise drag first zoom into a region that contains BOTH endpoints and drag within that zoom; when source and destination are far apart, do a rough long drag first, then a short corrective drag inside one zoom. The dragged object ends up at the release point. Returns a magnified close-up of the release point (which becomes the current frame); take a computer_screenshot afterwards to confirm the result.'
    parameters:
      start_x:
        type: number
        description: 'Drag start X in current-frame pixels'
      start_y:
        type: number
        description: 'Drag start Y in current-frame pixels'
      end_x:
        type: number
        description: 'Drag end X in current-frame pixels'
      end_y:
        type: number
        description: 'Drag end Y in current-frame pixels'
      button:
        type: string
        required: false
        enum:
          - left
          - right
          - middle
        description: 'Mouse button to hold (default left)'
  - name: computer_mouse_scroll
    description: 'Scroll the mouse wheel. Direction ''down'' reveals content below. Scrolling affects whatever is UNDER the cursor, so pass x,y (current-frame pixels) to scroll a specific pane or list. The result includes a magnified view of the area under the cursor after the scroll, which becomes the current frame — when scrolling to find an item, look for it there and click it directly in the magnifier''s coordinates the moment it appears, scrolling again in small amounts otherwise. Pre-scroll coordinates are stale; take a fresh computer_screenshot for the wider picture.'
    parameters:
      direction:
        type: string
        enum:
          - up
          - down
          - left
          - right
        description: 'Scroll direction (''down'' reveals content below)'
      amount:
        type: number
        required: false
        description: 'Wheel notches to scroll (default 3)'
      x:
        type: number
        required: false
        description: 'Optional: move the cursor here first, in current-frame pixels'
      y:
        type: number
        required: false
        description: 'Optional: move the cursor here first, in current-frame pixels'
  - name: computer_keyboard_type
    description: 'Type text into the focused control. Click the target field first and make sure it has focus (a screenshot shows the caret), or the text goes somewhere else. Long or non-ASCII text (Arabic, emoji, accents) is pasted via the clipboard automatically so it arrives exactly as written. This does not press Enter — use computer_keyboard_press for that. Never type passwords or secrets unless the user explicitly provided them in the current conversation.'
    parameters:
      text:
        type: string
        description: 'The text to type'
  - name: computer_keyboard_press
    description: 'Press one key or a shortcut. Accepts a single key (enter, tab, escape, backspace, delete, space, up/down/left/right, home, end, pageup, pagedown, f1-f12, letters, digits, punctuation) or a combo in one string like ''cmd+s'', ''ctrl+shift+t'', ''alt+f4'' (a separate comma-separated modifiers parameter also works). Use cmd on macOS and ctrl on Windows/Linux. Shortcuts go to the FOCUSED app — click its window first if unsure. Prefer a reliable shortcut over clicking when both work (Enter to submit, Esc to dismiss, cmd+l for the address bar).'
    parameters:
      key:
        type: string
        description: 'Key or combo string (e.g. enter, tab, ''cmd+shift+4'')'
      modifiers:
        type: string
        required: false
        description: 'Comma-separated modifier keys to hold: ctrl, alt, shift, meta, cmd'
  - name: computer_list_displays
    description: 'List all connected displays with resolution, scale factor, position, and which one is primary. When the app you need is not on the display-0 screenshot, capture each display_index in turn until you find it, then keep using that index. Coordinates never need display offsets — they always refer to the latest returned image.'
    parameters: {}
  - name: computer_wait
    description: 'Wait for a specified duration before the next action — use 500-2000ms after actions that trigger animations, page loads, or dialogs. No cap; a wait cannot be interrupted once in flight, so split very long waits into several computer_wait calls.'
    parameters:
      ms:
        type: number
        description: 'Milliseconds to wait. No cap; split very long waits across multiple calls.'
confirm_patterns:
  - pattern: computer_mouse_click
    reason: Clicking on screen
  - pattern: computer_mouse_drag
    reason: Dragging on screen
  - pattern: computer_keyboard_type
    reason: Typing text
  - pattern: computer_keyboard_press
    reason: Pressing keys
  - pattern: computer_mouse_scroll
    reason: Scrolling
danger_patterns:
  - pattern: 'computer_keyboard_press.*(delete|backspace)'
    level: warn
    reason: Pressing delete/backspace key
  - pattern: 'computer_keyboard_type.*(sudo|rm -rf|password|secret|token)'
    level: destructive
    reason: Typing potentially dangerous or sensitive text
---

# Computer Use — Verified-Aim Desktop Automation

The agent sees and controls the desktop through a closed feedback loop designed for
surgical accuracy with any vision-capable model:

1. **One coordinate space, owned by the plugin.** Every image the tools return
   (screenshot, zoom, or click magnifier) becomes the *current frame*. The model
   always gives coordinates as pixels read off the latest image; the plugin does all
   translation to real screen position — screenshot downscaling, Retina/HiDPI scale
   factors, and multi-monitor offsets. The model never does coordinate math, which
   removes the entire class of "right target, wrong space" misses.
2. **A crosshair marks the cursor** on every returned image, so the model always
   knows where the pointer actually is. In aiming frames (zooms and magnifiers)
   thin hairlines additionally run from the image edges through the exact cursor
   pixel — a fat ring can visually swallow a 16px control that is actually 15px
   away, while a hairline either passes through the target or visibly does not.
3. **Zoom for small targets.** `computer_zoom` re-captures a chosen region at native
   resolution (up to 4x magnification). The zoomed image becomes the frame, so tiny
   controls are clicked in a space where they are dozens of pixels wide. A zoom
   below 2x is flagged in the result, with the region size that would reach 3x —
   weak "zooms" of wide regions are where small-target clicks historically missed.
4. **Every click returns proof — including an objective change report.**
   `computer_mouse_click` captures the screen before and after the press and
   reports what percentage of pixels changed around the cursor and across the
   display. "NO visible change" after a click that should have had an immediate
   local effect (closed a tab, opened a menu) means the click missed, regardless
   of how the close-up reads. The check samples one display for under half a
   second, so slow-painting results, cross-display effects, and sub-threshold
   changes evade it — the model is told to verify with a screenshot before
   retrying, and never to blindly re-click side-effectful controls. Click, move,
   and drag also return a 3x-magnified close-up with the crosshair and hairlines
   on the exact pixel acted on, which becomes the current frame so corrections
   happen in finer coordinates instead of by re-guessing on the full screenshot.

This mirrors the practices Anthropic uses for Claude's own computer use: act on the
latest image only, verify after every action, zoom rather than squint, prefer
keyboard shortcuts when they are more reliable than pointing.

## The Small-Target Playbook

For any control smaller than ~20 logical pixels (tab close buttons, checkboxes,
tiny icons), the reliable sequence is:

1. `computer_screenshot` → locate the target's neighborhood.
2. `computer_zoom` into a **narrow** region around it — narrow enough that the
   result reports 2x or more (the tool suggests the right size when it does not).
3. `computer_mouse_move` onto the target (pass `target` naming it), and check the
   hairlines pass through its **center** — "close" is a miss.
4. `computer_mouse_click` with **no coordinates**.
5. Read the click result's change report. **No change + an expected immediate
   local effect = it did not work**, no matter how plausible the close-up looks;
   re-aim instead of rationalizing. If the effect might be slow or land on
   another display, confirm with a screenshot first — and never re-click a
   send/submit-style control on the report alone.

Never click the cursor's current position just because the crosshair "looks like
it's on" the target — read the target's own coordinates from the image.

**Computer use requires a vision-capable model.** If the active Brain model cannot
accept images (for example DeepSeek's chat API, which is text-only), the runtime
strips the screenshots and the tools tell the model to stop and ask the user to
switch models — a text-only model cannot click accurately and is not allowed to
guess.

## Required Setup (macOS)

macOS sandboxes screen and input access behind system permissions. **All three must
be granted to Wolffish before computer-use tools will work.** These are one-time
grants that persist across restarts.

| Permission | What it unlocks | System Settings path | Error when missing |
|---|---|---|---|
| **Screen Recording** | `computer_screenshot`, `computer_zoom`, magnifier images | Privacy & Security › Screen Recording › enable **Wolffish** | `Failed to get sources` |
| **Accessibility** | mouse and keyboard tools | Privacy & Security › Accessibility › enable **Wolffish** | `not permitted` / `assistive access` |
| **Automation** | `osascript` commands (activate apps, list windows) via `shell_exec` | Privacy & Security › Automation › allow **Wolffish** to control target apps | `Not authorized to send Apple events` |

After granting **Screen Recording**, Wolffish must be restarted for the change to
take effect (macOS requirement). Accessibility and Automation take effect
immediately.

**Windows and Linux (X11)** do not require these permissions — computer-use tools
work out of the box. Wayland is not supported by the automation library.

### If a permission is missing

macOS silently fails the tool call rather than showing a prompt. The tool returns
one of the error strings above, and retrying will never succeed. The agent is
expected to stop using computer-use tools, name the missing permission and its
System Settings path, finish any non-visual parts of the task, and resume when the
user has granted it (restarting Wolffish if it was Screen Recording).

## Screen Indicator (Glow)

While computer use runs, the controlled display shows a living blue glow
along all four edges plus a small translucent pill in the center of the
screen reading "Wolffish is capturing your screen" (localized to the app's
UI language, English or Arabic). The glow breathes continuously, brightens
briefly on every capture, fades in on arrival and fades out when dismissed.

**Its lifecycle is 100% model-owned.** `computer_glow_on` is the mandatory
FIRST action of every computer-use session — before the first screenshot —
and `computer_glow_off` the mandatory LAST action, whether the task
succeeded, failed, or was abandoned. There is no idle timer and no
harness-side clearing: leaving the indicator on falsely tells the user their
screen is still being watched, and capturing before turning it on means they
were watched without the signal. While on, the indicator follows whichever
display the agent captures or acts on; the model never needs to move it.

The glow is drawn as narrow edge gradients (not a giant box-shadow, which
Chromium can drop per compositor tile on display-sized transparent
surfaces), and the overlay window pins itself to the display's exact bounds —
created with `enableLargerThanScreen` and snapped back on any OS-side move
or resize, because macOS otherwise re-clamps the frameless window to a
"visible frame" after showing, which is what used to push the bottom
border's glow off the screen.

The indicator never contaminates the loop: the window is content-protected
so it never appears in captures (on Linux it hides for the instant of each
capture instead), and it is click-through and non-focusable so input
synthesis is unaffected.

## Multiple Displays

`computer_screenshot` captures display 0 (primary) by default. When the target app
is elsewhere, `computer_list_displays` shows every monitor and the agent screenshots
each `display_index` until it finds the app, then stays on that index. Coordinate
translation to the right monitor — including monitors with negative origins or
different DPI — is automatic. There is deliberately no manual offset arithmetic
anywhere in the contract.

## Configuration

`config.json → computerUse`:

- `screenshotMaxWidth` — full-screenshot width cap in pixels (default 1280).
  Zoom and magnifier images are unaffected; they always render from the
  native-resolution capture.
- `screenshotFormat` — `jpeg` (default) or `png` for full screenshots. Zoom and
  magnifier images are always PNG for crisp text.

Screenshots, zooms, and click magnifiers are also saved under
`screenshots/conv-<id>/` in the workspace for chat rendering, channel
(Telegram/WhatsApp) delivery, and post-hoc aim forensics.

## Safety

- Clicking, dragging, typing, key presses, and scrolling are approval-gated
  (`confirm_patterns`); screenshots, zooms, and display listing are read-only.
- Typing text matching sensitive patterns (passwords, destructive commands) is
  flagged as destructive.
- The agent must never type credentials it was not explicitly given in the
  current conversation.
