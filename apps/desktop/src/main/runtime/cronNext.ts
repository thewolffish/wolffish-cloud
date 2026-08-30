/**
 * Next fire time of a 5-field cron expression, in THIS machine's local time.
 *
 * Automations are scheduled by node-cron against the desktop's own clock and
 * zone, so "when does this run next" is a question only this machine can
 * answer — which is why the phone is served the resolved moment rather than
 * the expression. A phone in another zone computing it locally would print a
 * time the desktop will not honour.
 *
 * A bounded day-scan with full field support: `*`, plain numbers, lists,
 * ranges and slash-steps, across all five fields. Standard cron rule — when
 * BOTH day fields are restricted, a day matches when either one does.
 */

/** One field expanded to its matching values, or null if it doesn't parse. */
function parseField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) return null
    const step = m[2] ? Number(m[2]) : 1
    if (step < 1) return null
    let lo: number
    let hi: number
    if (m[1] === '*') {
      lo = min
      hi = max
    } else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(m[1])
      hi = m[2] ? max : lo
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null
}

/** The next moment `expr` fires after `nowMs`, or null if it never will. */
export function nextCronMs(expr: string, nowMs: number): number | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minutes = parseField(parts[0], 0, 59)
  const hours = parseField(parts[1], 0, 23)
  const doms = parseField(parts[2], 1, 31)
  const months = parseField(parts[3], 1, 12)
  const dowsRaw = parseField(parts[4], 0, 7)
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null
  const dows = new Set(dowsRaw.map((d) => d % 7))
  const domAny = parts[2] === '*'
  const dowAny = parts[4] === '*'
  const base = new Date(nowMs)
  // Four years covers every expression the schedule forms can produce (Feb 29
  // being the far edge); beyond that the answer is honestly "never".
  for (let dayOffset = 0; dayOffset <= 4 * 366; dayOffset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset)
    if (!months.includes(day.getMonth() + 1)) continue
    const domOk = doms.includes(day.getDate())
    const dowOk = dows.has(day.getDay())
    const dayOk = domAny && dowAny ? true : domAny ? dowOk : dowAny ? domOk : domOk || dowOk
    if (!dayOk) continue
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime()
        if (t > nowMs) return t
      }
    }
  }
  return null
}
