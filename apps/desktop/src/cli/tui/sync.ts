/**
 * Frames in, actions out.
 *
 * Every socket frame lands in a queue that flushes once per animation frame
 * inside one Solid batch — the first frame after quiet flushes immediately,
 * so a token stream costs at most one render per 16 ms and never adds
 * latency. Actions are the verbs the screens call: send, cancel, approve,
 * answer, open, queue.
 */
import { authGate } from '../lib/auth.mjs'
import { batch } from 'solid-js'
import { produce } from 'solid-js/store'
import type { DaemonClient, EventFrame, TurnFrame } from '../lib/client'
import {
  AUTH_STATUSES,
  type AuthInfo,
  applySegment,
  endAssistant,
  ensureAssistant,
  loadConversation,
  mintId,
  patchAssistant,
  type AskQuestion,
  type ChatMode,
  type PendingCard,
  type Segment,
  type Store,
  type StoredMessage,
  type ThinkingMode
} from './store'

export type SendOptions = {
  attachmentPaths?: string[]
  planMode?: boolean
}

/** What the emailed-code handlers answer. */
export type AuthResult = { ok: boolean; code?: string; detail?: string | null }

export type Actions = {
  bootstrap: () => Promise<void>
  /* the account — thin drivers over the daemon's auth:* handlers */
  authRefresh: () => Promise<AuthInfo>
  authLogin: (email: string, password: string) => Promise<AuthInfo>
  authChangePassword: (newPassword: string) => Promise<AuthInfo>
  authSetPin: (pin: string) => Promise<AuthInfo>
  authUnlock: (pin: string) => Promise<AuthInfo>
  authLock: () => Promise<AuthInfo>
  authSignOut: () => Promise<AuthInfo>
  authChangePin: (currentPin: string, nextPin: string) => Promise<AuthInfo>
  authChangePasswordSelf: (currentPassword: string, newPassword: string) => Promise<AuthInfo>
  authResetRequest: (email: string) => Promise<AuthResult>
  authResetConfirm: (email: string, code: string, newPassword: string) => Promise<AuthResult>
  authActivateRequest: (email: string) => Promise<AuthResult>
  authActivateConfirm: (email: string, code: string, newPassword: string) => Promise<AuthResult>
  refreshSnapshot: () => Promise<void>
  openConversation: (id: string | null) => Promise<void>
  newConversation: () => void
  send: (text: string, options?: SendOptions) => Promise<void>
  flushQueue: () => Promise<void>
  cancel: () => Promise<void>
  respondApproval: (id: string, decision: 'approved' | 'denied', always?: boolean) => Promise<void>
  respondAsk: (id: string, response: unknown) => Promise<void>
  setThinking: (mode: ThinkingMode, persist: boolean) => Promise<void>
  setChatMode: (mode: ChatMode) => Promise<void>
  setPlanMode: (on: boolean) => Promise<void>
  setProject: (id: string | null, title: string | null) => void
  setVerbose: (on: boolean) => Promise<void>
  setBrain: (provider: string, model: string) => Promise<void>
  loadPending: () => Promise<void>
  answerParked: (card: PendingCard) => void
  dropQueued: (id: string) => void
  compact: () => Promise<void>
  dispose: () => void
}

type Deps = {
  client: DaemonClient
  store: Store
  notify: (message: string, variant?: 'info' | 'success' | 'warning' | 'error') => void
}

const alwaysApproved = new Set<string>()

export function createActions({ client, store, notify }: Deps): Actions {
  const [get, set] = store

  /* ───────────── frame queue ───────────── */
  type Queued = { kind: 'turn'; frame: TurnFrame } | { kind: 'event'; frame: EventFrame }
  let queue: Queued[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFlush = 0

  const flush = () => {
    timer = null
    lastFlush = Date.now()
    const items = queue
    queue = []
    batch(() => {
      for (const item of items) {
        try {
          if (item.kind === 'turn') applyTurn(item.frame)
          else applyEvent(item.frame)
        } catch (error) {
          notify(`frame error: ${(error as Error).message}`, 'error')
        }
      }
    })
  }
  const push = (item: Queued) => {
    queue.push(item)
    if (timer) return
    if (Date.now() - lastFlush >= 16) flush()
    else timer = setTimeout(flush, 16)
  }

  /* ───────────── turn frames ───────────── */
  /**
   * Frames that arrive while our own send is still in flight (turnId not yet
   * known). This socket carries every conversation's turns — a Telegram
   * reply, another terminal — so nothing is rendered until the turn id is
   * known; then the buffer is replayed and filtered.
   */
  let preSend: TurnFrame[] | null = null

  const applyTurn = (frame: TurnFrame) => {
    const turnId = typeof frame.turnId === 'string' ? frame.turnId : null
    const conversationId = typeof frame.conversationId === 'string' ? frame.conversationId : null
    if (preSend) {
      preSend.push(frame)
      return
    }
    // Only our own turn renders. With no turn of our own in flight, a frame
    // for the open conversation means a run started elsewhere (the app, a
    // channel) on the same transcript: adopt it. Anything else is ignored.
    if (get.turnId) {
      if (turnId !== get.turnId) return
    } else {
      if (!conversationId || conversationId !== get.conversationId) return
    }

    switch (frame.t) {
      case 'segment':
        if (!get.working) {
          // A turn this client did not start (a resumed run): adopt it.
          set({ working: true, turnId, sendAt: get.sendAt ?? Date.now() })
        }
        applySegment(store, frame.segment as Segment, { live: true })
        return
      case 'turnEvent': {
        const type = String(frame.type)
        const payload = (frame.payload ?? {}) as Record<string, unknown>
        if (type === 'context.built') {
          set('meter', {
            tokens: Number(payload.tokenCount ?? 0),
            budget: Number(payload.tokenBudget ?? get.meter.budget),
            compactionAt:
              typeof payload.compactionAt === 'number'
                ? payload.compactionAt
                : get.meter.compactionAt,
            model: get.brain.model
          })
        } else if (type === 'turn.usage') {
          if (payload.role === 'brain') {
            set('turnUsage', {
              input: Number(payload.inputTokens ?? 0),
              output: Number(payload.outputTokens ?? 0),
              cacheRead: Number(payload.cacheReadTokens ?? 0),
              cacheWrite: Number(payload.cacheCreationTokens ?? 0)
            })
          }
          set('cost', (c) => c + Number(payload.cost ?? 0))
        } else if (type === 'llm.retry') {
          set('activity', `Retrying (attempt ${Number(payload.attempt ?? 1)})`)
        } else if (type === 'llm.fallback') {
          notify(`fell back from ${String(payload.from)} to ${String(payload.to)}`, 'warning')
        } else if (type === 'safety.blocked') {
          notify(`blocked: ${String(payload.tool)} — ${String(payload.reason ?? '')}`, 'warning')
        } else if (type === 'compaction.applied') {
          notify(`compacted: ${Number(payload.tokensSaved ?? 0)} tokens reclaimed`, 'info')
        }
        return
      }
      case 'approvalRequest': {
        const tool = String(frame.tool ?? '')
        if (alwaysApproved.has(tool)) {
          void client.invoke('cli:approvalRespond', { id: frame.id, decision: 'approved' })
          return
        }
        set('card', {
          kind: 'approval',
          id: String(frame.id),
          turnId: turnId ?? '',
          tool,
          args: (frame.args as Record<string, unknown>) ?? {},
          reason: String(frame.reason ?? ''),
          level: String(frame.level ?? ''),
          description: frame.description
        })
        set('activity', `waiting for approval: ${tool}`)
        return
      }
      case 'askRequest': {
        set('card', {
          kind: 'ask',
          id: String(frame.id),
          turnId: turnId ?? '',
          questions: (Array.isArray(frame.questions) ? frame.questions : []) as AskQuestion[]
        })
        set('activity', 'waiting for your answer')
        return
      }
      case 'credentialBlocked':
        notify(`message discarded — it looked like a ${String(frame.type)}`, 'warning')
        return
      case 'done':
        finishTurn()
        return
      case 'error':
        finishTurn(String(frame.error ?? 'the turn failed'))
        return
      default:
        return
    }
  }

  const finishTurn = (error?: string) => {
    endAssistant(store, error)
    const started = get.sendAt
    set({ working: false, activity: null, card: null, turnId: null, sendAt: null })
    if (error) set('lastError', error)
    if (started && get.turnUsage) {
      set('lastTurn', {
        durationMs: Date.now() - started,
        input: get.turnUsage.input,
        output: get.turnUsage.output,
        cost: get.cost
      })
    }
    void refreshStats()
    void flushQueue()
  }

  /* ───────────── app-wide events ───────────── */
  const applyEvent = (frame: EventFrame) => {
    const payload = (frame.payload ?? {}) as Record<string, unknown>
    switch (frame.channel) {
      case 'chat:turnState': {
        const id = String(payload.conversationId ?? '')
        const state = String(payload.state ?? payload.status ?? '')
        if (!id) return
        set(
          'runs',
          produce((runs) => {
            const i = runs.findIndex((r) => r.conversationId === id)
            const running = state === 'started' || state === 'running' || state === 'streaming'
            if (running) {
              const entry = {
                conversationId: id,
                channel: typeof payload.channel === 'string' ? payload.channel : undefined,
                title: typeof payload.title === 'string' ? payload.title : undefined,
                state
              }
              if (i >= 0) runs[i] = entry
              else runs.push(entry)
            } else if (i >= 0) runs.splice(i, 1)
          })
        )
        // A run ending on the open conversation refreshes its title/stats.
        if (id === get.conversationId && !(state === 'started')) void refreshTitle()
        return
      }
      case 'cli:configChange':
        if (typeof payload.verbose === 'boolean') set('verbose', payload.verbose)
        return
      // The session moved — signed in or out from the window, locked from the
      // profile card, revoked by the org. Same redacted state the window gets.
      case 'auth:changed':
        applyAuth(payload)
        return
      case 'preferences:changed': {
        const tm = payload.thinkingMode as { model?: string; mode?: string } | undefined
        if (tm && tm.model === get.brain.model && typeof tm.mode === 'string')
          set('thinking', tm.mode as ThinkingMode)
        return
      }
      case 'provider:updated':
        void refreshSnapshot()
        return
      case 'chat:planMode':
        if (
          payload.conversationId === get.conversationId &&
          typeof payload.planMode === 'boolean'
        ) {
          set('planMode', payload.planMode)
        }
        return
      case 'conversation:changed':
        if (!get.working) void refreshTitle()
        return
      case 'telegram:statusChange':
      case 'whatsapp:statusChange':
      case 'mobile:statusChange':
        void refreshStatus()
        return
      default:
        return
    }
  }

  /* ───────────── the account ───────────── */
  const toAuth = (raw: any): AuthInfo => ({
    status: AUTH_STATUSES.has(raw?.status) ? raw.status : 'loggedOut',
    email: raw?.user?.email ?? null,
    name: raw?.user?.name ?? null,
    role: raw?.user?.role ?? null,
    org: raw?.orgName ?? null,
    attemptsLeft: typeof raw?.pinAttemptsLeft === 'number' ? raw.pinAttemptsLeft : null,
    lastError: raw?.lastError ?? null,
    lastErrorDetail: raw?.lastErrorDetail ?? null
  })
  const applyAuth = (raw: unknown): AuthInfo => {
    const info = toAuth(raw)
    set('auth', info)
    return info
  }
  const authCall = (channel: string, ...args: unknown[]): Promise<AuthInfo> =>
    client.invoke<unknown>(channel, ...args).then(applyAuth)
  const authRefresh = () =>
    client
      .invoke<unknown>('auth:getState')
      .then(applyAuth)
      .catch(() => get.auth)
  const codeCall = (channel: string, ...args: unknown[]): Promise<AuthResult> =>
    client
      .invoke<AuthResult>(channel, ...args)
      .then((r) => (r && typeof r === 'object' ? r : { ok: false, code: 'generic' }))
      .catch((e) => ({ ok: false, code: 'generic', detail: String(e) }))

  /* ───────────── loaders ───────────── */
  const refreshSnapshot = async () => {
    try {
      const snapshot = (await client.invoke<Record<string, any>>('cli:snapshot')) ?? {}
      const llm = snapshot.llm ?? {}
      const cli = snapshot.channels?.cli ?? {}
      const provider = llm.brainProvider || null
      const model = llm.brainModel || null
      set({
        brain: { provider, model },
        chatMode: llm.chatMode === 'workflow' ? 'workflow' : 'single',
        localOnly: llm.localOnly === true,
        verbose: cli.verbose === true
      })
      if (provider && model) {
        const modes = await client
          .invoke<{
            modes: string[]
            current: string
          }>('runtime:reasoningModes', { provider, model })
          .catch(() => null)
        if (modes) {
          set('thinkingModes', modes.modes as ThinkingMode[])
          set('thinking', (modes.current || 'off') as ThinkingMode)
        }
      } else {
        set('thinkingModes', [])
      }
      const caps = await client
        .invoke<{ contextWindow: number; compactionAt: number }>('model:capabilities')
        .catch(() => null)
      if (caps?.contextWindow) {
        set('contextWindow', caps.contextWindow)
        if (!get.meter.budget)
          set('meter', {
            ...get.meter,
            budget: caps.contextWindow,
            compactionAt: caps.compactionAt ?? null
          })
      }
    } catch (error) {
      notify(`could not read settings: ${(error as Error).message}`, 'error')
    }
  }

  const refreshStatus = async () => {
    const status = await client
      .invoke<Record<string, any>>('cli:status', process.env.PATH ?? null)
      .catch(() => null)
    if (!status) return
    set({
      version: status.version ?? get.version,
      daemonPid: status.cli?.pid ?? null,
      headless: status.headless === true,
      channels: Array.isArray(status.channels) ? status.channels : [],
      runs: Array.isArray(status.activeRuns)
        ? status.activeRuns
            .filter((r: any) => r.conversationId)
            .map((r: any) => ({
              conversationId: r.conversationId,
              channel: r.channel,
              title: r.title,
              state: 'running'
            }))
        : get.runs
    })
  }

  const refreshTitle = async () => {
    if (!get.conversationId) return
    const conv = await client
      .invoke<Record<string, any>>('conversation:load', get.conversationId)
      .catch(() => null)
    if (!conv) return
    if (typeof conv.title === 'string') set('title', conv.title)
    applyStats(conv)
  }

  const applyStats = (conv: Record<string, any>) => {
    const meter = conv.stats?.meter ?? conv.contextMeter ?? null
    if (meter?.contextTokens !== undefined) {
      set('meter', {
        tokens: Number(meter.contextTokens ?? 0),
        budget: Number(meter.contextBudget ?? get.contextWindow ?? 0),
        compactionAt:
          typeof meter.compactionAt === 'number' ? meter.compactionAt : get.meter.compactionAt,
        model: meter.model ?? get.brain.model
      })
    }
    const all = conv.stats?.allTime
    if (all) {
      set('allTime', {
        cost: Number(all.cost ?? 0),
        turns: Number(all.turns ?? 0),
        inputTokens: Number(all.inputTokens ?? 0),
        outputTokens: Number(all.outputTokens ?? 0)
      })
      set('cost', Number(all.cost ?? 0))
    }
    const last = conv.stats?.lastTurn
    if (last) {
      set('lastTurn', {
        durationMs: Number(last.processingMs ?? last.durationMs ?? 0),
        input: Number(last.inputTokens ?? 0),
        output: Number(last.outputTokens ?? 0),
        cost: Number(last.cost ?? 0)
      })
    }
  }

  const refreshStats = async () => {
    if (!get.conversationId) return
    const conv = await client
      .invoke<Record<string, any>>('conversation:load', get.conversationId)
      .catch(() => null)
    if (conv) {
      if (typeof conv.title === 'string') set('title', conv.title)
      applyStats(conv)
    }
  }

  const openConversation = async (id: string | null) => {
    if (!id) {
      newConversation()
      return
    }
    const conv = await client.invoke<Record<string, any>>('conversation:load', id).catch(() => null)
    if (!conv) {
      notify('could not load that conversation', 'error')
      return
    }
    batch(() => {
      set({
        conversationId: id,
        title: typeof conv.title === 'string' ? conv.title : null,
        working: false,
        turnId: null,
        sendAt: null,
        activity: null,
        card: null,
        queue: [],
        cost: 0,
        turnUsage: null,
        lastTurn: null,
        allTime: null,
        meter: {
          tokens: 0,
          budget: get.contextWindow ?? 0,
          compactionAt: null,
          model: get.brain.model
        },
        projectId: typeof conv.projectId === 'string' ? conv.projectId : null,
        lastError: null
      })
      loadConversation(store, (conv.messages ?? []) as StoredMessage[])
      applyStats(conv)
    })
    const plan = await client.invoke<boolean>('chat:planModeGet', id).catch(() => false)
    set('planMode', plan === true)
    if (get.projectId) {
      const projects = await client
        .invoke<Array<{ id: string; title: string }>>('projects:list')
        .catch(() => [])
      set('projectTitle', projects.find((p) => p.id === get.projectId)?.title ?? null)
    } else set('projectTitle', null)
    // If a turn is running on this conversation elsewhere, adopt its state.
    if (get.runs.some((r) => r.conversationId === id)) set({ working: true, sendAt: Date.now() })
  }

  const newConversation = () => {
    batch(() => {
      set({
        conversationId: null,
        title: null,
        feed: [],
        files: [],
        stagedAttachments: [],
        queue: [],
        working: false,
        turnId: null,
        sendAt: null,
        activity: null,
        card: null,
        cost: 0,
        turnUsage: null,
        lastTurn: null,
        allTime: null,
        planMode: false,
        meter: {
          tokens: 0,
          budget: get.contextWindow ?? 0,
          compactionAt: null,
          model: get.brain.model
        },
        lastError: null
      })
    })
  }

  /* ───────────── verbs ───────────── */
  const send = async (text: string, options: SendOptions = {}) => {
    const trimmed = text.trim()
    const attachments = options.attachmentPaths ?? get.stagedAttachments
    if (!trimmed && attachments.length === 0) return
    // Signed out, locked, or half signed-in: the daemon would refuse anyway
    // (cli:send carries the same gate); refusing here keeps the draft.
    const gate = authGate(get.auth, (verb: string) => `/${verb}`)
    if (gate) {
      notify(gate, 'warning')
      set('restoreDraft', text)
      return
    }
    if (get.working || get.card) {
      set('queue', (q) => [...q, { id: mintId('q'), text: trimmed, attachments }])
      set('stagedAttachments', [])
      return
    }
    batch(() => {
      set('feed', (feed) => [
        ...feed,
        {
          kind: 'user',
          id: mintId('u'),
          text: trimmed,
          attachments: attachments.map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, path: p })),
          timestamp: Date.now()
        }
      ])
      set({
        working: true,
        sendAt: Date.now(),
        activity: 'Thinking',
        turnUsage: null,
        stagedAttachments: [],
        lastError: null
      })
      ensureAssistant(set, get, null)
    })
    preSend = []
    try {
      const started = await client.invoke<{ turnId: string; conversationId: string }>('cli:send', {
        text: trimmed,
        conversationId: get.conversationId,
        attachmentPaths: attachments,
        projectId: get.projectId,
        thinkingMode: get.thinking,
        planMode: options.planMode ?? get.planMode
      })
      batch(() => {
        set('turnId', started.turnId)
        set('conversationId', started.conversationId)
        const index = get.feed.length - 1
        const last = get.feed[index]
        if (last && last.kind === 'assistant' && !last.turnId)
          patchAssistant(set, index, { turnId: started.turnId })
      })
      if (get.planMode && get.conversationId) {
        void client
          .invoke('chat:planModeSet', { conversationId: get.conversationId, planMode: true })
          .catch(() => undefined)
      }
      const buffered = preSend ?? []
      preSend = null
      batch(() => {
        for (const frame of buffered) applyTurn(frame)
      })
    } catch (error) {
      preSend = null
      // The send never reached the daemon: drop the empty assistant shell
      // rather than sealing it, and say why.
      let index = get.feed.length - 1
      const last = get.feed[index]
      if (last && last.kind === 'assistant' && last.parts.length === 0) {
        set('feed', (feed) => feed.slice(0, index))
        index -= 1
      }
      const user = get.feed[index]
      if (user && user.kind === 'user' && user.text === trimmed) {
        set('feed', (feed) => feed.slice(0, index))
        set('restoreDraft', trimmed)
        if (attachments.length > 0) set('stagedAttachments', attachments)
      }
      set({ working: false, activity: null, turnId: null, sendAt: null })
      notify(
        (error as Error).message === 'not connected'
          ? 'not connected to the daemon — reconnecting'
          : (error as Error).message,
        'error'
      )
    }
  }

  const flushQueue = async () => {
    if (get.working || get.card || get.queue.length === 0) return
    const [next, ...rest] = get.queue
    set('queue', rest)
    await send(next.text, { attachmentPaths: next.attachments })
  }

  const cancel = async () => {
    if (!get.working && !get.card) return
    set('activity', 'stopping')
    await client.invoke('cli:cancel', get.conversationId).catch(() => undefined)
  }

  const respondApproval = async (id: string, decision: 'approved' | 'denied', always = false) => {
    const card = get.card
    if (always && card?.kind === 'approval') alwaysApproved.add(card.tool)
    set('card', null)
    set('parked', (p) => p.filter((c) => c.id !== id))
    set('activity', 'Thinking')
    await client
      .invoke('cli:approvalRespond', { id, decision })
      .catch((e) => notify(String(e), 'error'))
  }

  const respondAsk = async (id: string, response: unknown) => {
    set('card', null)
    set('parked', (p) => p.filter((c) => c.id !== id))
    set('activity', 'Thinking')
    await client.invoke('cli:askRespond', { id, response }).catch((e) => notify(String(e), 'error'))
  }

  const setThinking = async (mode: ThinkingMode, persist: boolean) => {
    set('thinking', mode)
    if (persist && get.brain.model) {
      await client
        .invoke('runtime:setThinkingMode', get.brain.model, mode)
        .catch((e) => notify(String(e), 'error'))
    }
  }

  const setChatMode = async (mode: ChatMode) => {
    set('chatMode', mode)
    await client.invoke('cli:setSetting', { id: 'model.mode', value: mode }).catch(async () => {
      await client.invoke('provider:setMode', mode).catch((e) => notify(String(e), 'error'))
    })
  }

  const setPlanMode = async (on: boolean) => {
    set('planMode', on)
    if (get.conversationId) {
      await client
        .invoke('chat:planModeSet', { conversationId: get.conversationId, planMode: on })
        .catch(() => undefined)
    }
  }

  const setProject = (id: string | null, title: string | null) =>
    set({ projectId: id, projectTitle: title })

  const setVerbose = async (on: boolean) => {
    set('verbose', on)
    await client.invoke('cli:setConfig', { verbose: on }).catch(() => undefined)
  }

  // One lane in the cloud fork: `model:select` persists the pick and updates
  // the live runtime, exactly as the app's composer picker does. `provider`
  // is kept for the action's shape (it is always `cloud` here).
  const setBrain = async (_provider: string, model: string) => {
    await client.invoke('model:select', model)
    await refreshSnapshot()
  }

  const loadPending = async () => {
    const rows = await client
      .invoke<
        Array<{ kind: 'approval' | 'ask'; frame: Record<string, any> }>
      >('cli:pendingRequests')
      .catch(() => [])
    const parked: PendingCard[] = rows.map((row) =>
      row.kind === 'ask'
        ? {
            kind: 'ask',
            id: String(row.frame.id),
            turnId: String(row.frame.turnId ?? ''),
            questions: (row.frame.questions ?? []) as AskQuestion[],
            parked: true
          }
        : {
            kind: 'approval',
            id: String(row.frame.id),
            turnId: String(row.frame.turnId ?? ''),
            tool: String(row.frame.tool ?? ''),
            args: row.frame.args ?? {},
            reason: String(row.frame.reason ?? ''),
            level: String(row.frame.level ?? ''),
            parked: true
          }
    )
    set('parked', parked)
    if (parked.length > 0)
      notify(
        `${parked.length} approval${parked.length === 1 ? '' : 's'} waiting — /pending`,
        'warning'
      )
  }

  const answerParked = (card: PendingCard) => set('card', card)

  const dropQueued = (id: string) => set('queue', (q) => q.filter((x) => x.id !== id))

  const compact = async () => {
    if (!get.conversationId) {
      notify('nothing to compact yet', 'info')
      return
    }
    await send('/compact', {})
  }

  /* ───────────── bootstrap ───────────── */
  const offTurn = client.onTurn((frame) => push({ kind: 'turn', frame }))
  const offEvent = client.onEvent((frame) => push({ kind: 'event', frame }))
  const offState = client.onState((state) => {
    set('connection', state)
    if (state === 'connected' && get.version) {
      // Reconnected: re-hydrate whatever was open.
      notify('reconnected to the daemon', 'success')
      void (async () => {
        await refreshSnapshot()
        await refreshStatus()
        if (get.conversationId) await openConversation(get.conversationId)
      })()
    }
  })

  const bootstrap = async () => {
    set('connection', client.state)
    set('version', client.hello?.version ?? null)
    await Promise.all([authRefresh(), refreshSnapshot(), refreshStatus(), loadPending()])
  }

  const dispose = () => {
    offTurn()
    offEvent()
    offState()
    if (timer) clearTimeout(timer)
  }

  return {
    bootstrap,
    authRefresh,
    authLogin: (email, password) => authCall('auth:login', email, password),
    authChangePassword: (newPassword) => authCall('auth:changePassword', newPassword),
    authSetPin: (pin) => authCall('auth:setPin', pin),
    authUnlock: (pin) => authCall('auth:unlock', pin),
    authLock: () => authCall('auth:lock'),
    authSignOut: () => authCall('auth:signOut'),
    authChangePin: (currentPin, nextPin) => authCall('auth:changePin', currentPin, nextPin),
    authChangePasswordSelf: (currentPassword, newPassword) =>
      authCall('auth:passwordChangeSelf', currentPassword, newPassword),
    authResetRequest: (email) => codeCall('auth:resetRequest', email),
    authResetConfirm: (email, code, newPassword) =>
      codeCall('auth:resetConfirm', email, code, newPassword),
    authActivateRequest: (email) => codeCall('auth:activateRequest', email),
    authActivateConfirm: (email, code, newPassword) =>
      codeCall('auth:activateConfirm', email, code, newPassword),
    refreshSnapshot,
    openConversation,
    newConversation,
    send,
    flushQueue,
    cancel,
    respondApproval,
    respondAsk,
    setThinking,
    setChatMode,
    setPlanMode,
    setProject,
    setVerbose,
    setBrain,
    loadPending,
    answerParked,
    dropQueued,
    compact,
    dispose
  }
}
