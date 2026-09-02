import { diskWriter } from '@main/io/diskWriter'
import type { Corpus } from '@main/runtime/corpus'
import type { ProviderId } from '@main/runtime/thalamus'
import fs from 'node:fs/promises'
import path from 'node:path'
import { catalogPricing } from '@main/cloud/catalog'

export type UsageEntry = {
  timestamp: Date
  provider: ProviderId
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  cost: number
}

export type TimeRange = 'today' | 'this_month' | '3_months' | '6_months' | 'ytd' | 'all_time'

export type UsageStatsTotals = {
  messages: number
  conversations: number
  activeDays: number
  longestStreak: number
  totalTokens: number
  favouriteModel: string | null
  /** LLM spend plus Brave query fees, so it matches the sum of the provider cards. */
  totalCost: number
  topSpendDay: { date: string; cost: number } | null
}

export type ProviderUsageSummary = {
  provider: ProviderId
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  models: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>
}

export type BraveUsageSummary = {
  totalQueries: number
  totalCost: number
}

export type UsageSummary = {
  providers: ProviderUsageSummary[]
  brave: BraveUsageSummary
}

export type DailyUsage = {
  date: string
  totalTokens: number
}

/** One model's ledger lines on one calendar day, summed. `entries` is the
 *  line count — the unit the Usage panel calls "messages". */
export type UsageModelDay = {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
  entries: number
}

/** One calendar day of the ledger, as served to the phone. */
export type UsageDay = {
  date: string
  models: UsageModelDay[]
  braveQueries: number
}

export type UsageOptions = {
  workspaceRoot?: string
  corpus?: Corpus
}

type CachedEntry = {
  timestamp: string
  provider: ProviderId
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  cost: number
}

type ModelPricing = {
  input: number // $/token
  output: number // $/token
  cacheWrite: number // multiplier on input rate (e.g. 1.25 → 125% of base)
  cacheRead: number // multiplier on input rate (e.g. 0.10 → 10% of base)
}

/**
 * PLACEHOLDER pricing for the local scratch ledger. Authoritative cost is
 * metered per-request by the org API (DeepInfra's own bill lands in the
 * master usage table); this local estimate exists only so the on-device
 * ledger has an order-of-magnitude number before API integration wires
 * the real figures through.
 */
const CLOUD_PRICING: Record<string, ModelPricing> = {
  'deepseek-ai/DeepSeek-R1': {
    input: 0.5 / 1e6,
    output: 2.15 / 1e6,
    cacheWrite: 1.0,
    cacheRead: 1.0
  },
  'deepseek-ai/DeepSeek': { input: 0.27 / 1e6, output: 1.0 / 1e6, cacheWrite: 1.0, cacheRead: 1.0 }
}

const BRAVE_COST_PER_QUERY = 0.005

type CachedBraveEntry = {
  timestamp: string
}

export class Usage {
  private workspaceRoot: string | null
  private corpus: Corpus | null
  private cache: CachedEntry[] = []
  private braveCache: CachedBraveEntry[] = []
  private loaded = false
  /** In-flight load, so concurrent turns finishing together share ONE parse. */
  private loadPromise: Promise<void> | null = null

  constructor(options: UsageOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? null
    this.corpus = options.corpus ?? null
  }

  async load(): Promise<void> {
    if (this.loaded || !this.workspaceRoot) return
    // Single-flight: without this, two turns finishing near-simultaneously each
    // parse the files fresh and each OVERWRITE this.cache — the second parse
    // clobbers the entry the first already push()ed, silently dropping recorded
    // spend from the in-memory ledger until the next restart/sync.
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      this.cache = await this.parseAllProviderFiles()
      this.braveCache = await this.parseBraveFile()
      this.loaded = true
    })().finally(() => {
      this.loadPromise = null
    })
    return this.loadPromise
  }

  async sync(): Promise<void> {
    this.loadPromise = null
    this.loaded = false
    this.cache = []
    this.braveCache = []
    await this.load()
  }

  async recordUsage(entry: UsageEntry): Promise<void> {
    if (!this.workspaceRoot) return
    await this.load()

    // Cache the timestamp in local-naive form (`YYYY-MM-DDTHH:MM:SS`)
    // matching what parseProviderLine produces on file roundtrip. Using
    // `toISOString()` here would store UTC, which slice(0, 10) then
    // attributes to the wrong calendar day for any user east of UTC who
    // records a turn between local midnight and UTC midnight (e.g. a
    // 02:30 AM Riyadh turn on May 1 would show under April 30 until the
    // app is restarted and the cache is rebuilt from the file).
    const cached: CachedEntry = {
      timestamp: `${formatDate(entry.timestamp)}T${formatTime(entry.timestamp)}`,
      provider: entry.provider,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cost: entry.cost
    }
    this.cache.push(cached)

    await this.appendToProviderFile(entry)
    await this.appendToDailyFile(entry)

    this.corpus?.emit('usage.recorded', {
      provider: entry.provider,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationTokens: entry.cacheCreationTokens ?? 0,
      cacheReadTokens: entry.cacheReadTokens ?? 0,
      cost: entry.cost
    })
  }

  async getSummary(range: TimeRange): Promise<UsageSummary> {
    await this.load()
    const cutoff = rangeCutoff(range)
    const filtered = this.cache.filter((e) => e.timestamp >= cutoff)

    const byProvider = new Map<ProviderId, { entries: CachedEntry[] }>()
    for (const entry of filtered) {
      const bucket = byProvider.get(entry.provider) ?? { entries: [] }
      bucket.entries.push(entry)
      byProvider.set(entry.provider, bucket)
    }

    const providers: ProviderUsageSummary[] = []
    for (const pid of ['cloud'] as ProviderId[]) {
      const bucket = byProvider.get(pid)
      if (!bucket) {
        providers.push({
          provider: pid,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCost: 0,
          models: []
        })
        continue
      }

      const modelMap = new Map<
        string,
        { inputTokens: number; outputTokens: number; cost: number }
      >()
      let totalInput = 0
      let totalOutput = 0
      let totalCost = 0

      for (const e of bucket.entries) {
        totalInput += e.inputTokens
        totalOutput += e.outputTokens
        totalCost += e.cost
        const m = modelMap.get(e.model) ?? { inputTokens: 0, outputTokens: 0, cost: 0 }
        m.inputTokens += e.inputTokens
        m.outputTokens += e.outputTokens
        m.cost += e.cost
        modelMap.set(e.model, m)
      }

      providers.push({
        provider: pid,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalCost: totalCost,
        models: [...modelMap.entries()].map(([model, stats]) => ({ model, ...stats }))
      })
    }

    const braveCutoff = rangeCutoff(range)
    const braveFiltered = this.braveCache.filter((e) => e.timestamp >= braveCutoff)
    const brave: BraveUsageSummary = {
      totalQueries: braveFiltered.length,
      totalCost: braveFiltered.length * BRAVE_COST_PER_QUERY
    }

    return { providers, brave }
  }

  async getDaily(year: number): Promise<DailyUsage[]> {
    await this.load()
    const yearStr = String(year)
    const byDay = new Map<string, number>()
    for (const entry of this.cache) {
      const date = entry.timestamp.slice(0, 10)
      if (!date.startsWith(yearStr)) continue
      byDay.set(date, (byDay.get(date) ?? 0) + entry.inputTokens + entry.outputTokens)
    }
    return [...byDay.entries()]
      .map(([date, totalTokens]) => ({ date, totalTokens }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  /**
   * The whole ledger folded per (day × provider × model) — the rows the phone
   * ships in its config snapshot and aggregates on device. Nothing is lost in
   * the fold: every range this class answers is midnight-aligned, so day-level
   * rows answer the same questions the per-line cache does, and the phone's
   * Usage screen lands on the same numbers as this app's own panel.
   *
   * Day keys are the ledger's local-naive dates (`timestamp.slice(0, 10)`),
   * the same slice every reader above uses — the two apps can never disagree
   * about which day a turn belongs to.
   */
  async getDays(): Promise<UsageDay[]> {
    await this.load()
    const byDay = new Map<string, { models: Map<string, UsageModelDay>; braveQueries: number }>()
    const dayFor = (date: string): { models: Map<string, UsageModelDay>; braveQueries: number } => {
      let day = byDay.get(date)
      if (!day) {
        day = { models: new Map(), braveQueries: 0 }
        byDay.set(date, day)
      }
      return day
    }
    for (const entry of this.cache) {
      const day = dayFor(entry.timestamp.slice(0, 10))
      const key = `${entry.provider} ${entry.model}`
      let row = day.models.get(key)
      if (!row) {
        row = {
          provider: entry.provider,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          entries: 0
        }
        day.models.set(key, row)
      }
      row.inputTokens += entry.inputTokens
      row.outputTokens += entry.outputTokens
      row.cost += entry.cost
      row.entries += 1
    }
    for (const query of this.braveCache) {
      dayFor(query.timestamp.slice(0, 10)).braveQueries += 1
    }
    return [...byDay.entries()]
      .map(([date, day]) => ({
        date,
        models: [...day.models.values()],
        braveQueries: day.braveQueries
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  async getStats(range: TimeRange): Promise<Omit<UsageStatsTotals, 'conversations'>> {
    await this.load()
    const cutoff = rangeCutoff(range)
    const filtered = this.cache.filter((e) => e.timestamp >= cutoff)

    let totalTokens = 0
    let totalCost = 0
    const days = new Set<string>()
    const costByDay = new Map<string, number>()
    const modelCounts = new Map<string, number>()

    for (const e of filtered) {
      totalTokens += e.inputTokens + e.outputTokens
      totalCost += e.cost
      const day = e.timestamp.slice(0, 10)
      days.add(day)
      costByDay.set(day, (costByDay.get(day) ?? 0) + e.cost)
      modelCounts.set(e.model, (modelCounts.get(e.model) ?? 0) + 1)
    }

    // Brave queries are paid too; counting them keeps totalCost equal to the
    // sum of the per-provider cards plus the Brave card. They stay out of
    // `days` so activeDays keeps meaning "days with LLM turns".
    for (const b of this.braveCache) {
      if (b.timestamp < cutoff) continue
      totalCost += BRAVE_COST_PER_QUERY
      const day = b.timestamp.slice(0, 10)
      costByDay.set(day, (costByDay.get(day) ?? 0) + BRAVE_COST_PER_QUERY)
    }

    let topSpendDay: { date: string; cost: number } | null = null
    for (const [date, cost] of costByDay) {
      if (!topSpendDay || cost > topSpendDay.cost) topSpendDay = { date, cost }
    }

    let favouriteModel: string | null = null
    let topCount = 0
    for (const [model, count] of modelCounts) {
      if (count > topCount) {
        favouriteModel = model
        topCount = count
      }
    }

    return {
      messages: filtered.length,
      activeDays: days.size,
      longestStreak: longestConsecutiveStreak([...days]),
      totalTokens,
      favouriteModel,
      totalCost,
      topSpendDay
    }
  }

  private usageDir(): string {
    return path.join(this.workspaceRoot!, 'usage')
  }

  private providerFilePath(provider: ProviderId): string {
    return path.join(this.usageDir(), 'providers', `${provider}.md`)
  }

  private dailyFilePath(date: string): string {
    return path.join(this.usageDir(), 'daily', `${date}.md`)
  }

  private async appendToProviderFile(entry: UsageEntry): Promise<void> {
    await appendProviderLine(this.providerFilePath(entry.provider), entry.provider, {
      at: entry.timestamp,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cost: entry.cost
    })
  }

  private async appendToDailyFile(entry: UsageEntry): Promise<void> {
    await appendDailyLine(this.dailyFilePath(formatDate(entry.timestamp)), entry.provider, {
      at: entry.timestamp,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cost: entry.cost
    })
  }

  private async parseAllProviderFiles(): Promise<CachedEntry[]> {
    if (!this.workspaceRoot) return []
    const entries: CachedEntry[] = []
    const providerDir = path.join(this.usageDir(), 'providers')

    const providerFiles: Array<{ file: string; provider: ProviderId }> = [
      { file: 'cloud.md', provider: 'cloud' }
    ]

    for (const { file, provider } of providerFiles) {
      const filepath = path.join(providerDir, file)
      let raw: string
      try {
        raw = await fs.readFile(filepath, 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split(/\r?\n/)) {
        const parsed = parseProviderLine(line, provider)
        if (parsed) entries.push(parsed)
      }
    }

    return entries
  }

  private async parseBraveFile(): Promise<CachedBraveEntry[]> {
    if (!this.workspaceRoot) return []
    const filepath = path.join(this.usageDir(), 'providers', 'brave.md')
    let raw: string
    try {
      raw = await fs.readFile(filepath, 'utf8')
    } catch {
      return []
    }
    const entries: CachedBraveEntry[] = []
    for (const line of raw.split(/\r?\n/)) {
      const m = /^-\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+\|/.exec(line)
      if (m) entries.push({ timestamp: `${m[1]}T${m[2]}` })
    }
    return entries
  }
}

// ── The ledger files themselves ──────────────────────────────────────────
//
// One line per metered call, appended by this process at turn end AND by
// the cloud sync when it reconciles the org's authoritative usage table
// (a purged install rebuilds the whole ledger from it; a running one folds
// in what the user's other devices spent). Both writers share these
// formatters, so the parser above always sees one shape.

/** One ledger line's worth of a metered call. */
export type LedgerRow = {
  at: Date
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  cost: number
}

const cachePartOf = (row: LedgerRow): string =>
  row.cacheCreationTokens || row.cacheReadTokens
    ? ` cw:${row.cacheCreationTokens ?? 0} cr:${row.cacheReadTokens ?? 0}`
    : ''

/** `- date time | model | in:N out:N[ cw:N cr:N] | $cost` — the provider ledger line. */
export function providerLedgerLine(row: LedgerRow): string {
  return `- ${formatDate(row.at)} ${formatTime(row.at)} | ${row.model} | in:${row.inputTokens} out:${row.outputTokens}${cachePartOf(row)} | $${row.cost.toFixed(6)}\n`
}

/** `- time | provider | model | in:N out:N[ cw:N cr:N] | $cost` — the daily file line. */
export function dailyLedgerLine(row: LedgerRow, provider: ProviderId = 'cloud'): string {
  return `- ${formatTime(row.at)} | ${providerLabel(provider)} | ${row.model} | in:${row.inputTokens} out:${row.outputTokens}${cachePartOf(row)} | $${row.cost.toFixed(6)}\n`
}

async function appendProviderLine(
  filepath: string,
  provider: ProviderId,
  row: LedgerRow
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
  } catch {
    return
  }
  const line = providerLedgerLine(row)
  // Header/date-section decision runs INSIDE the file's write queue — the
  // probe used to run outside it, so two turns finishing together wrote
  // duplicate date headers.
  const dateHeader = `## ${formatDate(row.at)}`
  try {
    await diskWriter.update(filepath, (raw) => {
      const existing = raw ?? ''
      if (!existing.includes(dateHeader)) {
        const body =
          existing.length === 0
            ? `# ${providerLabel(provider)}\n\n${dateHeader}\n\n${line}`
            : `\n${dateHeader}\n\n${line}`
        return existing + body
      }
      return existing + line
    })
  } catch {
    return
  }
}

async function appendDailyLine(
  filepath: string,
  provider: ProviderId,
  row: LedgerRow
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
  } catch {
    return
  }
  const line = dailyLedgerLine(row, provider)
  try {
    await diskWriter.appendWithInit(filepath, (exists) =>
      exists ? line : `# ${formatDate(row.at)}\n\n${line}`
    )
  } catch {
    return
  }
}

/** Append one call to the ledger (provider file + that day's file). */
export async function appendLedgerRow(workspaceRoot: string, row: LedgerRow): Promise<void> {
  const usageDir = path.join(workspaceRoot, 'usage')
  await appendProviderLine(path.join(usageDir, 'providers', 'cloud.md'), 'cloud', row)
  await appendDailyLine(path.join(usageDir, 'daily', `${formatDate(row.at)}.md`), 'cloud', row)
}

/**
 * Rewrite the ledger from scratch — the purge+restore path, where the org's
 * usage table is the only record left. Rows are laid out exactly as the
 * incremental writer would have (sorted, one date section per day), so a
 * rebuilt ledger and a lived-in one are indistinguishable to the parser.
 * Goes through the disk writer, so it queues behind any append in flight.
 */
export async function rewriteLedger(workspaceRoot: string, rows: LedgerRow[]): Promise<void> {
  const usageDir = path.join(workspaceRoot, 'usage')
  await fs.mkdir(path.join(usageDir, 'providers'), { recursive: true })
  await fs.mkdir(path.join(usageDir, 'daily'), { recursive: true })
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())
  let provider = `# ${providerLabel('cloud')}\n`
  const daily = new Map<string, string>()
  let currentDate: string | null = null
  for (const row of sorted) {
    const date = formatDate(row.at)
    if (date !== currentDate) {
      provider += `\n## ${date}\n\n`
      currentDate = date
    }
    provider += providerLedgerLine(row)
    daily.set(date, (daily.get(date) ?? `# ${date}\n\n`) + dailyLedgerLine(row, 'cloud'))
  }
  await diskWriter.writeFileAtomic(path.join(usageDir, 'providers', 'cloud.md'), provider)
  for (const [date, text] of daily) {
    await diskWriter.writeFileAtomic(path.join(usageDir, 'daily', `${date}.md`), text)
  }
}

// ── The Brave query ledger ───────────────────────────────────────────────
//
// One line per metered web search: `- date time | web_search | query`. The
// web-search plugin appends this device's queries the moment they return
// (query text included, for the local record); the cloud sync appends the
// user's OTHER devices' searches from the org's usage table and rebuilds the
// whole file after a purge. Those org rows carry no query text — the org
// meters that a search happened, never its content — so they print a
// placeholder in that column. parseBraveFile reads only the timestamp.

export type BraveLedgerRow = { at: Date; query?: string }

const BRAVE_ORG_QUERY = '(metered by the org)'

export function braveLedgerLine(row: BraveLedgerRow): string {
  const safe = (row.query ?? BRAVE_ORG_QUERY).replace(/[|\n\r]/g, ' ').slice(0, 120)
  return `- ${formatDate(row.at)} ${formatTime(row.at)} | web_search | ${safe}\n`
}

const braveLedgerPath = (workspaceRoot: string): string =>
  path.join(workspaceRoot, 'usage', 'providers', 'brave.md')

/** Append one search (header + date section minted inside the write queue). */
export async function appendBraveLedgerRow(
  workspaceRoot: string,
  row: BraveLedgerRow
): Promise<void> {
  const filepath = braveLedgerPath(workspaceRoot)
  try {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
  } catch {
    return
  }
  const line = braveLedgerLine(row)
  const dateHeader = `## ${formatDate(row.at)}`
  try {
    await diskWriter.update(filepath, (raw) => {
      const existing = raw ?? ''
      if (!existing.includes(dateHeader)) {
        return (
          existing +
          (existing.length === 0
            ? `# Brave Search\n\n${dateHeader}\n\n${line}`
            : `\n${dateHeader}\n\n${line}`)
        )
      }
      return existing + line
    })
  } catch {
    return
  }
}

/** Rewrite the Brave ledger from the org's record — the purge+restore path. */
export async function rewriteBraveLedger(
  workspaceRoot: string,
  rows: BraveLedgerRow[]
): Promise<void> {
  const filepath = braveLedgerPath(workspaceRoot)
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())
  let text = '# Brave Search\n'
  let currentDate: string | null = null
  for (const row of sorted) {
    const date = formatDate(row.at)
    if (date !== currentDate) {
      text += `\n## ${date}\n\n`
      currentDate = date
    }
    text += braveLedgerLine(row)
  }
  await diskWriter.writeFileAtomic(filepath, text)
}

function parseProviderLine(line: string, provider: ProviderId): CachedEntry | null {
  const m =
    /^-\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+\|\s+(\S+)\s+\|\s+in:(\d+)\s+out:(\d+)(?:\s+cw:(\d+)\s+cr:(\d+))?\s+\|\s+\$(\d+(?:\.\d+)?)/.exec(
      line
    )
  if (!m) return null
  return {
    timestamp: `${m[1]}T${m[2]}`,
    provider,
    model: m[3],
    inputTokens: Number(m[4]),
    outputTokens: Number(m[5]),
    cacheCreationTokens: m[6] ? Number(m[6]) : undefined,
    cacheReadTokens: m[7] ? Number(m[7]) : undefined,
    cost: Number(m[8])
  }
}

export function calculateCost(
  _provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens?: number,
  cacheReadTokens?: number
): number {
  void _provider
  // Catalog prices (from the org API) win; the static table is the
  // cold-start fallback. Cache reads bill at the catalog input rate —
  // the server meters true upstream cost regardless; this figure feeds
  // the local usage panel only.
  const fromCatalog = catalogPricing(model)
  const pricing = fromCatalog
    ? { input: fromCatalog.input, output: fromCatalog.output, cacheWrite: 1, cacheRead: 0.1 }
    : findPricing(model, CLOUD_PRICING)
  return (
    inputTokens * pricing.input +
    (cacheCreationTokens ?? 0) * pricing.input * pricing.cacheWrite +
    (cacheReadTokens ?? 0) * pricing.input * pricing.cacheRead +
    outputTokens * pricing.output
  )
}

function findPricing(model: string, table: Record<string, ModelPricing>): ModelPricing {
  if (table[model]) return table[model]
  // Sort keys longest-first so 'claude-opus-4-6' matches before 'claude-opus-4'
  const sorted = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const key of sorted) {
    if (model.startsWith(key)) return table[key]
  }
  const values = Object.values(table)
  if (values.length > 0) return values[0]
  return { input: 3 / 1e6, output: 15 / 1e6, cacheWrite: 1.25, cacheRead: 0.1 }
}

// Cutoffs are returned as local-naive datetime strings to match the
// cache format. Mixing UTC ISO here against local-naive entries would
// silently misclassify entries that straddle midnight in either
// direction.
function rangeCutoff(range: TimeRange): string {
  const now = new Date()
  let d: Date
  switch (range) {
    case 'today':
      d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      break
    case 'this_month':
      d = new Date(now.getFullYear(), now.getMonth(), 1)
      break
    case '3_months':
      d = new Date(now.getFullYear(), now.getMonth() - 3, 1)
      break
    case '6_months':
      d = new Date(now.getFullYear(), now.getMonth() - 6, 1)
      break
    case 'ytd':
      d = new Date(now.getFullYear(), 0, 1)
      break
    case 'all_time':
      d = new Date(0)
      break
  }
  return `${formatDate(d)}T${formatTime(d)}`
}

function formatDate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function providerLabel(_provider: ProviderId): string {
  void _provider
  return 'Wolffish Cloud'
}

function longestConsecutiveStreak(dates: string[]): number {
  if (dates.length === 0) return 0
  const sorted = [...dates].sort()
  let longest = 1
  let current = 1
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + 'T00:00:00Z')
    const cur = new Date(sorted[i] + 'T00:00:00Z')
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86_400_000)
    if (diffDays === 1) {
      current++
      if (current > longest) longest = current
    } else if (diffDays > 1) {
      current = 1
    }
  }
  return longest
}
