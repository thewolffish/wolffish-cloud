/**
 * Tests for the LLM conversation titler (src/main/conversation-titler.ts).
 *
 * Titling is now a PURE LLM call to the chosen model, run up front before a
 * turn processes: it produces a title and persists it (writing a titled shell
 * for an in-app conversation whose file doesn't exist yet). Covered here:
 *  - the model's framing (quotes / "Title:" / trailing punctuation) is cleaned
 *  - a new conversation is persisted with the title (shell created)
 *  - an already-titled conversation is returned as-is with NO LLM call
 *  - the LLM being unreachable falls back to a plain trim (never throws)
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wfc workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/__tests__/conversation-titler.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-titler-'))
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

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

async function run(): Promise<void> {
  const { titleFromMessage, ensureConversationTitle, TITLE_DEADLINE_REASON } =
    await import('@main/conversation-titler')
  const { loadConversation, createConversation, saveConversation } =
    await import('@main/conversations')

  // ── titleFromMessage cleans the model's framing ────────────────────────
  {
    const llm = { title: async (): Promise<{ text: string }> => ({ text: '"Weekly Report."' }) }
    const t = await titleFromMessage('draft my weekly report', llm)
    ok('clean: strips wrapping quotes and trailing period', t === 'Weekly Report', t)
  }
  {
    const llm = {
      title: async (): Promise<{ text: string }> => ({ text: 'Title: Plan the Trip\nextra' })
    }
    const t = await titleFromMessage('help me plan a trip', llm)
    ok('clean: strips "Title:" prefix and extra lines', t === 'Plan the Trip', t)
  }

  // ── ensureConversationTitle persists a titled shell for a new chat ──────
  {
    const id = `2099-01-01_00-00-00_000-titl01`
    let calls = 0
    const llm = {
      title: async (): Promise<{ text: string }> => {
        calls++
        return { text: 'Refactor the Auth Flow' }
      }
    }
    const title = await ensureConversationTitle(
      id,
      'refactor the auth flow please',
      'electron',
      llm
    )
    ok('new: returns the LLM title', title === 'Refactor the Auth Flow', title)
    const onDisk = await loadConversation(id)
    ok('new: shell was persisted with the title', onDisk?.title === 'Refactor the Auth Flow')
    ok(
      'new: shell carries the user message',
      onDisk?.messages.length === 1 && onDisk?.messages[0].role === 'user',
      JSON.stringify(onDisk?.messages)
    )
    ok('new: exactly one LLM call', calls === 1, String(calls))

    // Second call on the now-titled conversation: NO LLM call, existing title.
    const again = await ensureConversationTitle(id, 'a different message', 'electron', llm)
    ok('idempotent: keeps the existing title', again === 'Refactor the Auth Flow', again)
    ok('idempotent: no second LLM call', calls === 1, String(calls))
  }

  // ── an existing conversation with a real title is never re-titled ──────
  {
    const conv = createConversation(null)
    conv.title = 'Hand-Picked Title'
    conv.messages.push({ role: 'user', content: 'hello', timestamp: 1 })
    await saveConversation(conv)
    let calls = 0
    const llm = {
      title: async (): Promise<{ text: string }> => {
        calls++
        return { text: 'Should Not Be Used' }
      }
    }
    const title = await ensureConversationTitle(conv.id, 'hello again', 'electron', llm)
    ok('resumed: keeps the hand-picked title', title === 'Hand-Picked Title', title)
    ok('resumed: no LLM call', calls === 0, String(calls))
  }

  // ── the LLM being unreachable falls back to a plain trim (never throws) ─
  {
    const llm = {
      title: async (): Promise<{ text: string }> => {
        throw new Error('offline')
      }
    }
    const t = await titleFromMessage('summarize the quarterly earnings for me', llm)
    ok(
      'fallback: uses a trimmed slice of the message',
      t === 'summarize the quarterly earnings for me',
      t
    )
    // And a very long message is capped.
    const long = 'x'.repeat(500)
    const capped = await titleFromMessage(long, llm)
    ok('fallback: caps overly long titles', capped.length <= 80, String(capped.length))
  }

  // ── empty message → Untitled, no persistence ───────────────────────────
  {
    const llm = { title: async (): Promise<{ text: string }> => ({ text: 'nope' }) }
    const t = await titleFromMessage('   ', llm)
    ok('empty: returns Untitled', t === 'Untitled', t)
  }

  // ── title-source sanitizer: delivery markup never reaches the title ─────
  {
    // The composed history content carries an <attachments> block (filename,
    // mime, size, absolute path — load-bearing for the agent's file tools).
    // The TITLE is named from the user's words alone: the block, and every
    // piece of plumbing inside it, must be stripped before the model sees it.
    let seen = ''
    const llm = {
      title: async (userMessage: string): Promise<{ text: string }> => {
        seen = userMessage
        return { text: 'Q3 Budget Review' }
      }
    }
    const block =
      'review the budget\n\n<attachments>\nThe user attached 1 file to this message:\n' +
      '  - q3-budget-final.xlsx (type=document, mime=application/vnd.ms-excel, size=1234b, path=/Users/x/.wfc/uploads/q3-budget-final.xlsx, ext=.xlsx)\n' +
      '</attachments>'
    const t = await titleFromMessage(block, llm)
    ok('with caption: titled by the model from the prose', t === 'Q3 Budget Review', t)
    ok('with caption: the prose reaches the model', seen.includes('review the budget'), seen)
    ok('with caption: no absolute path reaches the model', !seen.includes('/Users/x/'), seen)
    ok('with caption: no mime/size reaches the model', !/mime=|size=|ext=/.test(seen), seen)
    ok('with caption: the attachments block is gone', !seen.includes('<attachments'), seen)
  }
  {
    // A caption-less attachment composes to ONLY the <attachments> block, so
    // there are no user words to title from. It stays 'Untitled' for one turn
    // (the next message names it) and the model is never called for it.
    let calls = 0
    const counting = {
      title: async (): Promise<{ text: string }> => {
        calls++
        return { text: 'Should Not Run' }
      }
    }
    const block =
      '<attachments>\nThe user attached 1 file to this message:\n' +
      '  - invoice.pdf (type=document, mime=application/pdf, size=9b, path=/tmp/invoice.pdf)\n' +
      '</attachments>'
    const t = await titleFromMessage(block, counting)
    ok('caption-less: stays Untitled (self-heals next turn)', t === 'Untitled', t)
    ok('caption-less: no LLM call when there is nothing to name', calls === 0, String(calls))
    const empty = await titleFromMessage('<attachments>\n</attachments>', counting)
    ok('caption-less: no files and no words → Untitled', empty === 'Untitled', empty)
  }
  {
    // The titler must hand the model the user's words, not the markup. Capture
    // the user message the title() call receives and assert every wrapper is gone.
    let seen = ''
    const llm = {
      title: async (userMessage: string): Promise<{ text: string }> => {
        seen = userMessage
        return { text: 'Plan The Trip' }
      }
    }
    const voice =
      '<voice_note lang="en">\nlet us plan a trip to japan\n\n' +
      '<attachments>\nThe user attached 1 file to this message:\n  - clip.ogg (type=audio, path=/tmp/clip.ogg)\n</attachments>'
    const t = await titleFromMessage(voice, llm)
    ok('sanitize: voice note titled from transcript', t === 'Plan The Trip', t)
    ok('sanitize: <voice_note> tag stripped from prompt', !seen.includes('<voice_note'), seen)
    ok('sanitize: <attachments> block stripped from prompt', !seen.includes('<attachments'), seen)
    ok('sanitize: transcript reached the model', seen.includes('plan a trip to japan'), seen)
  }
  {
    // Ordinary prose that merely contains < or > must NOT be mangled — the
    // sanitizer is anchored to the exact sentinel tags only.
    let seen = ''
    const llm = {
      title: async (userMessage: string): Promise<{ text: string }> => {
        seen = userMessage
        return { text: 'Compare Two Values' }
      }
    }
    const prose = 'why is a < b but c > d in this compare function'
    const t = await titleFromMessage(prose, llm)
    ok('sanitize: leaves ordinary angle brackets intact', seen.includes('a < b but c > d'), seen)
    ok('sanitize: still titles normally', t === 'Compare Two Values', t)
  }

  // ── a caption-less media turn is never named from its filename ──────────
  // The first real title a conversation gets is its last
  // (ensureConversationTitle short-circuits on any non-'Untitled' title), and
  // a paste is normally followed by the actual question — so naming the chat
  // after a synthetic `pasted-<ts>.png` would bury the real title under a
  // machine name. Staying 'Untitled' for one turn self-heals.
  {
    const block =
      '<attachments>\nThe user attached 1 file to this message:\n' +
      '  - pasted-1752641234567.png (type=image, mime=image/png, size=5b, path=/tmp/p.png)\n' +
      '</attachments>'
    let calls = 0
    const llm = {
      title: async (): Promise<{ text: string }> => {
        calls++
        return { text: 'Pasted PNG Screenshot' }
      }
    }
    const inApp = await titleFromMessage(block, llm)
    ok('scope: caption-less stays Untitled (self-heals next turn)', inApp === 'Untitled', inApp)
    ok('scope: caption-less makes no LLM call', calls === 0, String(calls))
  }
  {
    // offlineTitle (the backfill's namer) carries the same rule.
    const { offlineTitle } = await import('@main/conversation-titler')
    const block =
      '<attachments>\nThe user attached 1 file to this message:\n' +
      '  - voice.mp3 (type=audio, mime=audio/mpeg, size=5b, path=/tmp/v.mp3)\n' +
      '</attachments>'
    ok('scope: offlineTitle leaves caption-less media Untitled', offlineTitle(block) === 'Untitled')
    ok(
      'scope: offlineTitle still slices ordinary prose',
      offlineTitle('fix the auth bug') === 'fix the auth bug'
    )
  }

  // ── abort: a DEADLINE degrades, a CANCEL does not ──────────────────────
  // The two abort sources unwind through the identical throw and want opposite
  // outcomes, so these pin the reason-based split. Regression guard for the
  // real bug: ~30% of channel conversations landed permanently 'Untitled'
  // because a deadline returned '' and the caller then wrote nothing over the
  // 'Untitled' the channel had already persisted before the turn.
  // Deliberately >TITLE_MAX_CHARS (80) and full of collapsible whitespace, so
  // the expected value is what fallbackTitle() PRODUCES, not the raw message —
  // a shorter prompt makes the two identical and the assertion vacuous. This is
  // the real shape anyway: the prompts that timed out were 125–1228 chars.
  const PROMPT =
    'I would like to thank OpenAI for putting out a model exactly when   I needed it most, so run\nthorough factual research and then produce a complete analysis'
  // What fallbackTitle() produces: whitespace collapsed, then cut to
  // TITLE_MAX_CHARS (80) — NOT the 153-char raw message.
  const EXPECTED =
    'I would like to thank OpenAI for putting out a model exactly when I needed it mo'
  // Mirrors thalamus: never resolves, throws once the signal aborts.
  const hangingLlm = {
    title: (_m: string, _s: string, signal?: AbortSignal): Promise<{ text: string }> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
  }
  {
    const c = new AbortController()
    setTimeout(() => c.abort(TITLE_DEADLINE_REASON), 5)
    const t = await titleFromMessage(PROMPT, hangingLlm, c.signal)
    ok('deadline: degrades to a plain slice rather than ""', t === EXPECTED, t)
  }
  {
    const c = new AbortController()
    setTimeout(() => c.abort(), 5)
    const t = await titleFromMessage(PROMPT, hangingLlm, c.signal)
    ok('cancel: still yields "" so no degraded title is persisted', t === '', t)
  }
  {
    // The channel path: an 'Untitled' shell is on disk BEFORE the turn (what
    // a channel's loadOrCreateConversation does), then the deadline fires.
    const conv = createConversation(null)
    conv.channel = 'mobile'
    await saveConversation(conv)
    const c = new AbortController()
    setTimeout(() => c.abort(TITLE_DEADLINE_REASON), 5)
    await ensureConversationTitle(conv.id, PROMPT, 'mobile', hangingLlm, c.signal)
    const disk = await loadConversation(conv.id)
    ok(
      'deadline: overwrites the pre-persisted Untitled placeholder on disk',
      disk?.title === EXPECTED,
      disk?.title
    )
  }
  {
    // Same shape, genuine cancel: must stay Untitled and unwritten so the
    // next turn produces the real title instead of inheriting a slice.
    const conv = createConversation(null)
    conv.channel = 'mobile'
    await saveConversation(conv)
    const c = new AbortController()
    setTimeout(() => c.abort(), 5)
    await ensureConversationTitle(conv.id, PROMPT, 'mobile', hangingLlm, c.signal)
    const disk = await loadConversation(conv.id)
    ok(
      'cancel: leaves Untitled on disk for a later turn to re-title',
      disk?.title === 'Untitled',
      disk?.title
    )
  }

  // ── the titling call goes out with reasoning OFF ───────────────────────
  // Thalamus.title is what backs the TitlerLLM above, and this is the half of
  // the fix nothing else pins: a title used to ship with thinkingMode
  // undefined, which effortFromMode() defaults to 'high' — a high-effort
  // reasoning call to name a chat in 5 words (measured p50 11.4s against the
  // caller's 15s deadline; ~30% expired -> permanently 'Untitled').
  //
  // This guards the LIVE path, not the helper: drop the thinkingMode line from
  // completeSingle and this fails. It has to be a live-path test, because the
  // symptom that used to expose the regression on disk ('Untitled') is exactly
  // what the deadline fix now converts into a plausible-looking slice.
  {
    const { Thalamus } = await import('@main/runtime/thalamus')
    const seen: Array<Record<string, unknown>> = []
    const fakeLocal = {
      isReady: true,
      currentModel: 'llama3',
      async *stream(opts: Record<string, unknown>): AsyncGenerator<{ type: string; text: string }> {
        seen.push(opts)
        yield { type: 'text', text: 'A Fine Title' }
      }
    }
    const th = new Thalamus({ testProvider: fakeLocal as never })
    th.setModel('llama3')

    const t = await th.title('draft my weekly report', 'SYSTEM')
    ok('thalamus.title: returns the model text', t.text === 'A Fine Title', t.text)
    ok('thalamus.title: sends an explicit thinkingMode', seen[0]?.thinkingMode !== undefined)
    ok(
      "thalamus.title: reasoning is OFF (not effortFromMode's 'high' default)",
      seen[0]?.thinkingMode === 'off',
      String(seen[0]?.thinkingMode)
    )

    // Summaries are utility work: reasoning OFF, normalized to the model's
    // own modes (thalamus's 'summary' role policy) — never the user's chat
    // reasoning selection. Pins that the role gate is a gate.
    seen.length = 0
    await th.summarize('some conversation text to compress')
    ok(
      'thalamus.summarize: reasoning clamped off',
      seen[0]?.thinkingMode === 'off',
      String(seen[0]?.thinkingMode)
    )
  }

  // ── the clamp never sends a mode a model rejects ───────────────────────
  // Providers assume thinkingMode arrives clamped to the model's registry
  // (xai.ts's grok-4.5 branch reads it directly). An always-on reasoner has no
  // 'off', so titling must degrade to its LOWEST valid mode rather than send a
  // rejected one and 400 every first message.
  {
    const { normalizeReasoningMode, reasoningModesFor } = await import('@main/runtime/reasoning')
    // The one lane: the V4 pair reasons (off/high/max) and clamps to 'off';
    // a catalog model without reasoning has no modes and titles at 'off' too.
    const CASES: Array<[string, string, string]> = [
      ['cloud', 'deepseek-ai/DeepSeek-V4-Pro-0813', 'off'],
      ['cloud', 'deepseek-ai/DeepSeek-V4-Flash-0731', 'off'],
      ['cloud', 'some-vendor/plain-chat-model', 'off']
    ]
    for (const [provider, model, want] of CASES) {
      const modes = reasoningModesFor(provider, model)
      const got = normalizeReasoningMode('off', modes)
      ok(`clamp: ${provider}/${model} titles at '${want}'`, got === want, got)
      ok(
        `clamp: ${provider}/${model} never sends an unsupported mode`,
        modes.length === 0 || modes.includes(got),
        `${got} not in ${JSON.stringify(modes)}`
      )
    }
  }

  await fs.promises.rm(TEST_HOME, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run()
