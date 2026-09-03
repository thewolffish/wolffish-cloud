import type { Segment } from '@preload/index'
import { WORKFLOW_TOOL_NAMES, type WorkflowSnapshot } from '@main/runtime/broca'
import { MARKDOWN_SANITIZE_SCHEMA } from '@lib/markdown/sanitize'
import type { ChatMessage } from '@providers/flow/useFlow'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform, type Options } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

/**
 * Build the self-contained HTML document the main process prints to PDF.
 *
 * The feed (renderSegments in Chat.tsx) is the source of truth: the export
 * walks each assistant message's segments in the same order with the same
 * visibility rules — verbose on prints tool cards (and subagent rails)
 * inline where they appear; verbose off prints the clean feed: text and
 * answered ask_user questions only — tool cards (successful, failed, and
 * denied alike) are dropped. What it doesn't reproduce is interactive chrome
 * (expand toggles, players, file viewers, compaction cards) — file deliveries
 * stay visible through the model's prose, which always prints.
 *
 * Deliberately independent from the app's Markdown component: that one is
 * Tailwind-bound and interactive. Here markdown renders to plain semantic
 * elements and the embedded stylesheet does the rest — including the
 * pagination rules (orphans/widows, keep-with-next headings, repeating table
 * headers, cloned pre/tool/user-block decorations). Whole messages
 * intentionally have no break-inside:avoid so pages fill cleanly instead of
 * leaving gaps.
 */

type ToolCallSegment = Extract<Segment, { kind: 'tool_call' }>
type ToolResultSegment = Extract<Segment, { kind: 'tool_result' }>
type ToolStatus = 'running' | 'success' | 'failed' | 'denied'

const ASK_USER_TOOL = 'ask_user'

/** Print equivalents of the ToolCard's scrollable clamps (max-h-48 etc.). */
const ACTION_CLAMP = 300
const ARGS_CLAMP = 1000
const OUTPUT_CLAMP = 1500

export type ChatPdfOptions = {
  /** Document heading — typically the first user message, truncated. */
  title: string
  /** Localized "exported at" line under the title. */
  exportedAt: string
  userLabel: string
  assistantLabel: string
  /** Localized ToolCard status-pill labels (chat.toolCard.status.*). */
  toolStatusLabels: Record<ToolStatus, string>
  /** The in-app verbose ("tools") display preference the feed renders with. */
  verbose: boolean
  /** Document direction/lang so role labels and header align for RTL locales. */
  locale: string
  rtl: boolean
  messages: ChatMessage[]
}

/** Mirrors the app's Markdown urlTransform: keep workspace media loadable. */
function urlTransform(url: string): string {
  if (url.startsWith('wolffish-media://')) return url
  return defaultUrlTransform(url)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

// Same raw-HTML handling as the feed's Markdown component (rehype-raw +
// the shared sanitize schema) so the print mirrors what the feed rendered —
// details/summary print as bordered blocks (closed ones show the summary
// line only, matching their on-screen state).
const rehypePlugins: Options['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]
]

function markdownHtml(content: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
    >
      {content}
    </ReactMarkdown>
  )
}

/** Mirror of ToolCard's describeAction: the primary "what happened" line. */
function describeAction(args: Record<string, unknown>): string | null {
  if (typeof args.command === 'string' && args.command.length > 0) return args.command
  if (typeof args.path === 'string' && args.path.length > 0) {
    if (typeof args.find === 'string' && typeof args.replace === 'string') {
      return `${args.path}\n- ${clamp(args.find, 80)}\n+ ${clamp(args.replace, 80)}`
    }
    if (typeof args.startLine === 'number' || typeof args.endLine === 'number') {
      return `${args.path}:${args.startLine ?? ''}-${args.endLine ?? ''}`
    }
    return args.path
  }
  if (typeof args.query === 'string' && args.query.length > 0) return args.query
  return null
}

/** One printed tool card, mirroring ToolCard's expanded-by-default content. */
function toolBlock(
  call: ToolCallSegment,
  result: ToolResultSegment | undefined,
  statusLabels: Record<ToolStatus, string>
): string {
  const status: ToolStatus = result?.status ?? 'running'
  const parts: string[] = [
    `<div class="tool-head"><span class="pill ${status}">${escapeHtml(statusLabels[status])}</span>` +
      `<code class="tool-name" dir="ltr">${escapeHtml(call.name)}</code></div>`
  ]
  const action = describeAction(call.args)
  if (action) parts.push(`<pre class="tool-pre">${escapeHtml(clamp(action, ACTION_CLAMP))}</pre>`)
  if (Object.keys(call.args).length > 0) {
    let json: string
    try {
      json = JSON.stringify(call.args, null, 2)
    } catch {
      json = String(call.args)
    }
    parts.push(`<pre class="tool-pre">${escapeHtml(clamp(json, ARGS_CLAMP))}</pre>`)
  }
  // Mirrors ToolCard: on failure the error block carries the message alone.
  if (result?.output && !result.error) {
    parts.push(`<pre class="tool-pre">${escapeHtml(clamp(result.output, OUTPUT_CLAMP))}</pre>`)
  }
  if (result?.error) {
    parts.push(`<pre class="tool-pre error">${escapeHtml(clamp(result.error, OUTPUT_CLAMP))}</pre>`)
  }
  return `<div class="tool">${parts.join('')}</div>`
}

/** One ask_user question (text + details + numbered options) as print HTML. */
function askQuestionParts(raw: Record<string, unknown>, fallbackTitle: string): string[] {
  const question = typeof raw.question === 'string' ? raw.question : fallbackTitle
  const details = typeof raw.details === 'string' ? raw.details : ''
  const options = Array.isArray(raw.options)
    ? raw.options
        .map((o) =>
          typeof o === 'string'
            ? o
            : o && typeof o === 'object'
              ? String((o as Record<string, unknown>).label ?? '')
              : ''
        )
        .filter((label) => label.length > 0)
    : []
  const parts: string[] = [`<div class="ask-q" dir="auto">${escapeHtml(question)}</div>`]
  if (details) parts.push(`<div class="ask-details" dir="auto">${escapeHtml(details)}</div>`)
  if (options.length > 0) {
    parts.push(
      `<ol class="ask-options" dir="auto">${options
        .map((label) => `<li>${escapeHtml(label)}</li>`)
        .join('')}</ol>`
    )
  }
  return parts
}

/** Answered ask_user question(s) — always visible, like the feed's QuestionCard. */
function askBlock(call: ToolCallSegment, result: ToolResultSegment): string {
  // Multi-question form (`questions: [...]`) prints every question in order;
  // the legacy single-question args print exactly as before. The answer
  // section is the tool output, which for multi-question asks is already the
  // per-question summary the user's answers produced.
  const items = Array.isArray(call.args.questions)
    ? call.args.questions.filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
    : []
  const parts: string[] =
    items.length > 0
      ? items.flatMap((q) => askQuestionParts(q, call.name))
      : askQuestionParts(call.args, call.name)
  if (result.output) {
    parts.push(
      `<div class="ask-answer" dir="auto">${escapeHtml(clamp(result.output, OUTPUT_CLAMP))}</div>`
    )
  }
  return `<div class="tool ask">${parts.join('')}</div>`
}

function markdownPart(text: string): string {
  return `<div class="content" dir="auto">${markdownHtml(text)}</div>`
}

/** Static print rendering of a workflow run's final snapshot. */
function workflowBlock(snapshot: WorkflowSnapshot): string {
  const phases =
    snapshot.phases.length > 0
      ? `<div class="wf-phases" dir="auto">${snapshot.phases
          .map((p) => `<span class="wf-phase wf-phase-${p.status}">${escapeHtml(p.title)}</span>`)
          .join('')}</div>`
      : ''
  const rows = snapshot.agents
    .map((a) => {
      const secs = a.endedAt ? Math.max(1, Math.round((a.endedAt - a.startedAt) / 1000)) : 0
      const tokens = a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens
      return `<tr><td>${escapeHtml(a.name)}</td><td dir="ltr">${escapeHtml(`${a.provider}/${a.model}`)}</td><td>${escapeHtml(a.phase ?? '—')}</td><td>${escapeHtml(a.status)}</td><td dir="ltr">${secs ? `${secs}s` : '—'}</td><td dir="ltr">${tokens}</td><td dir="ltr">${a.toolCalls}</td></tr>`
    })
    .join('')
  const table = snapshot.agents.length
    ? `<table class="wf-table"><thead><tr><th>agent</th><th>model</th><th>phase</th><th>status</th><th>time</th><th>tokens</th><th>tools</th></tr></thead><tbody>${rows}</tbody></table>`
    : ''
  return `<div class="tool wf"><div class="tool-head"><span class="tool-name">workflow · ${escapeHtml(snapshot.status)}</span></div>${snapshot.note ? `<div class="wf-note" dir="auto">${escapeHtml(snapshot.note)}</div>` : ''}${phases}${table}</div>`
}

/**
 * Walk one assistant message's segments in feed order and emit its printed
 * parts. Mirrors renderSegments' rules: master text buffers and flushes at
 * tool calls / separators / turn end; LEGACY worker-tagged segments (removed
 * Orchestrator mode) are skipped; workflow snapshots print as a static card;
 * the master's workflow tool calls never print (the card is their surface).
 */
function assistantParts(
  segments: Segment[],
  verbose: boolean,
  statusLabels: Record<ToolStatus, string>
): string[] {
  const resultByToolCall = new Map<string, ToolResultSegment>()
  for (const s of segments) {
    if (s.kind === 'tool_result' && !resultByToolCall.has(s.toolCallId))
      resultByToolCall.set(s.toolCallId, s)
  }

  const parts: string[] = []
  let textBuffer = ''

  const flushText = (): void => {
    if (textBuffer.trim().length > 0) parts.push(markdownPart(textBuffer))
    textBuffer = ''
  }

  for (const seg of segments) {
    if (seg.kind === 'text') {
      if (seg.worker) continue // LEGACY orchestrator-mode segments — never printed
      textBuffer += seg.delta
    } else if (seg.kind === 'workflow') {
      flushText()
      parts.push(workflowBlock(seg.snapshot))
    } else if (seg.kind === 'tool_call') {
      if (seg.worker) continue // LEGACY orchestrator-mode segments — never printed
      flushText()
      if (WORKFLOW_TOOL_NAMES.has(seg.name)) continue
      const result = resultByToolCall.get(seg.toolCallId)
      if (seg.name === ASK_USER_TOOL) {
        // Answered questions always print, matching the always-visible card.
        if (result) parts.push(askBlock(seg, result))
        continue
      }
      // The feed's clean-mode rule: tool cards are verbose-only — successful
      // and failed/denied calls alike drop from the clean feed.
      if (verbose) {
        parts.push(toolBlock(seg, result, statusLabels))
      }
    } else if (seg.kind === 'separator' || seg.kind === 'turn_end') {
      flushText()
    }
    // active_model / compaction segments are transient system chrome — skipped.
  }
  flushText()
  return parts
}

/**
 * True when the conversation prints at least one block under the given
 * verbose preference — the same walk the builder does, so the button's
 * disabled state and the document contents can never disagree.
 */
export function hasExportableContent(messages: ChatMessage[], verbose: boolean): boolean {
  const noLabels: Record<ToolStatus, string> = { running: '', success: '', failed: '', denied: '' }
  return messages.some((m) =>
    m.role === 'user'
      ? m.content.trim().length > 0 || (m.attachments?.length ?? 0) > 0
      : assistantParts(m.segments, verbose, noLabels).length > 0
  )
}

const STYLE = `
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0;
    font: 13px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #1f2430;
  }
  header { border-bottom: 1px solid #e2e5ea; padding-bottom: 10px; margin-bottom: 18px; }
  header h1 { margin: 0 0 3px; font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
  header .meta { font-size: 10.5px; color: #7a8190; }
  .msg { margin-bottom: 16px; }
  .role {
    font-size: 9.5px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase;
    color: #7a8190; margin-bottom: 4px;
    break-after: avoid;
  }
  .content { overflow-wrap: anywhere; margin-bottom: 8px; }
  .msg > :last-child { margin-bottom: 0; }
  .content > :first-child { margin-top: 0; }
  .content > :last-child { margin-bottom: 0; }
  .user .content {
    background: #f4f5f7; border-radius: 8px; padding: 8px 12px;
    box-decoration-break: clone; -webkit-box-decoration-break: clone;
  }
  .attachments { margin-top: 5px; font-size: 10.5px; color: #7a8190; overflow-wrap: anywhere; }

  /* Tool cards — print mirror of the feed's ToolCard. */
  .tool {
    border: 1px solid #e2e5ea; border-radius: 8px; padding: 8px 11px; margin-bottom: 8px;
    box-decoration-break: clone; -webkit-box-decoration-break: clone;
  }
  .tool-head { break-after: avoid; }
  .pill {
    display: inline-block; border-radius: 999px; padding: 1px 8px;
    font-size: 9.5px; font-weight: 600; margin-inline-end: 7px; vertical-align: 1px;
  }
  .pill.success { background: #ecfdf5; color: #047857; }
  .pill.failed { background: #fef2f2; color: #b91c1c; }
  .pill.denied { background: #f3f4f6; color: #6b7280; }
  .pill.running { background: #eff6ff; color: #1d4ed8; }
  .tool-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; font-weight: 600; background: none; padding: 0; }
  .tool-pre { background: #f9fafb; border: 1px solid #eceef2; margin: 6px 0 0; padding: 6px 9px; font-size: 10px; }
  .tool-pre.error { background: #fef2f2; border-color: #fecaca; color: #991b1b; }

  /* Answered ask_user questions. */
  .ask-q { font-weight: 600; }
  /* Breathing room between stacked questions of one multi-question ask. */
  .ask-details + .ask-q, .ask-options + .ask-q { margin-top: 8px; }
  .ask-details { margin-top: 3px; color: #5b6270; font-size: 12px; }
  .ask-options { margin: 5px 0 0; padding-inline-start: 22px; font-size: 12px; }
  .ask-answer { margin-top: 6px; padding-top: 6px; border-top: 1px solid #eceef2; color: #5b6270; font-size: 11px; }

  /* Workflow card — static print of the run's final snapshot. */
  .wf-note { margin-top: 5px; font-size: 11px; color: #5b6270; }
  .wf-phases { margin-top: 6px; }
  .wf-phase {
    display: inline-block; border: 1px solid #e2e5ea; border-radius: 999px;
    padding: 1px 8px; font-size: 9.5px; font-weight: 600; margin-inline-end: 5px;
  }
  .wf-phase-done { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
  .wf-phase-active { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
  .wf-table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 10px; }
  .wf-table th, .wf-table td {
    border-bottom: 1px solid #eceef2; padding: 3px 6px; text-align: start;
  }
  .wf-table th { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #7a8190; }

  /* Pagination: fill pages, break politely. */
  p, li { orphans: 3; widows: 3; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  tr, img { break-inside: avoid; }

  p { margin: 7px 0; }
  h1 { font-size: 15px; margin: 14px 0 6px; }
  h2 { font-size: 14px; margin: 13px 0 6px; }
  h3, h4, h5, h6 { font-size: 13px; margin: 12px 0 5px; }
  ul, ol { margin: 7px 0; padding-inline-start: 22px; }
  li { margin: 2px 0; }
  a { color: #2757c4; text-decoration: underline; }
  details {
    border: 1px solid #e2e5ea; border-radius: 8px; padding: 6px 10px; margin: 7px 0;
    box-decoration-break: clone; -webkit-box-decoration-break: clone;
  }
  summary { font-weight: 600; }
  blockquote {
    margin: 7px 0; padding-inline-start: 10px;
    border-inline-start: 2px solid #d3d7de; color: #5b6270;
  }
  hr { border: 0; border-top: 1px solid #e2e5ea; margin: 12px 0; }
  img { max-width: 100%; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.88em; background: #f0f1f4; border-radius: 3px; padding: 0.5px 4px;
  }
  pre {
    margin: 8px 0; padding: 9px 11px;
    background: #f6f7f9; border: 1px solid #e2e5ea; border-radius: 6px;
    box-decoration-break: clone; -webkit-box-decoration-break: clone;
    white-space: pre-wrap; overflow-wrap: anywhere;
    direction: ltr; text-align: left;
    font-size: 11px; line-height: 1.5;
  }
  pre code { background: none; padding: 0; font-size: inherit; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
  thead { display: table-header-group; }
  th, td { border: 1px solid #d3d7de; padding: 4px 8px; text-align: start; vertical-align: top; }
  th { background: #f4f5f7; font-weight: 600; }
`

export function buildChatPdfHtml(options: ChatPdfOptions): string {
  const sections: string[] = []
  for (const message of options.messages) {
    if (message.role === 'user') {
      const text = message.content.trim()
      const atts = message.attachments ?? []
      if (text.length === 0 && atts.length === 0) continue
      const body = text.length > 0 ? markdownPart(text) : ''
      const attachments =
        atts.length > 0
          ? `<div class="attachments">${escapeHtml(atts.map((a) => a.originalName).join(' · '))}</div>`
          : ''
      sections.push(
        `<section class="msg user"><div class="role">${escapeHtml(options.userLabel)}</div>` +
          body +
          attachments +
          `</section>`
      )
      continue
    }
    const parts = assistantParts(message.segments, options.verbose, options.toolStatusLabels)
    if (parts.length === 0) continue
    sections.push(
      `<section class="msg assistant"><div class="role">${escapeHtml(options.assistantLabel)}</div>` +
        parts.join('') +
        `</section>`
    )
  }

  return (
    `<!doctype html><html lang="${escapeHtml(options.locale)}" dir="${options.rtl ? 'rtl' : 'ltr'}">` +
    `<head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title><style>${STYLE}</style></head>` +
    `<body><header><h1 dir="auto">${escapeHtml(options.title)}</h1>` +
    `<div class="meta">${escapeHtml(options.exportedAt)}</div></header>` +
    `<main>${sections.join('')}</main></body></html>`
  )
}
