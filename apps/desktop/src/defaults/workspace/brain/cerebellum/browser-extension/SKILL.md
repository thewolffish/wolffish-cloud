---
name: browser-extension
description: Open, read and drive any web page in the user's real browser — logins, paywalls and JS-heavy sites included. Reaches what web_fetch cannot, and acts as well as reads — navigate, click, fill forms, screenshot, scrape, manage tabs, run JavaScript. Chrome, Edge, Brave, Firefox, several at once.
triggers:
  - browser
  - extension
  - chrome
  - brave
  - edge
  - firefox
  - opera
  - which browser
  - web
  - navigate
  - click
  - tab
  - screenshot
  - cookie
  - page
  - url
  - form
  - download
  - scrape
  - open page
  - go to
  - visit
  - site
  - website
  - webpage
  - link
  - browse
  - surf
  - search
  - fill
  - submit
  - button
  - input
  - type
  - scroll
  - reload
  - refresh
  - bookmark
  - history
  - javascript
  - console
  - inspect
  - element
  - selector
  - dom
  - html
  - content
  - extract
  - read page
  - capture
  - new tab
  - close tab
  - switch tab
  - my browser
  - real browser
  - actual browser
  - connected browser
  - active tab
  - current tab
  - current page
  - open tabs
  - window management
  - browser window
  - resize window
  - full screen
  - developer tools
  - devtools
  - network tab
  - local storage
  - session storage
  - clear cache
  - clear cookies
  - notification
  - popup
  - in my browser
  - on this page
  - what's on the page
  - copy from page
  - read this page
  - grab from page
  - save this page
  - print this page
requires:
  - node
tools:
  # Navigation
  - name: ext_navigate
    description: Navigate to a URL in the Wolffish tab. Wolffish works in its own tab group, created on first use — the user's own tabs are never navigated away.
    parameters:
      url:
        type: string
        description: URL to navigate to.
      waitUntil:
        type: string
        description: When to consider navigation done.
        enum: [load, domcontentloaded]
        required: false
      newTab:
        type: boolean
        description: Open a fresh tab in the Wolffish group instead of reusing the current one. Use it when starting a new task or a new site.
        required: false
      tabId:
        type: number
        description: Target tab. Default the current Wolffish tab.
        required: false
  - name: ext_back
    description: Navigate back in browser history.
    parameters:
      tabId:
        type: number
        description: Target tab. Default active tab.
        required: false
  - name: ext_forward
    description: Navigate forward in browser history.
    parameters:
      tabId:
        type: number
        description: Target tab. Default active tab.
        required: false
  - name: ext_reload
    description: Reload the current page.
    parameters:
      hard:
        type: boolean
        description: Hard reload (bypass cache). Default false.
        required: false
      tabId:
        type: number
        description: Target tab. Default active tab.
        required: false
  # Page Interaction
  - name: ext_click
    description: Click an element on the page by CSS selector, or text=<visible text> to target by text.
    parameters:
      selector:
        type: string
        description: CSS selector of the element to click.
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_type
    description: Type text into an input element with optional human-like keystroke simulation.
    parameters:
      selector:
        type: string
        description: CSS selector of the input element.
      text:
        type: string
        description: Text to type.
      clearFirst:
        type: boolean
        description: Clear the field before typing. Default false.
        required: false
      humanize:
        type: boolean
        description: Simulate human typing with random delays. Default false.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_select
    description: Select a value from a dropdown/select element.
    parameters:
      selector:
        type: string
        description: CSS selector of the select element.
      value:
        type: string
        description: Value to select.
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_hover
    description: Hover over an element to trigger hover states.
    parameters:
      selector:
        type: string
        description: CSS selector of the element to hover.
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_scroll
    description: Scroll the page or a specific element.
    parameters:
      direction:
        type: string
        description: Scroll direction.
        enum: [up, down, left, right]
      amount:
        type: number
        description: Pixels to scroll. Default 500.
        required: false
      selector:
        type: string
        description: Element to scroll within. Default page.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_focus
    description: Focus an element on the page.
    parameters:
      selector:
        type: string
        description: CSS selector of the element to focus.
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_keypress
    description: Press a keyboard key or combination with optional modifiers.
    parameters:
      key:
        type: string
        description: Key to press (e.g. Enter, Tab, Escape, a).
      modifiers:
        type: string
        description: 'JSON array of modifier keys: ["ctrl"], ["shift"], ["alt"], ["meta"].'
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_drag_drop
    description: Drag an element and drop it on another.
    parameters:
      sourceSelector:
        type: string
        description: CSS selector of the drag source.
      targetSelector:
        type: string
        description: CSS selector of the drop target.
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_file_upload
    description: Upload files to a file input element.
    parameters:
      selector:
        type: string
        description: CSS selector of the file input.
      files:
        type: string
        description: 'JSON array of files: [{"name":"file.txt","content":"base64data","mimeType":"text/plain"}].'
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_set_value
    description: 'Set an input/textarea/contenteditable value reliably and instantly via the framework-safe native setter (plus input/change events). The dependable way to fill a form field — React/SPA apps register it where synthetic ext_type does not. Pair with ext_submit_form.'
    parameters:
      selector:
        type: string
        description: CSS selector (or text=) of the field to fill.
      value:
        type: string
        description: The value to set (replaces existing content).
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_submit_form
    description: 'Submit the form containing the selector (or a form selector, or the currently focused field). Uses form.requestSubmit() — the reliable replacement for hunting and clicking a submit/post button. Falls back to clicking the submit control, then form.submit().'
    parameters:
      selector:
        type: string
        description: A selector inside or of the form. Omit to submit the focused field's form.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  # Page Reading
  - name: ext_read_page
    description: Extract page content as text, markdown, or HTML.
    parameters:
      format:
        type: string
        description: Output format.
        enum: [text, markdown, html]
        required: false
      selector:
        type: string
        description: Extract only from this element. Default whole page.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_query_selector
    description: Query DOM elements matching a CSS selector. Returns tag, text, attributes, rect.
    parameters:
      selector:
        type: string
        description: CSS selector to query.
      attributes:
        type: string
        description: JSON array of attribute names to extract.
        required: false
      limit:
        type: number
        description: Max elements to return. Default 20.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_get_attribute
    description: Get specific attributes from an element.
    parameters:
      selector:
        type: string
        description: CSS selector of the element.
      attributes:
        type: string
        description: JSON array of attribute names to read.
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_get_value
    description: Get the current value of an input/textarea/select element.
    parameters:
      selector:
        type: string
        description: CSS selector of the form element.
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_get_url
    description: Get the current URL and title of the active tab.
    parameters:
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_get_page_info
    description: Get comprehensive page info — URL, title, description, favicon, language, links, headings, forms.
    parameters:
      tabId:
        type: number
        description: Target tab.
        required: false
  # Tab Management
  - name: ext_tabs_list
    description: List all open tabs with id, url, title, active state, and a wolffish flag that is true for tabs in the Wolffish tab group and false for the user's own tabs.
    parameters:
      windowId:
        type: number
        description: Filter to a specific window. Default all windows.
        required: false
  - name: ext_tab_open
    description: Open a new tab inside the Wolffish tab group and make it the current target, optionally with a URL.
    parameters:
      url:
        type: string
        description: URL to open. Default blank tab.
        required: false
      active:
        type: boolean
        description: Make the new tab active. Default true.
        required: false
  - name: ext_tab_close
    description: Close a specific tab.
    parameters:
      tabId:
        type: number
        description: ID of the tab to close.
  - name: ext_tab_switch
    description: Switch to a specific tab.
    parameters:
      tabId:
        type: number
        description: ID of the tab to activate.
  - name: ext_tab_duplicate
    description: Duplicate a tab.
    parameters:
      tabId:
        type: number
        description: ID of the tab to duplicate.
  - name: ext_tab_move
    description: Move a tab to a different position or window.
    parameters:
      tabId:
        type: number
        description: ID of the tab to move.
      index:
        type: number
        description: Target position index.
      windowId:
        type: number
        description: Target window. Default current window.
        required: false
  # Window Management
  - name: ext_windows_list
    description: List all open browser windows.
    parameters: {}
  - name: ext_window_open
    description: Open a new browser window. Its tab sits outside the Wolffish tab group, so address it with the returned tabId. Prefer ext_tab_open unless a separate window is really needed.
    parameters:
      url:
        type: string
        description: URL to open.
        required: false
      incognito:
        type: boolean
        description: Open in incognito mode.
        required: false
      width:
        type: number
        description: Window width.
        required: false
      height:
        type: number
        description: Window height.
        required: false
  - name: ext_window_close
    description: Close a browser window.
    parameters:
      windowId:
        type: number
        description: ID of the window to close.
  - name: ext_window_resize
    description: Resize or reposition a browser window.
    parameters:
      windowId:
        type: number
        description: ID of the window.
      width:
        type: number
        description: New width.
        required: false
      height:
        type: number
        description: New height.
        required: false
      left:
        type: number
        description: New X position.
        required: false
      top:
        type: number
        description: New Y position.
        required: false
      state:
        type: string
        description: Window state.
        enum: [normal, minimized, maximized, fullscreen]
        required: false
  # Screenshots & Visual
  - name: ext_screenshot
    description: Take a screenshot of the current page or a specific element. Returns the image inline for your own eyes and saves it to a file whose path is on the result's last line — send_file that path when the moment is worth showing the user.
    parameters:
      format:
        type: string
        description: Image format.
        enum: [png, jpeg]
        required: false
      quality:
        type: number
        description: JPEG quality 0-100. Only for jpeg.
        required: false
      fullPage:
        type: boolean
        description: Capture the full scrollable page.
        required: false
      selector:
        type: string
        description: CSS selector to screenshot a specific element.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_pdf
    description: Save the current page as a PDF. Returns the file path.
    parameters:
      tabId:
        type: number
        description: Target tab.
        required: false
  # Cookies & Storage
  - name: ext_cookies_get
    description: Get cookies for a domain.
    parameters:
      domain:
        type: string
        description: Cookie domain to query.
      name:
        type: string
        description: Filter by cookie name.
        required: false
  - name: ext_cookies_set
    description: Set a cookie.
    parameters:
      url:
        type: string
        description: URL to associate the cookie with.
      name:
        type: string
        description: Cookie name.
      value:
        type: string
        description: Cookie value.
      domain:
        type: string
        description: Cookie domain.
        required: false
      path:
        type: string
        description: Cookie path.
        required: false
      expires:
        type: number
        description: Expiry timestamp.
        required: false
      httpOnly:
        type: boolean
        description: HTTP-only flag.
        required: false
      secure:
        type: boolean
        description: Secure flag.
        required: false
  - name: ext_cookies_remove
    description: Remove a cookie.
    parameters:
      url:
        type: string
        description: URL of the cookie.
      name:
        type: string
        description: Cookie name to remove.
  - name: ext_storage_get
    description: Get data from the page's localStorage or sessionStorage.
    parameters:
      type:
        type: string
        description: Storage type.
        enum: [local, session]
      keys:
        type: string
        description: JSON array of key names. Default all keys.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_storage_set
    description: Set data in the page's localStorage or sessionStorage.
    parameters:
      type:
        type: string
        description: Storage type.
        enum: [local, session]
      data:
        type: string
        description: JSON object of key-value pairs to set.
      tabId:
        type: number
        description: Target tab.
        required: false
  # Clipboard
  - name: ext_clipboard_read
    description: Read the clipboard text content.
    parameters: {}
  - name: ext_clipboard_write
    description: Write text to the clipboard.
    parameters:
      text:
        type: string
        description: Text to write to the clipboard.
  # Downloads
  - name: ext_download
    description: Download a file from a URL.
    parameters:
      url:
        type: string
        description: URL of the file to download.
      filename:
        type: string
        description: Suggested filename.
        required: false
  # JavaScript Execution
  - name: ext_execute_js
    description: Execute JavaScript code in the page context. DANGEROUS — requires user approval.
    parameters:
      code:
        type: string
        description: JavaScript code to execute.
      tabId:
        type: number
        description: Target tab.
        required: false
      world:
        type: string
        description: Execution world.
        enum: [ISOLATED, MAIN]
        required: false
  # Wait & Polling
  - name: ext_wait
    description: Generic wait. With a selector, waits for that element to appear; without one, sleeps for the given duration. No cap on the sleep — you decide. A wait cannot be interrupted once in flight, so split very long waits into several calls.
    parameters:
      type:
        type: string
        description: Wait type. Inferred when omitted (selector given → selector, else timeout).
        enum: [selector, navigation, network_idle, timeout]
        required: false
      selector:
        type: string
        description: CSS selector to wait for (type=selector).
        required: false
      ms:
        type: number
        description: Sleep duration in ms for plain waits. No cap — you decide; omit it and the wait returns immediately (no minimum). Split very long waits across several ext_wait calls so each stays interruptible.
        required: false
      timeout_ms:
        type: number
        description: Max wait time in ms (alias accepted for any wait type).
        required: false
      visible:
        type: boolean
        description: Wait for the element to be visible. Default false.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_wait_for
    description: Wait for an element to appear on the page.
    parameters:
      selector:
        type: string
        description: CSS selector to wait for.
      timeout:
        type: number
        description: Max wait time in ms. Default 30000.
        required: false
      visible:
        type: boolean
        description: Wait for the element to be visible. Default false.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_wait_for_navigation
    description: Wait for the next page navigation to complete.
    parameters:
      timeout:
        type: number
        description: Max wait time in ms. Default 30000.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_wait_for_network_idle
    description: Wait until network activity settles.
    parameters:
      timeout:
        type: number
        description: Max wait time in ms. Default 30000.
        required: false
      idleTime:
        type: number
        description: Time with no requests to consider idle. Default 500ms.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  # Notifications
  - name: ext_notify
    description: Show a browser notification.
    parameters:
      title:
        type: string
        description: Notification title.
      message:
        type: string
        description: Notification body text.
      iconUrl:
        type: string
        description: URL of the notification icon.
        required: false
  # Debugger Mode
  - name: ext_debugger_attach
    description: 'Attach Chrome debugger to a tab for trusted input events (isTrusted: true). All subsequent interactions on that tab use CDP instead of content scripts.'
    parameters:
      tabId:
        type: number
        description: ID of the tab to attach the debugger to.
  - name: ext_debugger_detach
    description: Detach the debugger from the currently attached tab. No-op if nothing is attached.
    parameters: {}
  - name: ext_debugger_status
    description: Check whether the debugger is currently attached and to which tab.
    parameters: {}
  # Mouse Interaction (coordinate- or selector-based)
  - name: ext_mouse_move
    description: Move the cursor to target coordinates along a bezier curve path. In debugger mode, produces real mouse movement events.
    parameters:
      x:
        type: number
        description: Target X coordinate (viewport pixels from left).
      y:
        type: number
        description: Target Y coordinate (viewport pixels from top).
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_mouse_click
    description: 'Click at viewport coordinates (x,y) OR a selector. Produces trusted input (isTrusted: true) in debugger mode. Use coordinates for canvas, maps, SVG, games, and custom widgets where no stable CSS selector exists.'
    parameters:
      x:
        type: number
        description: Target X (viewport pixels). Provide x and y together, or use selector instead.
        required: false
      y:
        type: number
        description: Target Y (viewport pixels).
        required: false
      selector:
        type: string
        description: CSS selector or text=<visible text>, resolved to the element center. Alternative to x/y.
        required: false
      button:
        type: string
        description: Mouse button.
        enum: [left, right, middle]
        required: false
      double:
        type: boolean
        description: Double-click instead of single click. Default false.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_mouse_down
    description: Press and HOLD a mouse button at coordinates or a selector. Compose with ext_mouse_move then ext_mouse_up for custom gestures (drawing on canvas, dragging sliders, press-and-hold). Real button-hold only in debugger mode.
    parameters:
      x:
        type: number
        description: Target X (viewport pixels). Provide x and y together, or use selector.
        required: false
      y:
        type: number
        description: Target Y (viewport pixels).
        required: false
      selector:
        type: string
        description: CSS selector or text=<visible text>, resolved to the element center.
        required: false
      button:
        type: string
        description: Mouse button to press.
        enum: [left, right, middle]
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_mouse_up
    description: Release a held mouse button at coordinates or a selector. Pairs with ext_mouse_down.
    parameters:
      x:
        type: number
        description: Target X (viewport pixels).
        required: false
      y:
        type: number
        description: Target Y (viewport pixels).
        required: false
      selector:
        type: string
        description: CSS selector or text=<visible text>, resolved to the element center.
        required: false
      button:
        type: string
        description: Mouse button to release.
        enum: [left, right, middle]
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_mouse_drag
    description: 'Drag from a start point to an end point (press → move with the button held → release). Provide startX/startY + endX/endY, or sourceSelector + targetSelector. Much more reliable than ext_drag_drop for canvas, kanban boards, and sliders — especially in debugger mode, where it is a real coordinate drag.'
    parameters:
      startX:
        type: number
        description: Drag start X (viewport pixels). Use with startY/endX/endY, or use the selector pair.
        required: false
      startY:
        type: number
        description: Drag start Y (viewport pixels).
        required: false
      endX:
        type: number
        description: Drag end X (viewport pixels).
        required: false
      endY:
        type: number
        description: Drag end Y (viewport pixels).
        required: false
      sourceSelector:
        type: string
        description: CSS selector or text=<visible text> of the drag source. Alternative to startX/startY.
        required: false
      targetSelector:
        type: string
        description: CSS selector or text=<visible text> of the drop target. Alternative to endX/endY.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_element_from_point
    description: Describe the topmost element at viewport coordinates (x,y) — tag, text, attributes, and bounding rect. Pair with ext_screenshot to identify what is under a pixel before clicking it.
    parameters:
      x:
        type: number
        description: X coordinate (viewport pixels from left).
      y:
        type: number
        description: Y coordinate (viewport pixels from top).
      tabId:
        type: number
        description: Target tab.
        required: false
  - name: ext_get_interactive_elements
    description: List visible interactive elements (links, buttons, inputs, [role=button], etc.) with their center coordinates, bounding rect, text label, and key attributes. The map for clicking and moving through a web app — read it, then act by coordinates (ext_mouse_click) or by a selector built from id/name/aria-label.
    parameters:
      selector:
        type: string
        description: Limit the scan to descendants of this container. Default whole document.
        required: false
      limit:
        type: number
        description: Max elements to return. Default 50.
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  # Humanize
  - name: ext_humanize
    description: Inject a single random human-like micro-action (pause, scroll, cursor drift) between real actions to break robotic patterns.
    parameters:
      intensity:
        type: string
        description: How pronounced the micro-action should be.
        enum: [light, moderate, heavy]
        required: false
      tabId:
        type: number
        description: Target tab.
        required: false
  # Wolffish tab group
  - name: ext_set_activity
    description: Label the Wolffish tab group with an emoji and a few words for what you are doing — the only thing the user sees while you work. Leave the default Wolffish for one-off basics like opening a page or a single lookup. Set a label for anything that is a real task — several steps, more than one page, or more than a moment — so it is clear what their browser is doing. Update it as the work moves between phases; call with no arguments to reset.
    parameters:
      emoji:
        type: string
        description: A single emoji for the current activity.
        required: false
      text:
        type: string
        description: A few words describing the activity. Keep it under about 24 characters — tab groups are narrow.
        required: false
  # Starting a browser
  - name: ext_launch_browser
    description: Start a browser on the user's machine so the Wolffish extension can connect. Use it when no browser is connected. Opens the default browser, or the first supported one installed, then waits for the extension to come online. Works on macOS, Windows and Linux.
    parameters:
      browser:
        type: string
        description: Launch this browser specifically. One of chrome, edge, brave, arc, vivaldi, opera, chromium, firefox. Omit to use the user's default browser.
        required: false
      wait_ms:
        type: number
        description: How long to wait for the extension to connect, in milliseconds. Default 30000, 0 to return immediately.
        required: false
  # Multi-browser
  - name: ext_browsers
    description: List the browsers currently connected through the Wolffish extension — name, version, OS, signed-in profile email, and the selection key for ext_use_browser. Two profiles of the same browser are two entries told apart by profile email. With one browser connected every ext_* tool targets it automatically.
    parameters: {}
  - name: ext_use_browser
    description: Choose which connected browser this conversation drives. Required before other ext_* tools when several browsers are connected. Pick it yourself when the user named a browser or context makes it obvious; otherwise ask the user first. Tabs, cookies and logins are separate per browser.
    parameters:
      browser:
        type: string
        description: Selection key, slug, name, or profile-email fragment of a connected browser (see ext_browsers), e.g. chrome, edge-2, firefox, work@company.com.
danger_patterns:
  - pattern: 'ext_execute_js\s.*document\.cookie'
    level: block
    reason: Cookie exfiltration via JS
  - pattern: 'ext_execute_js\s.*navigator\.sendBeacon'
    level: block
    reason: Beacon data exfiltration
confirm_patterns:
  - pattern: '^ext_execute_js\s'
    reason: Executing arbitrary JavaScript in the page
  - pattern: '^ext_download\s'
    reason: Downloading a file from the web
  - pattern: 'ext_cookies_set'
    reason: Modifying browser cookies
  - pattern: 'ext_navigate\s.*(?:bank|paypal|venmo|stripe\.com|checkout|payment)'
    reason: Navigating to a financial or payment site
version: 1.7.2
---

# Browser Extension

Control the user's real browser (Chrome, Edge, Brave, Firefox, …) through the Wolffish extension. This operates in the user's actual browser — their cookies, logins, extensions, and open tabs are all available. Several browsers can be connected at the same time.

## Tool Naming

All tools use the `ext_` prefix. The wire protocol translates these to `browser_` commands. For example `ext_navigate` sends `browser_navigate` to the extension.

## Multiple browsers

The extension can be connected from several browsers at once (e.g. Chrome and Edge). Every connected browser is a fully separate world: its own tabs, tab ids, windows, cookie jars, logins, and its own debugger attachment.

- **One browser connected** — nothing to do; every `ext_*` tool targets it automatically.
- **Several connected** — each conversation drives exactly one browser at a time. Pick it with `ext_use_browser` (the choice sticks for the rest of the conversation; call it again to switch). Until a browser is picked, `ext_*` tools return an error listing the connected browsers.
- **How to pick**: if the user named a browser ("open it in Edge") or the context makes it obvious (the site is logged in only in Chrome, earlier in the conversation you were working in Brave), call `ext_use_browser` yourself and briefly say which browser you're using. If there is no signal which browser the user means, ask them before acting.
- **Profiles**: two Chrome profiles are two separate connections with separate logins. `ext_browsers` reports each profile's signed-in email — use it to tell them apart ("work" vs "personal") and pass an email fragment to `ext_use_browser` when the user means a specific profile.
- `ext_browsers` lists what is connected (name, version, OS, profile email, selection key) — check it when unsure what's available.
- Selection keys are stable while the app runs: a browser that reloads or reconnects keeps its key (chrome-2 stays the same profile). After an app restart keys may be assigned afresh — re-check `ext_browsers` rather than assuming.
- Never mix ids across browsers: a `tabId` from `ext_tabs_list` in Chrome is meaningless in Edge. After switching browsers, re-list tabs before acting on them.

## Selectors

Selectors are standard CSS: `#id`, `.class`, `input[name="email"]`, `div.container > a.link`. As a convenience, a selector of the form `text=<visible text>` targets the deepest visible element whose text matches (exact preferred over substring) — handy for buttons/links with no stable selector, and it works the same whether or not the debugger is attached. Other Playwright pseudo-selectors (`:has-text()`, `:contains()`, `role=`) are NOT supported. See the fuller Selectors note below.

## Reading Pages

- `ext_read_page` with `format: text` is the most reliable for extracting visible content. Scripts, styles, and hidden elements are automatically stripped.
- For large/complex pages (LinkedIn, Gmail, etc.), target a specific container with the `selector` param instead of reading the whole page — e.g. `selector: "main"` or `selector: ".content"`.
- Modern sites lazy-load content as you scroll. If a section is empty, scroll down with `ext_scroll` then read again.

## When this is the right tool (and when it isn't)

This capability is the strongest way to reach the web, not the cheapest. Prefer it whenever reach or reliability matters:

- The task names a **specific site**, or needs one that is logged-in, paid-for, paywalled, or behind a consent/bot wall — the user's own session is already authenticated here.
- The page is **JS-rendered** (most modern apps), infinite-scrolls, or hides content behind a click. `web_fetch` returns an empty shell for these; you see the page as the user does.
- The work is **more than reading** — filling a form, posting, downloading, checking out, clicking through a flow.
- A `web_fetch` already came back thin, boilerplate, or paywalled. Don't retry the fetch; come here.
- The task spans **several pages** — the per-page cost of a fetch-then-fail cycle overtakes opening the browser once.

Hand back to `web_search` when the question is genuinely a single lookup and a snippet answers it, or when you need to discover *which* URL to open before opening it. Search first, then open the result here, is a good pattern — better than opening a search engine in the browser and reading its results page.

If nothing is connected, `ext_launch_browser` starts the user's browser. If it can't, say so plainly and fall back to `web_search` / `web_fetch` rather than stalling the task.

## Your own tab group

You work in a **Wolffish tab group**, never in the user's tabs. The first command that needs a page creates a fresh tab, coloured blue and labelled `Wolffish`, and every later command lands there by default. The user's own tabs are never navigated, clicked, or typed into.

- **Never reuse an open tab.** There is nothing to opt into — the default target is always your own tab. Start a new task or a new site in a *fresh* one with `ext_navigate {url, newTab: true}` or `ext_tab_open {url}` rather than reusing the tab from an unrelated task.
- **Working across sites**: open each in its own tab (they all join the group) and move between them with `ext_tab_switch`.
- **Reading the user's page**: only when they ask for it ("what's on this page?"). Call `ext_tabs_list`, find the entry with `wolffish: false` and `active: true`, and pass its `tabId` explicitly. An explicit `tabId` always wins over the default. Never *act* on a user tab — read it, then do the work in your own.
- If the user closes your tab or the whole group, the next command quietly creates a new one.

## Saying what you're doing

The tab group's name is yours to write, and it is the only thing the user sees while you work. Judge how much it needs to say:

- **One-off basics don't need a label.** Opening a page, a single lookup, one quick read — plain `Wolffish` already says everything useful. Don't ceremonially label trivial work.
- **A real task does.** Anything spanning several steps, more than one page, or more than a moment: set it as you start — `ext_set_activity {emoji: "🔎", text: "Comparing flights"}` → the group reads `🔎 Comparing flights`. Otherwise the user is watching their browser move with no idea what it's doing, which is the whole problem this solves.
- **Keep it current.** Update it when the work moves on — a new site, a new phase, filling a form vs reading results. A stale label is worse than none.
- Pick the emoji and wording yourself; there is no fixed vocabulary. Short is better — tab groups show roughly 24 characters. `📖 Reading docs`, `🛒 Checking out`, `✍️ Writing reply`, `📸 Capturing page`.
- **Reset when you're done**: `ext_set_activity` with no arguments puts it back to plain `Wolffish`.
- It's cosmetic — a browser without tab-group support just skips it, and it never fails a task.
- The label is desktop-only: a user on Telegram, WhatsApp, or the mobile app never sees it. For them, delivered screenshots are how you show what's happening — see **Screenshots** below.

## When no browser is connected

If `ext_*` tools report that the extension is not connected, the browser is probably not running. Call **`ext_launch_browser`** — it starts the user's default browser (or a named one), waits for the extension to connect, and reports back. Then carry on with the task.

- Launch first, ask second: this is a normal recovery step, not something to check in about.
- If it launches but the extension never connects, the extension isn't installed in that browser — say so, and offer to try another with `ext_launch_browser {browser: "chrome"}`.

## Screenshots — and showing the user what you see

`ext_screenshot` returns the image inline **and** saves it to a file — the result's last line is the saved path. Use `fullPage: true` for full scrollable page captures, or `selector` for a specific element.

The inline image is for your eyes only: tool results are invisible outside the verbose in-app feed, and a user on Telegram, WhatsApp, or the mobile app cannot see the browser at all. Showing them what's happening is yours to do, and one call does it on every surface — **`send_file` the saved path**, and it renders as an image in the in-app chat and arrives as a real photo on Telegram/WhatsApp, mid-task, the moment you send it.

**Send the important shots, not the stream.** On any real task — several steps, several pages, or work the user handed off and walked away from — a few well-chosen screenshots ARE the status updates, each introduced by a one-line caption in your prose:

- **Milestones** — the result page that matters, a filled form just before a significant submit, the confirmation right after it, the final state that proves the task is done.
- **Surprises** — an unexpected page, an error state, a login wall or CAPTCHA. When you report a blocker, show it.
- **Things the user would want to eyeball** — the price you found, the listing you picked, a draft about to be posted in their name.

Routine navigation, scroll steps, and near-identical retakes stay private — a feed of every capture is noise that buries the shot that mattered. How many is right is your judgment per task: a quick lookup usually needs none; a long autonomous run earns a handful. (Workflow agents have no `send_file`: list the milestone shots' paths in your report, flagged as worth showing, and the master delivers.)

## Debugger Mode — prefer it for everything

Debugger mode is the best way to drive a page, and you should attach it by default before interacting with any web app. It is the single most important setting for reliable browser control — when in doubt, attach.

**Why it is the best mode.** With the debugger attached, every interaction is dispatched through the Chrome DevTools Protocol as a *trusted* browser input event (`isTrusted: true`), indistinguishable from a real human. This is strictly better than the content-script fallback (synthetic `isTrusted: false` events):

- **Real coordinate input.** `ext_mouse_click`, `ext_mouse_down`/`ext_mouse_up`, `ext_mouse_drag`, and `ext_mouse_move` produce genuine pointer input only when attached. That is what lets you operate canvas apps, maps, `<svg>`, games, drag-and-drop boards, and sliders — surfaces with no clickable DOM node.
- **Reliable drag.** `ext_mouse_drag` becomes a real press-move-release gesture (the way Playwright/Puppeteer drag) instead of synthetic HTML5 DragEvents that most modern apps ignore.
- **Passes input checks.** Sites that gate on trusted events or automation fingerprints (social platforms, banking, checkout) accept the input.
- **Faithful typing and keys.** `ext_type` and `ext_keypress` fire real key events with correct keycodes.

**Always attach.** Before interacting with a page (click, type, scroll, mouse, drag), the sequence is always:

1. `ext_debugger_status` — check whether something is already attached.
2. `ext_debugger_attach` with the target tab's `tabId` — unless it is already attached to that tab. **Attach even for a single "simple" click** — there is no downside and everything gets more reliable.
3. Do your work — clicks, typing, mouse, drag, screenshots, reading.
4. `ext_debugger_detach` when you are done with all browser interactions for the turn.

If `ext_debugger_attach` fails (a restricted page like `chrome://`, DevTools already open, or another debugger attached), proceed without it — every interaction command falls back to content-script mode automatically, just with synthetic events. Don't abort the task over a failed attach; continue.

**Always detach** when finished. Never leave the debugger attached between turns — Chrome shows a "Wolffish is debugging this browser" banner the entire time it is attached, so a forgotten detach leaves that banner up. You can only attach one tab at a time per connected browser; attaching to a different tab auto-detaches the previous one.

## Mouse control & coordinates

Every action targets either a **selector** (when the element has a usable CSS selector or unique visible text) or **viewport coordinates** (when it doesn't — canvas, maps, SVG, games, custom-drawn widgets). The coordinate mouse tools accept either.

Coordinates are **viewport pixels** — the same space `ext_screenshot` reports (it tells you `x 0–W, y 0–H`) and that `ext_query_selector` / `ext_get_interactive_elements` return in `rect`/`center`. To drive a page you can't select into:

1. `ext_screenshot` to see it, or `ext_get_interactive_elements` to list clickable targets with their center coordinates and attributes.
2. `ext_element_from_point` to confirm what's under a coordinate before acting (optional, avoids mis-clicks).
3. `ext_mouse_click` / `ext_mouse_drag` at the coordinates.

- `ext_mouse_click` — left/right/middle, single or double, by point or selector. Right-click triggers the page's own context-menu handler (web apps with a custom menu); on a plain page it triggers the native menu.
- `ext_mouse_down` + `ext_mouse_move` + `ext_mouse_up` — compose a custom gesture: draw on a canvas, drag a slider, press-and-hold.
- `ext_mouse_drag` — the one-shot version: source point/selector → target point/selector. Prefer it over `ext_drag_drop` for canvas/kanban/sliders.

These are **trusted input only when the debugger is attached** (see above). Without it they fall back to synthetic events, which work on ordinary DOM but not on canvas or pointer-gated widgets — one more reason to attach first.

## Humanize

When interacting with social media platforms, e-commerce sites, or any page that may detect automation, call the `ext_humanize` command BETWEEN your real actions.

Do not call humanize before your first action or after your last action. Call it between actions. Example flow:

1. ext_click (on comment menu)
2. ext_humanize
3. ext_click (on delete button)
4. ext_humanize
5. ext_scroll (to next comment)
6. ext_click (on comment menu)
7. ext_humanize
8. ext_click (on delete button)

Use intensity `light` for fast tasks with few actions. Use `moderate` for longer sequences. Use `heavy` only when interacting with platforms known for aggressive bot detection.

Humanize is not needed for DOM reading, screenshots, or non-interaction commands. Only use it between physical interaction commands (`ext_click`, `ext_type`, `ext_scroll`, `ext_mouse_click`, `ext_mouse_drag`, `ext_mouse_move`).

## Typing text

`ext_type` types **character by character**, firing real keydown/keypress/input/keyup events for each one. This is on by default (`humanize: true`) and is what makes input look typed rather than pasted — keep it on for any page where detection matters.

- **It is not instant.** A short field is sub-second; a long post body takes a few seconds. That is expected — let the command finish. There is **no execution timeout**, so even a very long body will complete. Do not "give up" and retry, and do not split the text into chunks to beat a timeout — that just stacks duplicated, garbled text.
- **One `ext_type` per field.** Send the entire value in a single call. Don't loop character-by-character yourself.
- **Replacing existing text:** pass `clearFirst: true` to clear the field first. Without it, text is *appended* to whatever is already there — so never re-send a failed/partial `ext_type` without `clearFirst`, or you'll pile a partial on top of a partial.
- **When speed matters more than realism** (long text on a page that doesn't fingerprint input, or a plain form), pass `humanize: false` to insert the whole string at once — or use `ext_set_value`, which is instant *and* framework-safe (see below).
- Don't sprinkle `ext_humanize` inside a single `ext_type` — the per-keystroke timing is already built in. `ext_humanize` is only for pauses *between separate* interaction commands.

## Filling & submitting forms (comments, posts, search)

This is the highest-leverage workflow to get right — filling a field and submitting is where naive automation wastes the most steps. The reliable pattern is **three calls**:

1. `ext_click` the field (focus it).
2. `ext_set_value` with the text. This sets the value through the **native setter + input/change events**, so React/SPA frameworks actually register it. Plain `ext_type humanize:false` assigns `el.value` directly, which React silently reverts — the field *looks* filled but the component state stays empty, so the submit posts nothing. Use `ext_set_value` for any framework-driven form. (Use `ext_type` only when you specifically need humanized keystrokes for stealth on a plain field.)
3. `ext_submit_form` (pass the field selector, or nothing to submit the focused field's form). This calls `form.requestSubmit()` — the real, cancelable submit event that server-rendered forms and jQuery/old-style sites listen for. **Do not** hunt for the submit button by selector (`.usertext-buttons button`, `button:has-text("save")`, `text=save`, Tab→Enter, …) — that roulette is exactly what to avoid.

**On a failed submit, do NOT re-type.** Re-typing a long body with `ext_type` costs 10–60s every time. Instead: `ext_get_value` to confirm the field still holds your text (it usually does), then just call `ext_submit_form` again. Only re-fill (with `ext_set_value`, which is instant) if the field is actually empty.

**Attach the debugger first.** Submits that depend on a real click/keystroke need trusted input — attach before you start interacting, not after several failed attempts (see Debugger Mode).

**Prefer a server-rendered surface when one exists.** Heavy SPAs (e.g. new Reddit) render controls inside **shadow DOM**, which `text=`/`querySelector` cannot pierce — so "Add a comment" / composer buttons won't be found. If the site has a classic server-rendered version (e.g. `old.reddit.com`), drive that instead: plain `<form>` + `<textarea>`, and `ext_set_value` + `ext_submit_form` just work.

**Verify once.** After submitting, navigate to where the content appears (e.g. your user profile's comments) and `ext_read_page` to confirm it's live, then capture the permalink a single time — don't re-verify in a loop.

## Selectors (full note)

Selectors are plain **CSS** (passed to `querySelector`/`querySelectorAll`), with one convenience extension — `text=<visible text>`:

- ✅ `button[type="submit"]`, `[aria-label="Post"]`, `[name="title"]` — CSS
- ✅ `text=Post`, `text=Submit` — match by visible text (deepest visible match; exact beats substring). Works in `ext_click`, `ext_hover`, `ext_wait_for`, and the mouse tools, with or without the debugger.
- ❌ `button:has-text("Post")`, `:contains("Submit")`, `role=button` — jQuery/Playwright pseudo-selectors throw "selector syntax is incorrect"

When an element has neither a stable CSS selector nor unique text, use `ext_get_interactive_elements` to list candidates with their center coordinates and attributes, then act by coordinates (`ext_mouse_click`) or build a selector from the returned `id`/`name`/`aria-label`.

## Capturing the page

To see what's on a web page, use **`ext_screenshot`** — it captures the browser tab through the extension. Do **not** use `computer_screenshot` / desktop capture for web content: that's for native desktop apps, it needs OS screen-recording permission, and it grabs the whole screen instead of the page. If you only need the page's content (not a picture), prefer `ext_read_page` (text/markdown) over a screenshot.

## Safety

- Never attempt to bypass CAPTCHAs
- Warn before automating sites that may prohibit automated access
- Never automate financial transactions without explicit per-action approval
- Screenshots may contain sensitive information — warn when appropriate
