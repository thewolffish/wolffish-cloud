/**
 * `wfc pair` — the phone.
 *
 * Pairing is the one flow where the terminal has to draw a picture, and the
 * picture has a hard size. Measured against the payload the channel
 * actually emits:
 *
 *   phone pairing URL   ~162 chars  →  49×49 modules at ECC L  →  27 rows × 55 cols
 *
 * A default SSH window is 80×24. Twenty-four rows cannot hold twenty-seven,
 * and a QR that scrolls is a QR that will not scan — the finder pattern in the
 * top-left goes off screen and no decoder recovers from that. So the rule here
 * is: measure first, draw only if it fits, and when it does not, say exactly
 * what is missing and route to the fallback that has no picture at all — the
 * phone has one built in (`offerCode`).
 *
 * Colour is not decoration either. Drawn as plain glyphs the dark modules take
 * the terminal's foreground colour, which on a dark theme is LIGHT — the code
 * comes out inverted and most scanners refuse it. Every module is therefore
 * painted explicitly, black on white, and only falls back to bare glyphs when
 * colour is off, with a warning attached.
 */
import {
  c,
  colorOn,
  g,
  err,
  heading,
  icon,
  interactive,
  out,
  question,
  terminalSize,
  unicodeOk,
  wrapText
} from '../lib/ui.mjs'

/** Modules of white space around the code. Two is the least any scanner takes. */
const QUIET = 2

/**
 * A QR as text, two module rows per printed line.
 *
 * `▀` with an explicit foreground and background gives independent control of
 * the upper and lower half of each cell, so the whole code is half as tall as
 * its module count without losing a row. Black and white are written out as
 * ANSI colours rather than left to the theme, because "dark module" has to
 * mean dark on the screen and not merely "the default text colour".
 */
function renderQr(matrix, { color = true } = {}) {
  const size = matrix.length
  const lines = []
  const BLACK_FG = '\x1b[38;5;16m'
  const WHITE_FG = '\x1b[38;5;231m'
  const BLACK_BG = '\x1b[48;5;16m'
  const WHITE_BG = '\x1b[48;5;231m'
  const RESET = '\x1b[0m'

  for (let y = -QUIET; y < size + QUIET; y += 2) {
    let line = ''
    if (color) {
      for (let x = -QUIET; x < size + QUIET; x++) {
        const top = matrix[y]?.[x] ? 1 : 0
        const bottom = matrix[y + 1]?.[x] ? 1 : 0
        line += (top ? BLACK_FG : WHITE_FG) + (bottom ? BLACK_BG : WHITE_BG) + '▀'
      }
      line += RESET
    } else {
      for (let x = -QUIET; x < size + QUIET; x++) {
        const top = matrix[y]?.[x] ? 1 : 0
        const bottom = matrix[y + 1]?.[x] ? 1 : 0
        if (top && bottom) line += '█'
        else if (top) line += '▀'
        else if (bottom) line += '▄'
        else line += ' '
      }
    }
    lines.push('  ' + line)
  }
  return lines.join('\n')
}

/**
 * The smallest matrix that can carry this text.
 *
 * Error correction level L rather than M: measured on a real pairing payload
 * that is 49 modules instead of 53, which is two printed rows and four columns
 * saved. A QR on a screen is not being read off a crumpled receipt — the extra
 * redundancy buys nothing here and costs the fit.
 *
 * Two routes, in order. In dev the CLI sits inside the repo, where `qrcode`
 * resolves from the project's node_modules. A packaged install is different:
 * the CLI ships as loose source NEXT TO app.asar while the dependency lives
 * inside it, and ESM resolution only walks real directories — so the local
 * import fails there every time, on every platform. The daemon runs from
 * inside the archive and can always reach it, so it answers `cli:qrMatrix`
 * and this side only draws. A daemon from before that channel existed says
 * "unknown channel", which lands in the same catch — and every caller has a
 * text fallback, never a dead end.
 */
async function toMatrix(client, text) {
  try {
    const { default: QRCode } = await import('qrcode')
    const qr = QRCode.create(text, { errorCorrectionLevel: 'L' })
    const size = qr.modules.size
    const data = qr.modules.data
    const matrix = []
    for (let y = 0; y < size; y++) {
      const row = []
      for (let x = 0; x < size; x++) row.push(Boolean(data[y * size + x]))
      matrix.push(row)
    }
    return matrix
  } catch {
    // fall through to the daemon
  }
  try {
    const result = await client.invoke('cli:qrMatrix', text)
    if (result?.ok && Array.isArray(result.rows) && result.rows.length > 0) {
      return result.rows.map((row) => Array.from(row, (cell) => cell === '1'))
    }
  } catch {
    // older daemon, or none — the caller's text fallback takes it from here
  }
  return null
}

/** What drawing this matrix would cost, in printed rows and columns. */
function footprint(matrix) {
  const size = matrix.length + QUIET * 2
  return { rows: Math.ceil(size / 2), columns: size + 2 }
}

/**
 * Draw the code, or explain precisely why not.
 *
 * Returns 'drawn' | 'too-big' | 'no-renderer'. Callers use that to decide
 * whether to offer the other route, rather than printing a fallback hint
 * underneath a code that came out fine.
 */
async function printQr(client, text, { reserveRows = 6 } = {}) {
  // A console that cannot print the half-block glyph turns every module into
  // "?" — a square of punctuation that looks like a QR from a distance and is
  // not one. Legacy Windows consoles are the case; refusing is the only honest
  // answer, and every caller has a route that needs no picture.
  if (!unicodeOk()) {
    out(c.yellow('  this console cannot draw a QR — use the code instead'))
    return 'too-big'
  }
  const matrix = await toMatrix(client, text)
  if (!matrix) {
    out(c.yellow('  no QR renderer available — here is the raw payload instead'))
    out(`  ${text}`)
    return 'no-renderer'
  }

  const { rows, columns } = footprint(matrix)
  const term = terminalSize()
  // `reserveRows` is the caption, the prompt and the shell line that follow.
  // Without it the code technically fits and then scrolls off the top the
  // instant anything else prints, which looks identical to not fitting.
  const haveRows = term.rows - reserveRows
  if (columns > term.columns || rows > haveRows) {
    out()
    out(`  ${icon.warn()} ${c.yellow('this code does not fit the window')}`)
    out(
      wrapText(
        c.gray(
          `it needs ${columns} columns × ${rows} rows and this terminal gives ${term.columns} × ${haveRows} usable. A code that scrolls cannot be scanned — its corner marker goes off screen.`
        ),
        4
      )
    )
    return 'too-big'
  }

  out()
  out(renderQr(matrix, { color: colorOn() }))
  if (!colorOn()) {
    out()
    out(
      wrapText(
        c.gray(
          'drawn without colour — if your terminal has a dark background the code is inverted and may not scan. Drop --no-color, or use the code route below.'
        ),
        2
      )
    )
  }
  return 'drawn'
}

/**
 * One SIGINT listener, and it always comes off again.
 *
 * `process.once('SIGINT', …)` looks equivalent and is not: these flows also run
 * inside `wfc settings`, in a process that lives for the whole session, so
 * a listener left behind by a cancelled attempt is still armed when the next
 * one starts. Two attempts, one Ctrl-C, both resolve — and the second one
 * resolves a promise nobody is waiting on any more.
 */
function onCancel(handler) {
  process.on('SIGINT', handler)
  return () => process.removeListener('SIGINT', handler)
}

export async function pair(client, args) {
  const [target, ...rest] = args
  if (!target) {
    heading('Pairing')
    out('  wfc pair phone [--code]        pair the mobile app')
    out()
    out(
      wrapText(
        c.gray(
          'On a machine with no screen, or any terminal shorter than about 32 rows, use --code: it draws no QR.'
        ),
        2
      )
    )
    out()
    // Unlinking lives on the settings card and was reachable only by
    // browsing to it — this is the page someone reads when they want the
    // opposite of what it does.
    out(c.gray('  to UNPAIR:'))
    out(c.gray('    wfc settings mobile     ' + g.chevron + '  Unpair'))
    out()
    return 2
  }
  if (target === 'phone') return pairPhone(client, rest)
  err(c.red(`unknown pairing target: ${target}`))
  err(c.gray('  phone'))
  return 2
}

// ── Phone ───────────────────────────────────────────────────────────────────

/**
 * Pairing is an offer the org mints and a phone claims. Nothing here
 * replaces anything: a second phone pairs alongside the first, and an
 * unclaimed offer simply expires at the org.
 */
async function pairPhone(client, rest) {
  let preferCode = rest.includes('--code')
  heading('Pair your phone')

  const before = await client.invoke('mobile:status').catch(() => null)
  if (before?.paired) {
    const names = (before.phones ?? []).map((p) => p.name || 'a phone').join(', ')
    out(
      wrapText(
        c.gray(`  already paired: ${names || 'a phone'}. Another phone can pair alongside.`),
        0
      )
    )
  }

  for (;;) {
    const status = preferCode
      ? await client.invoke('mobile:offerCode')
      : await client.invoke('mobile:offerQr')

    const offer = status?.offer
    if (!offer) {
      err(`${icon.fail()} ${c.red('the daemon did not produce a pairing offer')}`)
      return 1
    }

    let drew = 'drawn'
    if (offer.code) {
      out()
      out(`  ${c.bold(c.cyan(offer.code))}`)
      out()
      out(wrapText(c.gray('Enter this code in the Wolffish app on your phone.'), 2))
    } else if (offer.payload) {
      drew = await printQr(client, offer.payload)
      if (drew === 'drawn') {
        out()
        out(wrapText(c.gray('Scan this with the Wolffish app on your phone.'), 2))
      }
    }

    if (drew !== 'drawn' && !preferCode) {
      // The typed code needs no screen at all, so a window too small for the
      // square is not a dead end — switch and go round again.
      out()
      out(c.gray('  switching to the typed code, which needs no picture'))
      preferCode = true
      continue
    }

    if (offer.expiresAt) {
      const seconds = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000))
      out(c.gray(`  expires in ${seconds}s`))
    }

    const result = await waitForPairing(client, offer.expiresAt)
    if (result === 'paired') {
      out(`${icon.ok()} ${c.green('phone paired')}`)
      return 0
    }
    if (result === 'cancelled') {
      out()
      out(c.gray('  cancelled — nothing was changed'))
      return 1
    }
    // Expired. Offering a fresh one beats making the user retype the command,
    // and it is the difference between "it timed out" and "it is broken".
    out()
    out(c.yellow('  that code expired'))
    if (!interactive()) return 1
    const again = (await question(`  make a new one? ${c.dim('[Y/n]')} `)).trim().toLowerCase()
    if (again === 'n' || again === 'no') return 1
  }
}

/** Resolves 'paired' | 'cancelled' | 'expired'. Always tidies its listeners. */
function waitForPairing(client, expiresAt) {
  out()
  out(c.gray('  waiting… (Ctrl-C to stop)'))
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      off()
      offCancel()
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const off = client.onEvent((channel, payload) => {
      if (channel !== 'mobile:statusChange') return
      // The org tells this desktop the moment a phone claims the offer: the
      // offer leaves the status and the phone appears in the list. An offer
      // still open with a phone already paired from before is not success.
      if (payload?.paired && !payload?.offer) finish('paired')
    })
    const offCancel = onCancel(() => finish('cancelled'))
    const remaining = expiresAt ? expiresAt - Date.now() : 0
    const timer = remaining > 0 ? setTimeout(() => finish('expired'), remaining + 500) : null
  })
}
