import { EmojiPicker } from '@components/common/emoji-picker/EmojiPicker'
import { Badge } from '@components/core/Badge'
import { Button } from '@components/core/Button'
import { CodeEditor } from '@components/core/CodeEditor'
import { CopyButton } from '@components/core/CopyButton'
import { Modal } from '@components/core/Modal'
import { Select } from '@components/core/Select'
import { useToast } from '@components/core/toast/useToast'
import { escapePromptBody } from '@lib/heartbeat-escape'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import type {
  AutomationCopyProgress,
  HeartbeatJobView,
  HeartbeatRunsSnapshot,
  Project
} from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { useTheme } from '@providers/theme/useTheme'
import {
  Add01Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  Attachment01Icon,
  Delete02Icon,
  Edit02Icon,
  FloppyDiskIcon,
  Folder01Icon,
  GridViewIcon,
  HelpCircleIcon,
  InformationCircleIcon,
  PlayIcon,
  Refresh01Icon,
  SourceCodeIcon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

const HEARTBEAT_PATH = 'brain/brainstem/heartbeat.md'

const FROM_NOW_RANGES: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000]
]

function formatFromNow(targetMs: number, nowMs: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const diff = targetMs - nowMs
  for (const [unit, ms] of FROM_NOW_RANGES) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
  }
  return rtf.format(Math.round(diff / 1000), 'second')
}

function formatAbsolute(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(ms)
}

const DAY_MAP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
}

function parseSchedule(
  heading: string
): { type: string; cron: string | null; atMs?: number } | null {
  if (/^Startup$/i.test(heading)) return { type: 'startup', cron: null }

  // Once (YYYY-MM-DD HH:MM) — a one-time job that fires at an absolute local
  // wall-clock moment, then self-deletes. Mirrors the brainstem's ONCE_RE and
  // its round-trip validity guard so the page shows exactly the one-time
  // jobs the scheduler would actually register (an out-of-range date like
  // month 13 or 25:99 is rejected here too).
  const once = /^Once\s*\((\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\)$/i.exec(heading)
  if (once) {
    const y = Number(once[1])
    const mo = Number(once[2])
    const d = Number(once[3])
    const hh = Number(once[4])
    const mi = Number(once[5])
    const dt = new Date(y, mo - 1, d, hh, mi, 0, 0)
    if (
      dt.getFullYear() !== y ||
      dt.getMonth() !== mo - 1 ||
      dt.getDate() !== d ||
      dt.getHours() !== hh ||
      dt.getMinutes() !== mi
    ) {
      return null
    }
    return { type: 'once', cron: null, atMs: dt.getTime() }
  }

  const every = /^Every\s*\((\d+)(m|h)\)$/i.exec(heading)
  if (every) {
    const n = Number(every[1])
    return {
      type: 'every',
      cron: every[2].toLowerCase() === 'm' ? `*/${n} * * * *` : `0 */${n} * * *`
    }
  }

  const hourly = /^Hourly\s*\(:?(\d{1,2})\)$/i.exec(heading)
  if (hourly) return { type: 'hourly', cron: `${Number(hourly[1])} * * * *` }

  const daily = /^(?:Nightly|Daily)\s*\((\d{1,2}):(\d{2})\)$/i.exec(heading)
  if (daily) return { type: 'daily', cron: `${Number(daily[2])} ${Number(daily[1])} * * *` }

  const weekday = /^Weekday\s*\((\d{1,2}):(\d{2})\)$/i.exec(heading)
  if (weekday)
    return { type: 'weekday', cron: `${Number(weekday[2])} ${Number(weekday[1])} * * 1-5` }

  const weekly =
    /^Weekly\s*\((Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2}):(\d{2})\)/i.exec(
      heading
    )
  if (weekly)
    return {
      type: 'weekly',
      cron: `${Number(weekly[3])} ${Number(weekly[2])} * * ${DAY_MAP[weekly[1].toLowerCase()] ?? 0}`
    }

  const monthly = /^Monthly\s*\((\d{1,2})\s+(\d{1,2}):(\d{2})\)$/i.exec(heading)
  if (monthly)
    return {
      type: 'monthly',
      cron: `${Number(monthly[3])} ${Number(monthly[2])} ${Number(monthly[1])} * *`
    }

  const cronMatch = /^Cron\s*\((.+)\)$/i.exec(heading)
  if (cronMatch) return { type: 'cron', cron: cronMatch[1].trim() }

  return null
}

/**
 * One 5-field cron field expanded to its matching values — supports `*`,
 * plain numbers, lists, ranges, and slash-step forms.
 */
function parseCronField(field: string, min: number, max: number): number[] | null {
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

/**
 * Next occurrence of a 5-field cron expression in local time. A bounded
 * day-scan with full field support — unlike the old shortcut version this
 * also resolves weekly (day-of-week), monthly (day-of-month) and
 * month-stepped ("every 3 months") crons, which previously showed no next
 * run at all. Standard cron rule: when BOTH day fields are restricted, a
 * day matches when either one does.
 */
function nextCronMs(expr: string, nowMs: number): number | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minutes = parseCronField(parts[0], 0, 59)
  const hours = parseCronField(parts[1], 0, 23)
  const doms = parseCronField(parts[2], 1, 31)
  const months = parseCronField(parts[3], 1, 12)
  const dowsRaw = parseCronField(parts[4], 0, 7)
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null
  const dows = new Set(dowsRaw.map((d) => d % 7))
  const domAny = parts[2] === '*'
  const dowAny = parts[4] === '*'
  const base = new Date(nowMs)
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

const EN_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * The chip anchor: now, rounded up to the next 5-minute mark — a chip's
 * schedule means "…starting about now", so its first run lands within
 * minutes and the preview line immediately confirms the pick.
 */
function chipAnchor(): Date {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 5 - (d.getMinutes() % 5))
  return d
}

type ChipKind = 'hourly' | 'daily' | 'weekly' | 'monthly'

const CHIP_KINDS: readonly ChipKind[] = ['hourly', 'daily', 'weekly', 'monthly']

function chipSchedule(kind: ChipKind): string {
  const d = chipAnchor()
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  switch (kind) {
    case 'hourly':
      return `Hourly (${d.getMinutes()})`
    case 'daily':
      return `Daily (${time})`
    case 'weekly':
      return `Weekly (${EN_WEEKDAYS[d.getDay()]} ${time})`
    case 'monthly':
      // Cron skips a day number the month doesn't have — clamp to 28 so
      // the job fires every month without exception.
      return `Monthly (${Math.min(d.getDate(), 28)} ${time})`
  }
}

/**
 * LEGACY per-automation "last edited" stamps in localStorage — superseded by
 * the main-process store (brainstem's heartbeat-meta.json), which stamps
 * edits from EVERY writer (this page, markdown edits, the agent's
 * automation_* tools, external editors), not just this page's card editor.
 * Read once on load, donated to main via heartbeat.adoptMeta (per-job stamps
 * beat the store's coarse file-mtime seed), then cleared for good.
 */
const LEGACY_META_STORE_KEY = 'wolffish.heartbeat.meta'
const LEGACY_EDITED_STORE_KEY = 'wolffish.heartbeat.editedAt'
const DEFAULT_AUTOMATION_ICON = '🫀'

function readLegacyEditStamps(): Record<string, number> {
  const out: Record<string, number> = {}
  // Newest store generation first — its value wins when a label is in both.
  for (const key of [LEGACY_META_STORE_KEY, LEGACY_EDITED_STORE_KEY]) {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      for (const [label, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'number') {
          out[label] ??= value
        } else if (value && typeof value === 'object') {
          const ms = (value as { editedAt?: unknown }).editedAt
          if (typeof ms === 'number') out[label] ??= ms
        }
      }
    } catch {
      // Corrupt store — nothing to donate from this key.
    }
  }
  return out
}

function clearLegacyEditStamps(): void {
  try {
    window.localStorage.removeItem(LEGACY_META_STORE_KEY)
    window.localStorage.removeItem(LEGACY_EDITED_STORE_KEY)
  } catch {
    // best-effort
  }
}

/** Guide rows: syntax literals stay English (the file format), text localizes. */
const GUIDE_ROWS = [
  { code: 'Startup', key: 'startup' },
  { code: 'Every (30m)', key: 'every' },
  { code: 'Hourly (15)', key: 'hourly' },
  { code: 'Daily (08:00)', key: 'daily' },
  { code: 'Nightly (23:00)', key: 'nightly' },
  { code: 'Weekday (09:00)', key: 'weekday' },
  { code: 'Weekly (Monday 09:30)', key: 'weekly' },
  { code: 'Monthly (1 09:00)', key: 'monthly' },
  { code: 'Once (2026-08-01 15:00)', key: 'once' },
  { code: 'Cron (0 9 * * 1,3,5)', key: 'cron' }
] as const

const fieldClass = cn(
  'bg-bg border-border text-fg placeholder:text-muted/60 block w-full rounded-lg border px-3 py-2 text-sm leading-5',
  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg focus-visible:outline-none'
)

const iconButtonClass = cn(
  'text-muted flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg',
  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
)

// The copy-progress card and the attached-files list share one shell and hold
// rows of one fixed height, so the block claims its space the moment a copy
// starts and keeps it when progress gives way to the finished file row —
// the project dialog's contract, because it is the same block.
const fileCardClass = 'border-border bg-bg rounded-lg border p-1.5'
/** h-8 — the remove button's h-6 plus the row's former py-1, top and bottom. */
const fileRowHeight = 'h-8'
const fileRowClass = cn(fileRowHeight, 'flex items-center gap-2 rounded-md px-1.5')

/** Last path segment, for either separator — these are absolute OS paths. */
function fileBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? filePath
}

/**
 * Middle truncation that keeps the extension visible: the base name gets the
 * CSS ellipsis while ".pdf" stays pinned — "quarterly-report-fin….pdf".
 */
function splitFileName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

type SidebarJob = {
  label: string
  type: string
  active: boolean
  nextRunMs: number | null
  body: string
  cron: string | null
  lineIndex: number
  endLineIndex: number
  /** The job's `mode: …` marker value; null ⇒ follows the global mode. */
  mode: 'single' | 'workflow' | null
  /** Absolute file line of the marker, for in-place rewrites; null if absent. */
  modeLineIndex: number | null
  /** The job's `project: <id>` marker — its runs bind to that project. */
  project: string | null
  /** The job's `icon: <emoji>` marker; null ⇒ the page default. */
  icon: string | null
  /** Attached files (`file: …` markers) — copies inside the workspace. */
  files: string[]
  /** Working directories (`dir: …` markers) — references to real folders. */
  dirs: string[]
}

/**
 * Per-job setting markers — the LEADING non-empty body lines, `mode: …` /
 * `project: …` / `icon: …` / the repeatable `file: …` and `dir: …`, in any
 * order (blank lines allowed between them). Mirrors the engine's splitMarkers
 * (brainstem.ts), the automations plugin and the phone's port: parsed here so
 * DISABLED jobs (which never reach heartbeat:getJobs) show theirs too, and
 * stripped from the preview so a marker never reads as instruction text.
 */
const MODE_MARKER_RE = /^mode:\s*(single|workflow)\s*$/i
const PROJECT_MARKER_RE = /^project:\s*(\S+)\s*$/i
const ICON_MARKER_RE = /^icon:\s*(\S+)\s*$/i
// Paths, so these take the whole line (spaces and all) rather than one token.
const FILE_MARKER_RE = /^file:\s*(.+?)\s*$/i
const DIR_MARKER_RE = /^dir:\s*(.+?)\s*$/i

/**
 * Drop leading setting-marker lines (and the blanks between them) from a
 * prompt. The dialog owns the markers — a prompt that still carries them
 * (pasted text, or a body that reached the editor through an out-of-date
 * engine) would get fresh markers composed ON TOP at save time, duplicating
 * the marker block on every save. The engine strips leading markers when it
 * runs the job anyway, so they can never be legitimate instruction text.
 */
function stripLeadingSettings(text: string): string {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (
      line === '' ||
      MODE_MARKER_RE.test(line) ||
      PROJECT_MARKER_RE.test(line) ||
      ICON_MARKER_RE.test(line) ||
      FILE_MARKER_RE.test(line) ||
      DIR_MARKER_RE.test(line)
    ) {
      i++
      continue
    }
    break
  }
  return lines.slice(i).join('\n').trim()
}

function parseSidebarJobs(
  content: string,
  activeJobs: HeartbeatJobView[],
  nowMs: number
): SidebarJob[] {
  const lines = content.split('\n')
  const result: SidebarJob[] = []
  const activeByLabel = new Map(activeJobs.map((j) => [j.label, j]))
  let insideRawComment = false

  for (let i = 0; i < lines.length; i++) {
    if (
      !insideRawComment &&
      /<!--/.test(lines[i]) &&
      !/-->/.test(lines[i]) &&
      !/^<!--\s*##\s+/.test(lines[i])
    ) {
      insideRawComment = true
      continue
    }
    if (insideRawComment) {
      if (/-->/.test(lines[i])) insideRawComment = false
      continue
    }

    const activeLine = lines[i].match(/^##\s+(.+?)\s*$/)
    const inactiveSingle = lines[i].match(/^<!--\s*##\s+(.+?)\s*-->$/)
    const inactiveBlock = !inactiveSingle && lines[i].match(/^<!--\s*##\s+(.+?)\s*$/)
    if (!activeLine && !inactiveSingle && !inactiveBlock) continue

    const label = (activeLine ?? inactiveSingle ?? inactiveBlock)![1]
    const schedule = parseSchedule(label)
    if (!schedule) continue

    const isBlock = !!inactiveBlock
    const bodyLines: string[] = []
    let endIdx = i
    let mode: 'single' | 'workflow' | null = null
    let modeLineIndex: number | null = null
    let project: string | null = null
    let icon: string | null = null
    const files: string[] = []
    const dirs: string[] = []
    let sawContent = false

    for (let j = i + 1; j < lines.length; j++) {
      if (isBlock && /^\s*-->\s*$/.test(lines[j])) {
        endIdx = j
        break
      }
      // A job's body ends at the next heading, the next toggle opener, OR the
      // start of any raw comment block (e.g. the commented-out examples). Without
      // the raw-comment guard the body would swallow the `<!--` opener below it,
      // so deleting/toggling the job would strip that comment and un-comment the
      // examples it wraps.
      if (/^##\s+/.test(lines[j]) || /^\s*<!--/.test(lines[j])) break
      // Dashed separators are not content (the engine drops them wholesale) —
      // they must not stop the marker scan or a marker after one would be
      // missed and the toggle would insert a duplicate.
      if (/^---+\s*$/.test(lines[j])) {
        if (!isBlock) endIdx = j
        continue
      }
      // Setting markers are the leading non-empty body lines — capture and
      // skip them so they never show in the preview. Blank lines between
      // markers are allowed (same rule as the engine's splitMarkers).
      if (!sawContent && lines[j].trim() !== '') {
        const line = lines[j].trim()
        const m = line.match(MODE_MARKER_RE)
        if (m) {
          mode = m[1].toLowerCase() as 'single' | 'workflow'
          modeLineIndex = j
          if (!isBlock) endIdx = j
          continue
        }
        const p = line.match(PROJECT_MARKER_RE)
        if (p) {
          project = p[1]
          if (!isBlock) endIdx = j
          continue
        }
        const ic = line.match(ICON_MARKER_RE)
        if (ic) {
          icon = ic[1]
          if (!isBlock) endIdx = j
          continue
        }
        const f = line.match(FILE_MARKER_RE)
        if (f) {
          files.push(f[1])
          if (!isBlock) endIdx = j
          continue
        }
        const d = line.match(DIR_MARKER_RE)
        if (d) {
          dirs.push(d[1])
          if (!isBlock) endIdx = j
          continue
        }
        sawContent = true
      }
      bodyLines.push(lines[j])
      if (!isBlock && lines[j].trim() !== '') endIdx = j
    }

    const body = bodyLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const activeJob = activeByLabel.get(label)
    const cron = activeJob?.cron ?? schedule.cron

    result.push({
      label,
      type: schedule.type,
      active: !!activeLine,
      nextRunMs: activeJob?.nextRunMs ?? schedule.atMs ?? (cron ? nextCronMs(cron, nowMs) : null),
      // Body and mode come from THIS parse of the current file — never from
      // the engine snapshot. An engine running older marker rules once fed a
      // body with `project:`/`icon:` lines still embedded through this join;
      // the editor then re-composed fresh markers on top of that body, and
      // every save duplicated the marker block. The engine keeps supplying
      // only what it uniquely owns (cron + next run).
      body,
      cron,
      lineIndex: i,
      endLineIndex: endIdx,
      mode,
      modeLineIndex,
      project,
      icon,
      files,
      dirs
    })
  }

  return result
}

export function Heartbeat(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const { isDark } = useTheme()
  const isRtl = RTL_LOCALES.has(locale)
  const BackIcon = isRtl ? ArrowRight02Icon : ArrowLeft02Icon
  const { goTo, status } = useFlow()
  // Jobs without a marker follow the global mode — show that as the effective
  // selection; clicking a tab stamps an explicit marker.
  const globalMode = status?.config?.llm.mode === 'workflow' ? 'workflow' : 'single'
  const toast = useToast()

  const [view, setView] = useState<'cards' | 'markdown'>('cards')
  const [jobs, setJobs] = useState<HeartbeatJobView[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [deleteTarget, setDeleteTarget] = useState<SidebarJob | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [content, setContent] = useState<string>('')
  const [originalContent, setOriginalContent] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  // Per-job "Edited …" stamps (label → epoch ms) mirrored from the MAIN
  // store, which stamps every heartbeat write regardless of writer. The page
  // only adds an optimistic local stamp on its own saves so the label moves
  // instantly; heartbeat:changed then confirms with the store's truth.
  const [editStamps, setEditStamps] = useState<Record<string, number>>({})

  // Card editor dialog state. editorJob is only a create/edit discriminator
  // for the title — the live binding is boundRef, which follows the block
  // through label changes across autosaves.
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorJob, setEditorJob] = useState<SidebarJob | null>(null)
  const [draftSchedule, setDraftSchedule] = useState('')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [draftIcon, setDraftIcon] = useState('')
  const [draftProjectId, setDraftProjectId] = useState('')
  // The automation's own attachments: files copied into the workspace, and
  // references to folders it works in. Both persist as marker lines, so they
  // ride the very same autosave the rest of the draft does.
  const [draftFiles, setDraftFiles] = useState<string[]>([])
  const [draftDirs, setDraftDirs] = useState<string[]>([])
  // A pickFiles() call is in flight — the whole time, including while the
  // native picker is open. Adding and removing lock together: both write the
  // same list, and a second picker over the first is just a race.
  const [addingFiles, setAddingFiles] = useState(false)
  const [addingDirs, setAddingDirs] = useState(false)
  // Copy ticks from main. Non-null only once bytes are actually moving, so the
  // bar appears when the picker closes rather than behind it.
  const [copy, setCopy] = useState<AutomationCopyProgress | null>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  // The prompt is edited in a full-screen sheet rather than inline: the dialog
  // shows four lines of it and clicking opens the editor. Autosave is unchanged
  // — the sheet writes into the same draft state, so an edit made in it is
  // committed by the same debounce and reflected in the preview on close.
  const [promptExpanded, setPromptExpanded] = useState(false)
  // The persisted block's identity. The ref is what the async save chain
  // reads; the state mirror is the same label for render-time checks (the
  // duplicate guard), where reading a ref is off-limits.
  const boundRef = useRef<{ label: string; active: boolean } | null>(null)
  const [boundLabel, setBoundLabel] = useState<string | null>(null)
  // Last values dispatched to disk — the auto-save baseline (same contract as
  // the procedures editor: stops idle re-saves and close-time double writes).
  const savedDraftRef = useRef<{
    schedule: string
    prompt: string
    icon: string
    projectId: string
    /** The file/dir lists, joined — cheap value identity for the dirty check. */
    files: string
    dirs: string
  }>({
    schedule: '',
    prompt: '',
    icon: '',
    projectId: '',
    files: '',
    dirs: ''
  })
  // Serializes card saves so a close-time flush can't splice against a file
  // snapshot an in-flight autosave is about to replace.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const contentRef = useRef('')

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Live run-pool state. A job that's running or waiting in the queue gets
  // its play button disabled (with a note) — clicking again would only
  // coalesce into the pending run anyway.
  const [runs, setRuns] = useState<HeartbeatRunsSnapshot>({ running: [], queued: [] })
  useEffect(() => {
    let cancelled = false
    window.api.heartbeat
      .getRuns()
      .then((snap) => {
        if (!cancelled) setRuns(snap)
      })
      .catch(() => {})
    const off = window.api.heartbeat.onRunsChanged(setRuns)
    return () => {
      cancelled = true
      off()
    }
  }, [])

  // Keyed by heading label (the page's job identity). Procedure runs share
  // the pool but aren't automations — they never gate a card here.
  const busyByLabel = useMemo(() => {
    const map = new Map<string, 'running' | 'queued'>()
    for (const run of runs.running) {
      if (!run.id.startsWith('procedure:')) map.set(run.label, 'running')
    }
    for (const entry of runs.queued) {
      if (!entry.id.startsWith('procedure:') && !map.has(entry.label)) {
        map.set(entry.label, 'queued')
      }
    }
    return map
  }, [runs])

  useEffect(() => {
    contentRef.current = content
  }, [content])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.heartbeat.getJobs(),
      window.api.viewer.readFile(HEARTBEAT_PATH),
      window.api.projects.list().catch(() => [] as Project[]),
      window.api.heartbeat.getMeta().catch(() => ({}) as Record<string, number>)
    ])
      .then(([jobList, raw, projectList, stamps]) => {
        if (cancelled) return
        setJobs(jobList)
        setProjects(projectList)
        contentRef.current = raw
        setContent(raw)
        setOriginalContent(raw)
        setEditStamps(stamps)
        // One-shot migration: donate the legacy localStorage stamps to the
        // main store — per-job precise, they overwrite the coarse file-mtime
        // seed unknown jobs start with. Cleared only after main confirms.
        const legacy = readLegacyEditStamps()
        if (Object.keys(legacy).length > 0) {
          void window.api.heartbeat
            .adoptMeta(legacy)
            .then((merged) => {
              clearLegacyEditStamps()
              if (!cancelled) setEditStamps(merged)
            })
            .catch(() => {})
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const applyContent = useCallback((next: string): void => {
    contentRef.current = next
    setContent(next)
    setOriginalContent(next)
  }, [])

  // Mirrors for the change-subscription below — it mounts once and must read
  // the CURRENT values without re-subscribing on every keystroke.
  const editorOpenRef = useRef(false)
  useEffect(() => {
    editorOpenRef.current = editorOpen
  }, [editorOpen])
  const originalContentRef = useRef('')
  useEffect(() => {
    originalContentRef.current = originalContent
  }, [originalContent])

  // Live refresh: the heartbeat file changed underneath us — the agent's
  // automation_* tools, a Once-job self-delete, an external edit, or the echo
  // of our own save. Jobs + edit stamps always re-fetch; the markdown buffer
  // is replaced only when it holds no unsaved local work (a dirty markdown
  // view or an open card editor keeps local truth — the card save chain
  // already re-locates its block against current content on every write).
  useEffect(() => {
    let disposed = false
    const off = window.api.heartbeat.onChanged(() => {
      void (async () => {
        try {
          const [jobList, stamps, raw] = await Promise.all([
            window.api.heartbeat.getJobs(),
            window.api.heartbeat.getMeta(),
            window.api.viewer.readFile(HEARTBEAT_PATH)
          ])
          if (disposed) return
          setJobs(jobList)
          setEditStamps(stamps)
          const dirty = contentRef.current !== originalContentRef.current
          if (!dirty && !editorOpenRef.current) applyContent(raw)
        } catch {
          // Transient read failure — the next change event refreshes.
        }
      })()
    })
    return () => {
      disposed = true
      off()
    }
  }, [applyContent])

  const handleRun = useCallback(
    async (job: SidebarJob): Promise<void> => {
      try {
        const res = await window.api.heartbeat.runJob(job.label)
        if (res.started) {
          toast.show({ tone: 'success', message: t('heartbeat.runStarted') })
        } else if (res.ok && res.state === 'coalesced') {
          // Folded into a fire of this same job already in flight — it is NOT
          // waiting for a slot, so saying "queued" would promise a second run
          // that never comes.
          toast.show({ tone: 'info', message: t('heartbeat.runCoalesced') })
        } else if (res.ok) {
          // The three pool slots are shared with compaction, reflection and
          // procedure runs, none of which draw a card unless their switch is
          // on — so name the count, or a full pool reads as "nothing is
          // running, why is it queued?".
          toast.show({
            tone: 'info',
            message: t('heartbeat.runQueued', { count: res.running ?? 0 })
          })
        } else {
          toast.show({ tone: 'error', message: t('heartbeat.runError') })
        }
      } catch {
        toast.show({ tone: 'error', message: t('heartbeat.runError') })
      }
    },
    [t, toast]
  )

  const handleSave = useCallback(async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      await window.api.viewer.writeFile(HEARTBEAT_PATH, content)
      setOriginalContent(content)
      toast.show({ tone: 'success', message: t('workspace.saved') })
      const jobList = await window.api.heartbeat.getJobs()
      setJobs(jobList)
    } catch {
      toast.show({ tone: 'error', message: t('workspace.saveError') })
    } finally {
      setSaving(false)
    }
  }, [content, saving, t, toast])

  useEffect(() => {
    if (view !== 'markdown') return
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, handleSave])

  const handleRefresh = useCallback(async (): Promise<void> => {
    try {
      const [jobList, raw] = await Promise.all([
        window.api.heartbeat.getJobs(),
        window.api.viewer.readFile(HEARTBEAT_PATH)
      ])
      setJobs(jobList)
      applyContent(raw)
      toast.show({ tone: 'success', message: t('workspace.resynced') })
    } catch {
      toast.show({ tone: 'error', message: t('workspace.resyncError') })
    }
  }, [applyContent, t, toast])

  const handleToggle = useCallback(
    async (job: SidebarJob): Promise<void> => {
      const lines = content.split('\n')
      if (job.active) {
        if (job.endLineIndex > job.lineIndex) {
          lines[job.lineIndex] = `<!-- ${lines[job.lineIndex]}`
          lines.splice(job.endLineIndex + 1, 0, '-->')
        } else {
          lines[job.lineIndex] = `<!-- ${lines[job.lineIndex]} -->`
        }
      } else {
        lines[job.lineIndex] = lines[job.lineIndex].replace(/^<!--\s*/, '')
        if (/\s*-->$/.test(lines[job.lineIndex])) {
          lines[job.lineIndex] = lines[job.lineIndex].replace(/\s*-->$/, '')
        } else {
          for (let j = job.lineIndex + 1; j < lines.length; j++) {
            if (/^\s*-->\s*$/.test(lines[j])) {
              lines.splice(j, 1)
              break
            }
            if (/^##\s+/.test(lines[j]) || /^<!--\s*##/.test(lines[j])) break
          }
        }
      }
      const newContent = lines.join('\n')
      applyContent(newContent)
      try {
        await window.api.viewer.writeFile(HEARTBEAT_PATH, newContent)
        const jobList = await window.api.heartbeat.getJobs()
        setJobs(jobList)
      } catch {
        toast.show({ tone: 'error', message: t('workspace.saveError') })
      }
    },
    [applyContent, content, t, toast]
  )

  // Rewrite (or insert) the job's `mode:` marker line and save — same
  // viewer:writeFile + refetch pattern as the on/off toggle. Works for
  // disabled jobs too (the marker is a plain line inside the comment block).
  const handleSetMode = useCallback(
    async (job: SidebarJob, mode: 'single' | 'workflow'): Promise<void> => {
      if (job.mode === mode) return
      const lines = content.split('\n')
      const singleLineDisabled = /^<!--\s*##\s+.+?\s*-->\s*$/.test(lines[job.lineIndex])
      if (job.modeLineIndex !== null) {
        lines[job.modeLineIndex] = `mode: ${mode}`
      } else if (singleLineDisabled) {
        // A body-less disabled job is a one-line comment — splicing the marker
        // after it would put it OUTSIDE the comment, where the engine's
        // comment strip folds it into the PREVIOUS job's instruction. Convert
        // to the block-comment form with the marker inside.
        const heading = lines[job.lineIndex].replace(/^<!--\s*/, '').replace(/\s*-->\s*$/, '')
        lines.splice(job.lineIndex, 1, `<!-- ${heading}`, '', `mode: ${mode}`, '-->')
      } else {
        lines.splice(job.lineIndex + 1, 0, '', `mode: ${mode}`)
      }
      const newContent = lines.join('\n')
      applyContent(newContent)
      try {
        await window.api.viewer.writeFile(HEARTBEAT_PATH, newContent)
        const jobList = await window.api.heartbeat.getJobs()
        setJobs(jobList)
      } catch {
        toast.show({ tone: 'error', message: t('workspace.saveError') })
      }
    },
    [applyContent, content, t, toast]
  )

  const handleDelete = useCallback(
    async (job: SidebarJob): Promise<void> => {
      if (deleting) return
      setDeleting(true)
      const lines = content.split('\n')
      lines.splice(job.lineIndex, job.endLineIndex - job.lineIndex + 1)
      // Collapse the blank line the removed block leaves behind, so deletes
      // don't accumulate gaps (leading blank, or a double blank between jobs).
      if (lines[job.lineIndex] === '' && (job.lineIndex === 0 || lines[job.lineIndex - 1] === '')) {
        lines.splice(job.lineIndex, 1)
      }
      const newContent = lines.join('\n')
      try {
        await window.api.viewer.writeFile(HEARTBEAT_PATH, newContent)
        applyContent(newContent)
        const jobList = await window.api.heartbeat.getJobs()
        setJobs(jobList)
        setDeleteTarget(null)
        setEditStamps((prev) => {
          const next = { ...prev }
          delete next[job.label]
          return next
        })
        toast.show({ tone: 'success', message: t('heartbeat.deleteSuccess') })
      } catch {
        toast.show({ tone: 'error', message: t('workspace.saveError') })
      } finally {
        setDeleting(false)
      }
    },
    [applyContent, content, deleting, t, toast]
  )

  const isDirty = content !== originalContent
  const sidebarJobs = useMemo(() => parseSidebarJobs(content, jobs, now), [content, jobs, now])

  // Cards order = fire order: the job that runs next comes first. Active
  // jobs with no computable moment (Startup, exotic crons) follow, and
  // inactive jobs — which never fire — go last; file order within each
  // group (stable sort). Reorders live as runs roll over (the 30s tick).
  const orderedJobs = useMemo(() => {
    const rank = (j: SidebarJob): number =>
      j.active
        ? j.nextRunMs != null
          ? j.nextRunMs
          : Number.MAX_SAFE_INTEGER - 1
        : Number.MAX_SAFE_INTEGER
    return [...sidebarJobs].sort((a, b) => rank(a) - rank(b))
  }, [sidebarJobs])

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  // Card emoji: a project-bound automation wears its PROJECT's emoji; an
  // unbound one wears its own `icon:` marker, else the page default.
  const jobCardIcon = useCallback(
    (job: SidebarJob): string =>
      (job.project ? projectsById.get(job.project)?.icon : undefined) ||
      job.icon ||
      DEFAULT_AUTOMATION_ICON,
    [projectsById]
  )

  // ---- Card editor -------------------------------------------------------

  const draftScheduleTrimmed = draftSchedule.trim()
  const draftParsed = useMemo(() => parseSchedule(draftScheduleTrimmed), [draftScheduleTrimmed])
  // The heading is the job's identity (run status and card joins key on it) —
  // a second job with the same label would collide, so the editor blocks it.
  const isDuplicateSchedule =
    editorOpen &&
    draftScheduleTrimmed !== '' &&
    sidebarJobs.some(
      (j) =>
        j.label.toLowerCase() === draftScheduleTrimmed.toLowerCase() &&
        j.label.toLowerCase() !== (boundLabel?.toLowerCase() ?? '')
    )
  // Errors paint late, validity paints now: mid-edit keystrokes pass through
  // invalid states ("Daily (09:3" on the way to "Daily (09:30)"), and turning
  // the field red for each one reads as flicker. The red state waits out a
  // typing pause; a parseable draft clears it immediately. Display-only — the
  // autosave gate below still reads the raw validity.
  const scheduleInvalid = draftParsed === null || isDuplicateSchedule
  const [invalidHeld, setInvalidHeld] = useState(false)
  useEffect(() => {
    if (!scheduleInvalid) {
      // Re-arm the debounce for the next invalid stretch. showScheduleError
      // already derives false the instant the draft turns valid; the microtask
      // keeps the write async (off the effect's synchronous path) yet still
      // lands before any next input event can start a new stretch.
      queueMicrotask(() => setInvalidHeld(false))
      return
    }
    const handle = setTimeout(() => setInvalidHeld(true), 600)
    return () => clearTimeout(handle)
  }, [scheduleInvalid, draftScheduleTrimmed])
  const showScheduleError = scheduleInvalid && invalidHeld
  // While the error is held back, the helper line keeps previewing the last
  // parseable draft — swapping to blank and back would be its own flash.
  // Tracked as state from the event handlers that write the draft (never
  // during render): every draftSchedule write funnels through
  // applyDraftSchedule, which records the parse when it succeeds. Dialog
  // opens always pass a parseable value, so a stale carry-over can't leak
  // across dialogs.
  const [lastParsed, setLastParsed] = useState<ReturnType<typeof parseSchedule>>(null)
  const applyDraftSchedule = useCallback((value: string): void => {
    setDraftSchedule(value)
    const parsed = parseSchedule(value.trim())
    if (parsed) setLastParsed(parsed)
  }, [])
  const displayParsed = draftParsed ?? lastParsed
  const draftNextMs = displayParsed
    ? (displayParsed.atMs ?? (displayParsed.cron ? nextCronMs(displayParsed.cron, now) : null))
    : null
  const draftProject = draftProjectId ? projectsById.get(draftProjectId) : undefined

  const openCreate = useCallback((): void => {
    boundRef.current = null
    setBoundLabel(null)
    savedDraftRef.current = {
      schedule: '',
      prompt: '',
      icon: '',
      projectId: '',
      files: '',
      dirs: ''
    }
    setEditorJob(null)
    applyDraftSchedule(chipSchedule('daily'))
    setDraftPrompt('')
    setDraftIcon('')
    setDraftProjectId('')
    setDraftFiles([])
    setDraftDirs([])
    setEmojiOpen(false)
    setPromptExpanded(false)
    setCopy(null)
    setEditorOpen(true)
  }, [applyDraftSchedule])

  const openEditor = useCallback(
    (job: SidebarJob): void => {
      const icon = job.icon ?? ''
      const projectId = job.project ?? ''
      boundRef.current = { label: job.label, active: job.active }
      setBoundLabel(job.label)
      savedDraftRef.current = {
        schedule: job.label,
        prompt: job.body,
        icon,
        projectId,
        files: job.files.join('\n'),
        dirs: job.dirs.join('\n')
      }
      setEditorJob(job)
      applyDraftSchedule(job.label)
      setDraftPrompt(job.body)
      setDraftIcon(icon)
      setDraftProjectId(projectId)
      setDraftFiles(job.files)
      setDraftDirs(job.dirs)
      setEmojiOpen(false)
      setPromptExpanded(false)
      setCopy(null)
      setEditorOpen(true)
    },
    [applyDraftSchedule]
  )

  const persistDraft = useCallback(
    (
      schedule: string,
      prompt: string,
      icon: string,
      projectId: string,
      files: string[],
      dirs: string[]
    ): Promise<boolean> => {
      savedDraftRef.current = {
        schedule,
        prompt,
        icon,
        projectId,
        files: files.join('\n'),
        dirs: dirs.join('\n')
      }
      const write = saveChainRef.current.then(async () => {
        const current = contentRef.current
        // Escaped at the write seam: a pasted prompt with its own `## `
        // sections, dashed separators or comment tokens would otherwise
        // corrupt the file's block grammar (see escapePromptBody).
        const promptLines = escapePromptBody(stripLeadingSettings(prompt)).split('\n')
        const bound = boundRef.current
        // Marker lines the dialog owns. The icon is always written (every
        // automation carries an emoji — default ❤️); the project marker only
        // when bound. The mode marker is preserved from the existing block.
        // Files and directories are repeatable, one line each.
        const settingLines = (mode: 'single' | 'workflow' | null): string[] => [
          ...(mode ? [`mode: ${mode}`] : []),
          ...(projectId ? [`project: ${projectId}`] : []),
          `icon: ${icon || DEFAULT_AUTOMATION_ICON}`,
          ...files.map((f) => `file: ${f}`),
          ...dirs.map((d) => `dir: ${d}`)
        ]

        // Re-locate the bound block in the CURRENT text — indices captured at
        // dialog-open go stale after the first autosave. A block that vanished
        // (markdown edit elsewhere) falls through to insert, preserving the
        // user's work as a new job.
        const target = bound
          ? (() => {
              const blocks = parseSidebarJobs(current, [], Date.now())
              return (
                blocks.find((b) => b.label === bound.label && b.active === bound.active) ??
                blocks.find((b) => b.label === bound.label) ??
                null
              )
            })()
          : null

        let nextContent: string
        let nextActive = true
        if (target) {
          nextActive = target.active
          const markers = [...settingLines(target.mode), '']
          const block = target.active
            ? [`## ${schedule}`, '', ...markers, ...promptLines]
            : [`<!-- ## ${schedule}`, '', ...markers, ...promptLines, '-->']
          const lines = current.split('\n')
          lines.splice(target.lineIndex, target.endLineIndex - target.lineIndex + 1, ...block)
          nextContent = lines.join('\n')
        } else {
          // New jobs go before the first HTML comment (the examples block) —
          // the same shape the automations plugin's insertBlock produces.
          const block = [`## ${schedule}`, '', ...settingLines(null), '', ...promptLines].join('\n')
          const firstComment = current.search(/<!--/)
          nextContent = (
            firstComment >= 0
              ? `${current.slice(0, firstComment).replace(/\s+$/, '')}\n\n${block}\n\n${current.slice(firstComment)}`
              : `${current.replace(/\s+$/, '')}\n\n${block}\n`
          ).replace(/^\n+/, '')
        }

        applyContent(nextContent)
        // The binding must move in the same render as the content swap: the
        // duplicate check excludes the draft's own block only through
        // boundLabel, so updating it after the awaits below paints a spurious
        // "duplicate label" flash while the write is in flight.
        boundRef.current = { label: schedule, active: nextActive }
        setBoundLabel(schedule)
        try {
          await window.api.viewer.writeFile(HEARTBEAT_PATH, nextContent)
          const jobList = await window.api.heartbeat.getJobs()
          setJobs(jobList)
        } catch {
          toast.show({ tone: 'error', message: t('workspace.saveError') })
          return false
        }
        // Optimistic stamp — the store's reload diff confirms moments later
        // (via heartbeat:changed) with the file-mtime truth.
        setEditStamps((prev) => {
          const next = { ...prev }
          if (bound && bound.label !== schedule) delete next[bound.label]
          next[schedule] = Date.now()
          return next
        })
        return true
      })
      // The chain itself must stay a plain void promise (its next link only
      // waits on ordering); the boolean goes to the caller, which is how a
      // detach knows the marker actually left the file before it deletes the
      // copy that marker pointed at.
      saveChainRef.current = write.then(
        () => undefined,
        () => undefined
      )
      return write.catch(() => false)
    },
    [applyContent, t, toast]
  )

  // Auto-save ~600ms after the last keystroke, but only while the draft is
  // actually saveable: schedule recognized, no label collision, prompt
  // present. An invalid draft is never written — closing keeps the last
  // saved state, mirroring the procedures title-required contract.
  useEffect(() => {
    if (!editorOpen) return
    if (!draftParsed || isDuplicateSchedule || draftPrompt.trim() === '') return
    if (
      draftScheduleTrimmed === savedDraftRef.current.schedule &&
      draftPrompt === savedDraftRef.current.prompt &&
      draftIcon === savedDraftRef.current.icon &&
      draftProjectId === savedDraftRef.current.projectId &&
      draftFiles.join('\n') === savedDraftRef.current.files &&
      draftDirs.join('\n') === savedDraftRef.current.dirs
    ) {
      return
    }
    const handle = setTimeout(
      () =>
        void persistDraft(
          draftScheduleTrimmed,
          draftPrompt,
          draftIcon,
          draftProjectId,
          draftFiles,
          draftDirs
        ),
      600
    )
    return () => clearTimeout(handle)
  }, [
    editorOpen,
    draftScheduleTrimmed,
    draftPrompt,
    draftIcon,
    draftProjectId,
    draftFiles,
    draftDirs,
    draftParsed,
    isDuplicateSchedule,
    persistDraft
  ])

  /** The draft is in a state the file can hold — the autosave gate, reused. */
  const draftSaveable = draftParsed !== null && !isDuplicateSchedule && draftPrompt.trim() !== ''

  const closeEditor = useCallback((): void => {
    setEditorOpen(false)
    setEmojiOpen(false)
    setGuideOpen(false)
    setPromptExpanded(false)
    // Flush any edit the debounce hasn't dispatched yet.
    const saved = savedDraftRef.current
    if (
      draftSaveable &&
      (draftScheduleTrimmed !== saved.schedule ||
        draftPrompt !== saved.prompt ||
        draftIcon !== saved.icon ||
        draftProjectId !== saved.projectId ||
        draftFiles.join('\n') !== saved.files ||
        draftDirs.join('\n') !== saved.dirs)
    ) {
      void persistDraft(
        draftScheduleTrimmed,
        draftPrompt,
        draftIcon,
        draftProjectId,
        draftFiles,
        draftDirs
      )
    }
  }, [
    draftScheduleTrimmed,
    draftPrompt,
    draftIcon,
    draftProjectId,
    draftFiles,
    draftDirs,
    draftSaveable,
    persistDraft
  ])

  // Copy ticks are a broadcast — subscribed only for the duration of OUR add,
  // so a bar can never be left behind by someone else's copy.
  useEffect(() => {
    if (!addingFiles) return
    return window.api.automationFiles.onCopyProgress(setCopy)
  }, [addingFiles])

  const addDraftFiles = useCallback((): void => {
    if (addingFiles) return
    // Pick + copy happen main-side in one step (the files are copied into this
    // automation's uploads dir); the markers are ours to write, and the
    // autosave below does that as soon as the list changes.
    setAddingFiles(true)
    void window.api.automationFiles
      .pickFiles(draftFiles)
      .then((result) => {
        if (!result) return
        const added = result.added.map((f) => f.path)
        if (added.length > 0) setDraftFiles((prev) => [...prev, ...added])
      })
      .catch(() => toast.show({ tone: 'error', message: t('workspace.saveError') }))
      .finally(() => {
        setAddingFiles(false)
        setCopy(null)
      })
  }, [addingFiles, draftFiles, t, toast])

  const removeDraftFile = useCallback(
    (filePath: string): void => {
      const next = draftFiles.filter((f) => f !== filePath)
      setDraftFiles(next)
      // Delete the copy only once the marker is provably gone from the file.
      // An unsaveable draft (no schedule yet, empty prompt) writes nothing, so
      // deleting here would strand a marker pointing at nothing; the
      // scheduler's own reconcile sweep collects it later instead.
      if (!draftSaveable) return
      void persistDraft(
        draftScheduleTrimmed,
        draftPrompt,
        draftIcon,
        draftProjectId,
        next,
        draftDirs
      ).then((ok) => {
        if (ok) void window.api.automationFiles.removeFile(filePath)
      })
    },
    [
      draftFiles,
      draftDirs,
      draftSaveable,
      draftScheduleTrimmed,
      draftPrompt,
      draftIcon,
      draftProjectId,
      persistDraft
    ]
  )

  const copyPercent = copy
    ? copy.totalBytes > 0
      ? Math.min(100, Math.round((copy.copiedBytes / copy.totalBytes) * 100))
      : 100
    : 0

  // Escape closes only what is stacked on top. The dialog's own `dismissable`
  // gate stops Modal from handling it while the prompt sheet is open, so this
  // is the sheet's only way out by keyboard.
  useEffect(() => {
    if (!promptExpanded) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPromptExpanded(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [promptExpanded])

  const addDraftDirs = useCallback((): void => {
    if (addingDirs) return
    setAddingDirs(true)
    void window.api.paths
      .pickDirectories()
      .then((picked) => {
        if (!picked) return
        setDraftDirs((prev) => [...prev, ...picked.filter((p) => !prev.includes(p))])
      })
      .catch(() => toast.show({ tone: 'error', message: t('workspace.saveError') }))
      .finally(() => setAddingDirs(false))
  }, [addingDirs, t, toast])

  const jobMetaLine = useCallback(
    (job: SidebarJob): string => {
      const scheduleText = job.active
        ? job.type === 'startup'
          ? t('heartbeat.onLaunch')
          : job.nextRunMs != null
            ? `${t('heartbeat.nextRun', { time: formatFromNow(job.nextRunMs, now, locale) })} · ${formatAbsolute(job.nextRunMs, locale)}`
            : t('heartbeat.active')
        : t('heartbeat.inactive')
      const parts = [scheduleText]
      const project = job.project ? projectsById.get(job.project) : undefined
      if (project) parts.push(project.title.trim() || t('projects.untitled'))
      const edited = editStamps[job.label]
      if (edited != null) {
        parts.push(t('heartbeat.editedAt', { time: formatFromNow(edited, now, locale) }))
      }
      return parts.join(' · ')
    },
    [editStamps, locale, now, projectsById, t]
  )

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <header className="border-border flex items-center justify-between gap-2 border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => goTo('chat')}
            aria-label={t('common.back')}
            className={cn(
              'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-sm',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          >
            <BackIcon size={16} />
            <span>{t('common.back')}</span>
          </button>
          <button
            type="button"
            onClick={() => setView((v) => (v === 'cards' ? 'markdown' : 'cards'))}
            aria-label={view === 'cards' ? t('heartbeat.markdownMode') : t('heartbeat.cardsMode')}
            className={cn(
              'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-sm',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          >
            {view === 'cards' ? <SourceCodeIcon size={16} /> : <GridViewIcon size={16} />}
            <span>{view === 'cards' ? t('heartbeat.markdownMode') : t('heartbeat.cardsMode')}</span>
          </button>
        </div>
        <div className="flex items-center gap-2" />
      </header>

      {view === 'cards' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
            <header className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <h1 className="text-fg text-2xl font-semibold tracking-tight">
                    {t('heartbeat.title')}
                  </h1>
                  {!loading && (
                    <Badge variant="default" size="sm">
                      {sidebarJobs.length}
                    </Badge>
                  )}
                </div>
                <p className="text-muted text-sm leading-relaxed">{t('heartbeat.subtitle')}</p>
              </div>
              <Button size="sm" onClick={openCreate} className="shrink-0">
                <Add01Icon size={16} />
                <span>{t('heartbeat.new')}</span>
              </Button>
            </header>

            {loading ? (
              <div className="text-muted py-10 text-center text-sm">{t('common.loading')}</div>
            ) : orderedJobs.length === 0 ? (
              <div className="border-border text-muted rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
                {t('heartbeat.empty')}
              </div>
            ) : (
              <ul className="flex flex-col gap-3">
                {orderedJobs.map((job) => {
                  const busy = job.active ? busyByLabel.get(job.label) : undefined
                  return (
                    <li
                      key={job.label}
                      className={cn(
                        'bg-surface border-border flex flex-col gap-2.5 rounded-2xl border px-4 py-3',
                        !job.active && 'opacity-60'
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-1 items-center gap-2.5">
                          <span aria-hidden className="text-2xl leading-none">
                            {jobCardIcon(job)}
                          </span>
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              title={job.label}
                              className="text-fg truncate text-sm font-medium"
                            >
                              <bdi>{job.label}</bdi>
                            </span>
                            <Badge variant="primary" size="sm" className="shrink-0">
                              {t(`heartbeat.type.${job.type}`)}
                            </Badge>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {job.active && (
                            <button
                              type="button"
                              onClick={() => void handleRun(job)}
                              disabled={!!busy}
                              aria-label={t('heartbeat.run')}
                              title={
                                busy
                                  ? t(
                                      busy === 'running'
                                        ? 'heartbeat.noteRunning'
                                        : 'heartbeat.noteQueued'
                                    )
                                  : t('heartbeat.run')
                              }
                              className={cn(
                                iconButtonClass,
                                'hover:text-emerald-600 dark:hover:text-emerald-400',
                                'disabled:cursor-not-allowed disabled:opacity-40'
                              )}
                            >
                              <PlayIcon size={18} />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openEditor(job)}
                            aria-label={t('heartbeat.edit')}
                            title={t('heartbeat.edit')}
                            className={cn(iconButtonClass, 'hover:text-fg')}
                          >
                            <Edit02Icon size={16} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(job)}
                            aria-label={t('heartbeat.delete')}
                            title={t('heartbeat.delete')}
                            className={cn(iconButtonClass, 'hover:text-rose-500')}
                          >
                            <Delete02Icon size={16} />
                          </button>
                          <div
                            role="tablist"
                            className="border-border bg-bg/40 ms-1 inline-flex shrink-0 items-center rounded-lg border p-0.5"
                          >
                            <button
                              role="tab"
                              type="button"
                              aria-selected={job.active}
                              onClick={() => {
                                if (!job.active) void handleToggle(job)
                              }}
                              className={cn(
                                'rounded-md px-2 py-1 text-[10px] font-medium',
                                job.active
                                  ? 'bg-primary text-primary-fg shadow-sm'
                                  : 'text-muted hover:text-fg cursor-pointer'
                              )}
                            >
                              {t('settings.wolffish.toggle.on')}
                            </button>
                            <button
                              role="tab"
                              type="button"
                              aria-selected={!job.active}
                              onClick={() => {
                                if (job.active) void handleToggle(job)
                              }}
                              className={cn(
                                'rounded-md px-2 py-1 text-[10px] font-medium',
                                !job.active
                                  ? 'bg-primary text-primary-fg shadow-sm'
                                  : 'text-muted hover:text-fg cursor-pointer'
                              )}
                            >
                              {t('settings.wolffish.toggle.off')}
                            </button>
                          </div>
                          <div
                            role="tablist"
                            aria-label={t('heartbeat.modeAria')}
                            className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
                          >
                            {(['single', 'workflow'] as const).map((m) => {
                              const selected = (job.mode ?? globalMode) === m
                              return (
                                <button
                                  key={m}
                                  role="tab"
                                  type="button"
                                  aria-selected={selected}
                                  onClick={() => {
                                    if (!selected) void handleSetMode(job, m)
                                  }}
                                  className={cn(
                                    'rounded-md px-2 py-1 text-[10px] font-medium',
                                    selected
                                      ? 'bg-primary text-primary-fg shadow-sm'
                                      : 'text-muted hover:text-fg cursor-pointer'
                                  )}
                                >
                                  {t(
                                    m === 'workflow'
                                      ? 'chat.modePicker.workflow'
                                      : 'chat.modePicker.single'
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      </div>
                      {/* Own full-width row — under the label column it wrapped
                        onto two lines next to the action cluster. */}
                      <span className="text-muted text-xs">{jobMetaLine(job)}</span>
                      {busy && (
                        <span
                          className={cn(
                            'flex items-center gap-1.5 text-xs',
                            busy === 'running'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-amber-600 dark:text-amber-400'
                          )}
                        >
                          <InformationCircleIcon size={13} className="shrink-0" />
                          <span className="truncate">
                            {t(
                              busy === 'running' ? 'heartbeat.noteRunning' : 'heartbeat.noteQueued'
                            )}
                          </span>
                        </span>
                      )}
                      {job.body ? (
                        <pre
                          dir="auto"
                          className="bg-bg border-border text-muted max-h-40 overflow-auto rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap"
                        >
                          {job.body}
                        </pre>
                      ) : (
                        <p className="text-muted text-xs italic">{t('heartbeat.promptEmpty')}</p>
                      )}
                      {/* What this automation carries into every run. On the
                          card, not just in the editor: the paths are the part
                          of an automation you cannot infer from its prompt.
                          Read-only here — detaching lives in the editor. */}
                      {(job.files.length > 0 || job.dirs.length > 0) && (
                        <div dir="ltr" className="flex flex-wrap items-center gap-1.5">
                          {/* Transparent, not `bg-bg`: these sit ON the card,
                              so they take its surface rather than punching a
                              darker well into it. Local to this card by
                              design — code blocks elsewhere in the app keep
                              their own recessed background. */}
                          {job.files.map((file) => (
                            <span
                              key={file}
                              title={file}
                              className="border-border text-muted inline-flex h-5 max-w-full items-center gap-1 truncate rounded-md border bg-transparent px-1.5 text-[10px] leading-none"
                            >
                              <Attachment01Icon size={10} className="shrink-0" />
                              <span className="truncate">{fileBaseName(file)}</span>
                            </span>
                          ))}
                          {job.dirs.map((dir) => (
                            <code
                              key={dir}
                              title={dir}
                              className="border-border text-muted inline-flex h-5 max-w-full items-center gap-1 truncate rounded-md border bg-transparent px-1.5 font-mono text-[10px] leading-none"
                            >
                              <Folder01Icon size={10} className="shrink-0" />
                              <span className="truncate">{dir}</span>
                            </code>
                          ))}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div dir="ltr" className="flex min-h-0 flex-1">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="border-border flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-fg text-sm font-medium">heartbeat.md</span>
                {isDirty && <span className="text-muted text-xs italic">(unsaved)</span>}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  disabled={loading}
                  className={cn(
                    'text-muted hover:text-fg inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs',
                    'disabled:cursor-not-allowed disabled:opacity-40'
                  )}
                >
                  <Refresh01Icon size={14} />
                  <span>{t('workspace.resync')}</span>
                </button>
                <CopyButton text={content} variant="inline" />
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!isDirty || saving}
                  aria-label={t('workspace.save')}
                  title={t('workspace.save')}
                  className={cn(
                    'text-muted hover:text-fg hover:bg-border/40 flex h-8 w-8 items-center justify-center rounded-lg cursor-pointer',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted'
                  )}
                >
                  <FloppyDiskIcon size={16} />
                </button>
              </div>
            </div>
            {loading ? (
              <div className="text-muted flex flex-1 items-center justify-center text-sm">
                {t('common.loading')}
              </div>
            ) : (
              <CodeEditor
                value={content}
                language="markdown"
                isDark={isDark}
                readOnly={false}
                onChange={setContent}
                className="min-h-0 w-full flex-1"
                spellcheck
              />
            )}
          </section>
        </div>
      )}

      <Modal
        open={editorOpen}
        onClose={closeEditor}
        // While the guide or the expanded prompt editor is stacked on top,
        // Escape/backdrop must only close that — not both dialogs at once.
        dismissable={!guideOpen && !promptExpanded}
        title={editorJob ? t('heartbeat.editor.editTitle') : t('heartbeat.editor.createTitle')}
        className="max-w-xl"
        footer={
          <div className="flex justify-end">
            <Button size="sm" onClick={closeEditor}>
              {t('heartbeat.editor.done')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-muted text-xs font-medium">{t('heartbeat.editor.schedule')}</span>
            <button
              type="button"
              onClick={() => setGuideOpen(true)}
              aria-label={t('heartbeat.editor.guideButton')}
              title={t('heartbeat.editor.guideButton')}
              className="text-muted hover:text-fg flex h-7 w-7 cursor-pointer items-center justify-center rounded-md"
            >
              <HelpCircleIcon size={15} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {CHIP_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => applyDraftSchedule(chipSchedule(kind))}
                className={cn(
                  'border-border bg-bg text-muted cursor-pointer rounded-full border px-2.5 py-1 text-xs',
                  'hover:border-accent/50 hover:text-fg',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'
                )}
              >
                {t(`heartbeat.editor.chips.${kind}`)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              {/* A project-bound automation wears the project's emoji — the
                  button shows it and disables (the automation's own icon
                  returns when the binding is removed). */}
              <button
                type="button"
                disabled={draftProject !== undefined}
                onClick={() => setEmojiOpen((v) => !v)}
                aria-label={
                  draftProject ? t('heartbeat.editor.projectIcon') : t('heartbeat.editor.pickIcon')
                }
                title={
                  draftProject ? t('heartbeat.editor.projectIcon') : t('heartbeat.editor.pickIcon')
                }
                className={cn(
                  'bg-bg border-border flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border text-lg',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                  'disabled:cursor-default'
                )}
              >
                {draftProject ? draftProject.icon || '📁' : draftIcon || DEFAULT_AUTOMATION_ICON}
              </button>
              {emojiOpen && (
                <EmojiPicker
                  onPick={(emoji) => {
                    setDraftIcon(emoji)
                    setEmojiOpen(false)
                  }}
                  onClose={() => setEmojiOpen(false)}
                />
              )}
            </div>
            <input
              value={draftSchedule}
              onChange={(e) => applyDraftSchedule(e.target.value)}
              placeholder="Daily (09:00)"
              dir="ltr"
              aria-label={t('heartbeat.editor.schedule')}
              aria-invalid={showScheduleError}
              className={cn(
                fieldClass,
                'min-w-0 font-mono',
                showScheduleError && 'border-rose-500/70'
              )}
            />
          </div>
          {showScheduleError || displayParsed === null ? (
            draftParsed === null ? (
              <p className="text-xs text-rose-500">
                {t('heartbeat.editor.invalid')}{' '}
                <button
                  type="button"
                  onClick={() => setGuideOpen(true)}
                  className="cursor-pointer underline underline-offset-2"
                >
                  {t('heartbeat.editor.guideButton')}
                </button>
              </p>
            ) : (
              <p className="text-xs text-rose-500">{t('heartbeat.editor.duplicate')}</p>
            )
          ) : displayParsed.type === 'startup' ? (
            <p className="text-muted text-xs">{t('heartbeat.onLaunch')}</p>
          ) : displayParsed.atMs != null && displayParsed.atMs <= now ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('heartbeat.editor.pastOnce')}
            </p>
          ) : draftNextMs != null ? (
            <p className="text-muted text-xs">
              {t('heartbeat.nextRun', { time: formatFromNow(draftNextMs, now, locale) })}
              {' · '}
              {formatAbsolute(draftNextMs, locale)}
            </p>
          ) : (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('heartbeat.editor.cronUnknown')}
            </p>
          )}

          <span className="text-muted text-xs font-medium">{t('heartbeat.editor.project')}</span>
          {/* Bind/unbind a project: the run gets the project's context and its
              conversation registers under the project. */}
          <Select
            value={draftProjectId}
            onChange={(v) => {
              setDraftProjectId(v)
              setEmojiOpen(false)
            }}
            options={[
              { value: '', label: t('heartbeat.editor.projectNone') },
              ...projects.map((p) => ({
                value: p.id,
                label: p.title.trim() || t('projects.untitled'),
                icon: (
                  <span aria-hidden className="text-base leading-none">
                    {p.icon || '📁'}
                  </span>
                )
              }))
            ]}
          />

          {/* Files: copied INTO the workspace on attach, exactly like a
              project's, so the automation can never dangle on a moved
              original. The run gets the list, never the content. */}
          <div className="flex items-center justify-between">
            <span className="text-muted text-xs font-medium">
              {t('heartbeat.editor.files', { count: draftFiles.length })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={addDraftFiles}
              disabled={addingFiles}
              className="flex items-center gap-1"
            >
              <Add01Icon size={13} />
              <span>{t('heartbeat.editor.addFiles')}</span>
            </Button>
          </div>
          {/* Copying a large file into the workspace is not instant — real
              bytes, batch-wide, from the main-side copy. */}
          {copy && (
            <div className={fileCardClass}>
              <div className={cn(fileRowHeight, 'flex flex-col justify-center gap-1 px-1.5')}>
                <div className="text-muted flex items-center gap-2 text-xs">
                  <span dir="ltr" title={copy.name} className="min-w-0 flex-1 truncate">
                    {copy.name}
                  </span>
                  {copy.total > 1 && (
                    <span className="shrink-0 tabular-nums">
                      {t('projects.copyingCount', { index: copy.index, total: copy.total })}
                    </span>
                  )}
                  <span className="shrink-0 tabular-nums">{copyPercent}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={t('projects.copyingFiles')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={copyPercent}
                  className="bg-border h-1 w-full overflow-hidden rounded-full"
                >
                  <div
                    className="bg-primary h-full rounded-full transition-[width] duration-150"
                    style={{ width: `${copyPercent}%` }}
                  />
                </div>
              </div>
            </div>
          )}
          {draftFiles.length > 0 && (
            <ul className={cn(fileCardClass, 'flex max-h-36 flex-col gap-0.5 overflow-y-auto')}>
              {draftFiles.map((filePath) => {
                const { base, ext } = splitFileName(fileBaseName(filePath))
                return (
                  <li key={filePath} className={cn('group shrink-0', fileRowClass)}>
                    {/* dir=ltr pins filename order (and the pinned extension)
                        even in the RTL locale — paths are LTR text. */}
                    <span
                      title={filePath}
                      dir="ltr"
                      className="text-fg flex min-w-0 flex-1 items-baseline text-xs"
                    >
                      <span className="truncate">{base}</span>
                      {ext && <span className="shrink-0">{ext}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeDraftFile(filePath)}
                      disabled={addingFiles}
                      aria-label={t('heartbeat.editor.removeFile')}
                      title={t('heartbeat.editor.removeFile')}
                      className={cn(
                        'text-muted flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                        addingFiles
                          ? 'cursor-not-allowed opacity-40'
                          : 'cursor-pointer hover:text-rose-500'
                      )}
                    >
                      <Delete02Icon size={13} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {/* Working directories: references, never copies. They ride the run
              through the same channel as chat's folder picker, so the model
              sees a fresh listing of each one on every iteration. */}
          <div className="flex items-center justify-between">
            <span className="text-muted text-xs font-medium">
              {t('heartbeat.editor.folders', { count: draftDirs.length })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={addDraftDirs}
              disabled={addingDirs}
              className="flex items-center gap-1"
            >
              <Add01Icon size={13} />
              <span>{t('heartbeat.editor.addFolders')}</span>
            </Button>
          </div>
          {draftDirs.length > 0 && (
            <ul className={cn(fileCardClass, 'flex max-h-40 flex-col gap-1.5 overflow-y-auto')}>
              {draftDirs.map((dir) => (
                <li key={dir} dir="ltr" className="flex flex-col gap-0.5 px-1.5 py-0.5">
                  <span title={dir} className="text-fg truncate text-xs">
                    {fileBaseName(dir)}
                  </span>
                  <div className="flex items-center gap-1">
                    {/* The full path, in a code block — the same treatment the
                        composer's working-folder card gives it. */}
                    <code
                      title={dir}
                      className="border-border bg-surface text-muted block min-w-0 flex-1 truncate rounded border px-1 py-0.5 font-mono text-[10px]"
                    >
                      {dir}
                    </code>
                    <button
                      type="button"
                      onClick={() => setDraftDirs((prev) => prev.filter((d) => d !== dir))}
                      aria-label={t('heartbeat.editor.removeFolder')}
                      title={t('heartbeat.editor.removeFolder')}
                      className="text-muted flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:text-rose-500"
                    >
                      <Delete02Icon size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <span className="text-muted text-xs font-medium">{t('heartbeat.editor.prompt')}</span>
          {/* The prompt, in the card's own code block — capped but scrollable,
              so the whole thing can be read here without opening anything. The
              prompt is the longest thing in this dialog by far, and an inline
              editor tall enough to write in pushed everything else off screen
              — clicking opens the full-height editor below instead. Scrolling
              stays clean: the wheel moves this block rather than the dialog
              behind it, and dragging its scrollbar never reaches the button's
              click handler. */}
          <button
            type="button"
            onClick={() => setPromptExpanded(true)}
            title={t('heartbeat.editor.expandPrompt')}
            className={cn(
              'bg-bg border-border block w-full cursor-pointer rounded-lg border px-3 py-2 text-start',
              'hover:border-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'
            )}
          >
            {draftPrompt.trim() ? (
              <pre
                dir="auto"
                className="text-muted max-h-40 overflow-y-auto overscroll-contain font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap"
              >
                {draftPrompt}
              </pre>
            ) : (
              <span className="text-muted/60 font-mono text-xs italic">
                {t('heartbeat.editor.promptPlaceholder')}
              </span>
            )}
          </button>
          {/* The same secondary action the phone offers under its preview. The
                block above is still the primary target — this is the affordance
                that says so, for anyone who does not think to click a code block. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPromptExpanded(true)}
            className="self-start"
          >
            {draftPrompt.trim()
              ? t('heartbeat.editor.editPrompt')
              : t('heartbeat.editor.addPrompt')}
          </Button>
          <p className="text-muted text-xs">{t('heartbeat.editor.autosaveHint')}</p>
        </div>
      </Modal>

      {/* The expanded prompt editor — the composer's own expand dialog, over
          the same draft state, so what is typed here autosaves on the dialog's
          debounce and the preview above reflects it the moment this closes. */}
      {editorOpen &&
        promptExpanded &&
        createPortal(
          <div
            role="presentation"
            onClick={() => setPromptExpanded(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="border-border bg-surface flex h-[80vh] w-[80vw] flex-col overflow-hidden rounded-2xl border shadow-xl"
            >
              <CodeEditor
                value={draftPrompt}
                language="markdown"
                isDark={isDark}
                onChange={setDraftPrompt}
                placeholder={t('heartbeat.editor.promptPlaceholder')}
                className="min-h-0 flex-1 overflow-auto"
                spellcheck
              />
            </div>
          </div>,
          document.body
        )}

      <Modal
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        title={t('heartbeat.guide.title')}
        className="max-w-xl"
      >
        <div className="flex flex-col gap-3">
          <p className="text-muted text-sm leading-relaxed">{t('heartbeat.guide.intro')}</p>
          {/* Stacked rows (code block, description under it) grow tall with
              10 forms — the list scrolls so the intro and footer notes stay
              put and the dialog never outgrows the viewport. */}
          <ul className="flex max-h-[55vh] flex-col gap-2.5 overflow-y-auto pe-1">
            {GUIDE_ROWS.map((row) => (
              <li key={row.key} className="flex flex-col gap-1">
                <div
                  dir="ltr"
                  className="bg-bg border-border flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5"
                >
                  <code className="text-fg font-mono text-xs">{row.code}</code>
                  <CopyButton text={row.code} size={13} variant="inline" className="shrink-0" />
                </div>
                <span className="text-muted px-0.5 text-xs leading-relaxed">
                  {t(`heartbeat.guide.${row.key}`)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted text-xs leading-relaxed">{t('heartbeat.guide.localTime')}</p>
          <p className="text-muted text-xs leading-relaxed">{t('heartbeat.guide.chipsTip')}</p>
        </div>
      </Modal>

      {deleteTarget && (
        <Modal
          open
          onClose={() => {
            if (!deleting) setDeleteTarget(null)
          }}
          dismissable={!deleting}
          title={t('heartbeat.deleteTitle')}
          footer={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="flex-1"
              >
                {t('heartbeat.deleteCancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={deleting}
                onClick={() => void handleDelete(deleteTarget)}
                className="flex-1 border border-transparent bg-red-600 text-white shadow-none hover:bg-red-700"
              >
                {t('heartbeat.deleteConfirm')}
              </Button>
            </div>
          }
        >
          <p className="text-muted">{t('heartbeat.deleteWarning', { name: deleteTarget.label })}</p>
        </Modal>
      )}
    </main>
  )
}
