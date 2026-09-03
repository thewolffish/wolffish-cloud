/**
 * Tests for mergeConversationOnto (conversations.ts) — the one place a
 * renderer's whole-file copy of a channel-owned conversation meets the disk.
 * The caller still owns `messages` outright (matching messages across writers
 * is not sound — see the titler-shell case below), so what these tests pin is
 * that the merge leaves every existing conversation byte-identical and can
 * never erase a conversation's channel.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/conversation-continuation.test.ts
 */

import Module from 'node:module'
import os from 'node:os'

// Shim `electron` before conversations.ts loads: it pulls in workspace.ts,
// which touches electron.app at import and would crash outside Electron.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

import type { ConversationFile, ConversationMessage } from '@main/conversations'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

// --- fixtures ---------------------------------------------------------

function msg(role: 'user' | 'assistant', content: string, timestamp: number): ConversationMessage {
  return { role, content, timestamp }
}

function conv(
  messages: ConversationMessage[],
  over: Partial<ConversationFile> = {}
): ConversationFile {
  return {
    id: 'conv-test',
    title: 'Test',
    model: null,
    messages,
    createdAt: 1000,
    updatedAt: 2000,
    ...over
  }
}

const contents = (c: { messages: ConversationMessage[] }): string[] =>
  c.messages.map((m) => m.content)

async function run(): Promise<void> {
  // Dynamic so the electron shim above is installed first — a static import
  // would be hoisted above it and crash on workspace.ts's electron.app access.
  const { mergeConversationOnto } = await import('@main/conversations')

  // ── mergeConversationOnto: the caller still owns messages ────────────

  // No disk file yet → incoming passes through untouched.
  const fresh = conv([msg('user', 'hi', 1)])
  ok('merge: no disk file → incoming verbatim', mergeConversationOnto(null, fresh) === fresh)

  // The ordinary save: load, append a turn, save. The caller's array wins whole.
  const diskPrefix = conv([msg('user', 'hi', 1), msg('assistant', 'hello', 2)])
  const withTurn = conv([
    msg('user', 'hi', 1),
    msg('assistant', 'hello', 2),
    msg('user', 'more', 3),
    msg('assistant', 'sure', 4)
  ])
  const appended = mergeConversationOnto(diskPrefix, withTurn)
  ok(
    'merge: plain append → incoming messages returned as-is',
    appended.messages === withTurn.messages
  )

  // Identical copies → unchanged.
  const same = conv([msg('user', 'hi', 1), msg('assistant', 'hello', 2)])
  ok(
    'merge: identical copies → no change',
    JSON.stringify(mergeConversationOnto(same, conv(same.messages)).messages) ===
      JSON.stringify(same.messages)
  )

  // The titler writes a shell for the first in-app turn whose messages[0]
  // content is the COMPOSED history string (bare text + the <attachments>
  // block), while the renderer later persists the BARE text. They are the same
  // logical message with different content, which is why the merge must not try
  // to reconcile the two arrays by matching messages: an attempt to do so
  // classed the shell as a separate message and permanently duplicated the
  // opening line of every chat started with an attachment.
  const attachmentShell = conv([
    msg('user', 'what is this?\n\n<attachments>\nphoto.png\n</attachments>', 3000)
  ])
  const rendererBare = conv([msg('user', 'what is this?', 1000), msg('assistant', 'A cat.', 1001)])
  const afterShell = mergeConversationOnto(attachmentShell, rendererBare)
  ok(
    'merge: the titler shell never duplicates the first message',
    afterShell.messages.length === 2,
    `${afterShell.messages.length} messages: ${contents(afterShell).join(' | ')}`
  )
  ok(
    'merge: the persisted first message stays the bare user text',
    afterShell.messages[0].content === 'what is this?'
  )

  // The renderer's load-failure fallback (ensureConversationId) synthesizes a
  // copy with NO channel. Saving that must not erase the conversation's
  // provenance — a phone conversation silently reclassified as in-app would
  // lose its origin badge and its provenance.
  const diskMobile = conv([msg('user', 'hi', 1)], { channel: 'mobile' })
  const channelless = conv([msg('user', 'hi', 1), msg('assistant', 'reply', 2)])
  ok(
    'merge: a channel-less caller copy cannot erase the channel',
    mergeConversationOnto(diskMobile, channelless).channel === 'mobile'
  )
  // But a caller that DOES carry a channel still owns it.
  ok(
    'merge: an explicit incoming channel is kept',
    mergeConversationOnto(diskMobile, conv([msg('user', 'hi', 1)], { channel: 'mobile' }))
      .channel === 'mobile'
  )
  // Unsealing a continued heartbeat run must reach disk (the summarizer skips
  // sealed files, so a continued run would never get a prefix summary).
  const diskSealed = conv([msg('user', 'run', 1)], { channel: 'heartbeat', sealed: true })
  const continuedRun = conv([msg('user', 'run', 1), msg('user', 'follow up', 2)], {
    channel: 'heartbeat',
    sealed: false
  })
  ok(
    'merge: unseal survives the merge',
    mergeConversationOnto(diskSealed, continuedRun).sealed === false
  )

  // The pre-existing merge contract is unchanged.
  const diskSummarized = conv([msg('user', 'hi', 1)], {
    summary: 'disk summary',
    summarizedThroughMessage: 5,
    title: 'Real Title'
  })
  const incomingStale = conv([msg('user', 'hi', 1)], {
    summarizedThroughMessage: 2,
    title: 'Untitled'
  })
  const kept = mergeConversationOnto(diskSummarized, incomingStale)
  ok('merge: disk summary still wins when its mark is ahead', kept.summary === 'disk summary')
  ok('merge: real disk title still beats incoming Untitled', kept.title === 'Real Title')

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
