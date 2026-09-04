/**
 * The admin conversation Log tab, against REAL conversation files.
 *
 *   npx tsx --tsconfig tsconfig.node.json \
 *     src/renderer/src/pages/settings/admin/__tests__/action-log.test.ts
 *
 * Why real files rather than a fixture: the log reads the persisted
 * assistant SEGMENTS, a shape this module does not own — the runtime writes
 * it. A hand-made fixture would encode whatever shape I believed on the day
 * I wrote it, and would keep passing after the real one moved, leaving the
 * Log tab silently empty for every admin. So the test walks the workspace's
 * own conversations and fails if it cannot find tool calls in a file that
 * demonstrably contains them.
 *
 * It is skipped (not failed) when the workspace has no conversation with a
 * tool call — a fresh install has nothing to check.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { actionLog } from '../actionLog'
import type { ConversationFile } from '@preload/index'

const DIR = join(homedir(), '.wfc', 'workspace', 'brain', 'conversations')

let failures = 0
const check = (name: string, cond: unknown, extra = ''): void => {
  const ok = Boolean(cond)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failures++
}

type RawSegment = { kind?: string; name?: string }
type RawMessage = { role?: string; segments?: RawSegment[] }

function loadAll(): Array<{ file: string; conv: ConversationFile }> {
  let names: string[]
  try {
    names = readdirSync(DIR).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: Array<{ file: string; conv: ConversationFile }> = []
  for (const name of names) {
    try {
      out.push({ file: name, conv: JSON.parse(readFileSync(join(DIR, name), 'utf8')) })
    } catch {
      // A half-written file is not this test's problem.
    }
  }
  return out
}

const all = loadAll()
if (all.length === 0) {
  console.log('… no local conversations — nothing to check')
  process.exit(0)
}

// Ground truth, counted independently of the code under test: every
// tool_call segment on every assistant message, straight out of the JSON.
function countByHand(conv: ConversationFile): number {
  let n = 0
  for (const m of (conv.messages ?? []) as RawMessage[]) {
    if (m.role !== 'assistant') continue
    for (const s of m.segments ?? []) if (s.kind === 'tool_call') n++
  }
  return n
}

const withCalls = all.filter(({ conv }) => countByHand(conv) > 0)
check(
  `found conversations with tool calls (${withCalls.length} of ${all.length})`,
  withCalls.length > 0
)
if (withCalls.length === 0) {
  console.log('… no conversation on disk has a tool call — nothing to check')
  process.exit(0)
}

let totalHand = 0
let totalLogged = 0
let named = 0
let ordered = true
let browserSeen = 0
for (const { file, conv } of withCalls) {
  const hand = countByHand(conv)
  const entries = actionLog(conv)
  totalHand += hand
  totalLogged += entries.length
  if (entries.length !== hand) {
    check(`${file}: every tool call is logged`, false, `${entries.length} vs ${hand}`)
  }
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.timestamp < entries[i - 1]!.timestamp) ordered = false
  }
  for (const e of entries) {
    if (e.name.length > 0) named++
    if (e.browser) browserSeen++
  }
}

check(`every tool call is logged (${totalLogged} of ${totalHand})`, totalLogged === totalHand)
check('every entry is named', named === totalLogged)
check('entries are in chronological order', ordered)

// The details line must be a one-line summary, never a dump: a write_file
// call carries the whole file, and a log that prints it is not a log.
const sample = withCalls.flatMap(({ conv }) => actionLog(conv))
const longest = sample.reduce((m, e) => Math.max(m, e.detail.length), 0)
check(`details are clipped (longest ${longest} chars)`, longest <= 160)
check(
  'details are single-line',
  sample.every((e) => !e.detail.includes('\n'))
)

// The browser flag is what separates extension actions from everything else.
const browserNames = new Set(sample.filter((e) => e.browser).map((e) => e.name))
check(
  `browser actions are flagged (${browserSeen} across ${browserNames.size} tools)`,
  [...browserNames].every((n) => n.startsWith('browser_'))
)
const shouldBeBrowser = sample.filter((e) => e.name.startsWith('browser_') && !e.browser)
check('no browser_* tool is left unflagged', shouldBeBrowser.length === 0)

// A conversation with no assistant segments at all must yield [], not throw:
// restored records from an older build can look exactly like this.
check(
  'a message-less conversation yields no actions',
  actionLog({ messages: [] } as unknown as ConversationFile).length === 0
)
check(
  'a segment-less assistant message yields no actions',
  actionLog({
    messages: [{ role: 'assistant', content: 'hi', timestamp: 1, id: 'm1' }]
  } as unknown as ConversationFile).length === 0
)

// A multi-line argument is the case the real corpus happens not to cover:
// every tool that writes a file or runs a shell command carries one.
const multiline = actionLog({
  messages: [
    {
      role: 'assistant',
      id: 'm1',
      timestamp: 1,
      segments: [
        {
          kind: 'tool_call',
          segmentId: 's1',
          name: 'write_file',
          args: { path: '/tmp/x.txt', content: 'first line\nsecond line\n\tthird' }
        }
      ]
    }
  ]
} as unknown as ConversationFile)
check(
  'a multi-line argument stays on one row',
  !multiline[0]!.detail.includes('\n'),
  multiline[0]?.detail
)
check(
  'a multi-line argument keeps its words',
  multiline[0]!.detail.includes('first line second line')
)

console.log(failures === 0 ? '\nACTION LOG: ALL PASS' : `\nACTION LOG: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
