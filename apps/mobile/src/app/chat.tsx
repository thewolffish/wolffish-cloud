import { AssistantMessageView, UserBubble } from '@/components/chat/MessageBubbles'
import { SelectTextHost } from '@/components/chat/SelectTextSheet'
import { ChatFeed, FEED_FADE_MS, type ChatFeedHandle } from '@/components/chat/ChatFeed'
import { ChatSkeleton } from '@/components/chat/ChatSkeleton'
import { Composer, type ComposerSubmit } from '@/components/chat/Composer'
import { ConversationsSheet } from '@/components/chat/ConversationsSheet'
import { FLOATING_AREA, FLOATING_GAP, FloatingChrome } from '@/components/chat/FloatingChrome'
import type { QueuedPrompt } from '@/components/chat/QueuedPrompts'
import { buildFeed, LIVE_KEY } from '@/lib/conversations/feed'
import { failedTurnEnd } from '@/lib/conversations/segments'
import { useConversation } from '@/lib/conversations/hooks'
import { mintMessageId, type ConversationMessage } from '@/lib/conversations/types'
import { deriveTitle, ensureDemoConversation, sendDemoPrompt, stopDemoTurn } from '@/lib/demo/agent'
import { discardStagedFile, importLocalFile, stageOutgoingFile } from '@/lib/files/fileCache'
import type { PickedFile } from '@/lib/files/pickAttachments'
import { DEFAULT_PROJECT_ICON } from '@/components/workspace/ProjectDialog'
import { PromptPreview } from '@/components/workspace/PromptSheet'
import { useChatRuntime } from '@/state/chatRuntime'
import { useConfigValue } from '@/state/demoConfig'
import { Image } from 'expo-image'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { clearConversationBadges, setActiveConversation } from '@/lib/notifications/push'
import { useActiveProject } from '@/lib/sync/projects'
import { abortTurn, beginTurn, sendPrompt } from '@/lib/sync/prompt'
import {
  discardStaged,
  fileLocally,
  stageForSend,
  stagedAttachment,
  uploadForSend
} from '@/lib/sync/attachments'
import { uploadFileToDesktop } from '@/lib/sync/files'
import { tunnelClient } from '@/lib/tunnel/client'
import { useToast } from '@/providers/toast/useToast'
import { useAppStore } from '@/state/appStore'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppState, KeyboardAvoidingView, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The chat screen — the desktop Chat page adapted to one column, and the only
 * screen the app really has: a bottom-pinned feed under two floating controls
 * (the conversations sheet, a new chat), and a composer with send/stop/record.
 * Works identically for a fresh chat and for any conversation the sheet opens.
 *
 * There is no top bar. The sheet is the navigator — every core page and every
 * conversation — and it opens a conversation IN PLACE rather than pushing a
 * copy of this screen per row tapped. That is the desktop's model (one window,
 * many conversations, turns running concurrently in whichever) and it is what
 * `opened` and `generationRef` below exist to make safe.
 *
 * The feed is a plain ScrollView, deliberately:
 * - inverted FlatList: Fabric text measurement explodes on RTL-heavy rows
 *   (real Arabic conversations blanked the whole feed);
 * - non-inverted FlatList: scrollToEnd targets the ESTIMATED content end,
 *   which never converges with a few huge rows, so opening at the bottom
 *   is unreliable.
 * Conversations are small (median 2, max 30 messages in three months of
 * real data), so full rendering is cheap and bottom-pinning deterministic.
 * Everything about WHERE that ScrollView sits lives in ChatFeed.
 *
 * The screen has four display states and exactly one transition between any
 * two of them, because the alternative — letting each state appear as soon as
 * its data happens to arrive — is what made opening a conversation flash the
 * hero, then the top of the transcript, then snap to the end:
 *
 *   new chat        no id, nothing to load          → hero, immediately
 *   opening         id, transcript not laid out yet → skeleton
 *   open            transcript pinned to its end    → feed, faded in
 *   empty           id, but genuinely no messages   → hero
 *
 * The skeleton covers the whole "opening" window — reading SQLite, downloading
 * the body over the tunnel, laying the messages out, pinning to the end — so
 * the transcript is never seen anywhere but at its final position.
 *
 * SENDING adds a fifth state that none of those four can express, and getting
 * it wrong is what made a prompt sent from here disappear into nothing: a new
 * chat has no conversation to load, so it is neither "opening" (no skeleton)
 * nor "empty" (the hero is gone the moment the user sends) for the whole round
 * trip in which the desktop mints one. The prompt is therefore rendered from
 * local state for exactly that window — `pendingUser` — and handed to the live
 * turn the moment there is an id to file it under. Neither the hero nor a bare
 * feed is ever shown while a turn is in flight.
 *
 * SENDING MID-TURN is the desktop's queue, ported whole: a submit that arrives
 * while a turn is running is not refused and does not enter the feed — it waits
 * in a cancelable row above the composer and is sent, through this very same
 * path, when the turn ends. See `queued` below.
 */

/** Identity for a queued row. Local and disposable — the queue never leaves
 *  this screen, so these ids never have to agree with anything. */
let queueSequence = 0

export default function ChatScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ id?: string }>()
  const feedRef = useRef<ChatFeedHandle>(null)
  /** Whether the current `opened` has ever put rows on screen — what tells a
   *  transcript that VANISHED apart from one still arriving. See `vanished`. */
  const hadRowsRef = useRef(false)
  const [conversationId, setConversationId] = useState<string | null>(params.id ?? null)
  /**
   * The conversation this screen is OPEN ON — seeded from the route (History, a
   * deep link, a notification) and then moved, in place, by the conversations
   * sheet. Distinct from `conversationId`, which ALSO moves when a new chat gets
   * its id on first send: that transition must not re-gate a feed the user is
   * already looking at.
   *
   * State rather than the route parameter, because the sheet switches
   * conversations without navigating: this screen is the app's single surface,
   * as the desktop window is, and pushing a copy of it per conversation would
   * stack one screen per row the user taps. Everything a switch has to reset
   * hangs off this one value, below.
   */
  const [opened, setOpened] = useState<string | null>(params.id ?? null)
  const [feedRevealed, setFeedRevealed] = useState(opened === null)
  /**
   * How many conversations this screen has shown. A send captures the number it
   * started under and refuses to settle against a later one — see performSubmit.
   * The whole reason in-place switching needs it: an RPC in flight outlives the
   * conversation it was sent from, and its result would otherwise drag the user
   * back to a chat they had already walked away from.
   */
  const generationRef = useRef(0)
  useEffect(() => {
    generationRef.current += 1
    setConversationId(opened)
    setFeedRevealed(opened === null)
    hadRowsRef.current = false
    // Nothing in flight follows the user out of the conversation they left. The
    // TURN does keep running — it lives in chatRuntime under its own id, and
    // walking away is not stopping — but this screen's copy of the last prompt,
    // and messages queued as replies to a turn no longer on screen, do not. The
    // desktop wipes its queue on the same transition.
    setPendingUser(null)
    sendingRef.current = false
    setSending(false)
    setQueued([])
  }, [opened])
  /**
   * Unread badges end where reading begins. While this screen is FOCUSED on a
   * conversation and the app is frontmost, that conversation is the active one
   * (new notifications for it never become badges) and whatever badge it had
   * is cleared — including on the return path: back from a pushed settings
   * screen, and back from the background, where the foreground reconciliation
   * may have just counted notifications for the very conversation on screen.
   * Blur or unmount reports no conversation active; a chat left under a pushed
   * screen accrues badges like any other.
   *
   * Keyed on `conversationId`, NOT `opened`: a chat minted by first send gets
   * an id without ever being "opened" (see the doc on `opened` above), and the
   * model's notify for that run deep-links to that id. `conversationId` is the
   * conversation actually on screen in every case — route, sheet, and mint.
   */
  useFocusEffect(
    useCallback(() => {
      const seeing = (): void => {
        setActiveConversation(conversationId)
        if (conversationId) clearConversationBadges(conversationId)
      }
      seeing()
      const subscription = AppState.addEventListener('change', (next) => {
        if (next === 'active') seeing()
      })
      return () => {
        subscription.remove()
        setActiveConversation(null)
      }
    }, [conversationId])
  )
  const paired = useAppStore((state) => state.paired)
  const { data: conversation, isFetching: conversationFetching } = useConversation(conversationId)
  // The turn being written into this conversation right now, from whichever
  // side started it — this phone, the desktop, a channel. One store for demo
  // and paired alike, so the feed has one streaming shape rather than two.
  const live = useChatRuntime((state) =>
    conversationId ? state.streams[conversationId] : undefined
  )
  // Project mode — set from the Projects screen or a project-bound procedure.
  // The hero and the composer's project button both render from it.
  const activeProject = useActiveProject()
  const activeProjectId = useChatRuntime((state) => state.activeProjectId)
  // A prompt sent from a chat with no id yet, held for the round trip that
  // mints one. Cleared as it is handed to the live turn below.
  const [pendingUser, setPendingUser] = useState<ConversationMessage | null>(null)
  const [sending, setSending] = useState(false)
  /**
   * The same fact as `sending`, a render earlier.
   *
   * `sending` is state, so it is only true from the NEXT commit — and a submit
   * arriving inside that one frame reads an idle screen. That happens: a double
   * tap on the send button, or a tap landing in the same commit as the queue
   * flush below. Both submits then take the send path, two `sendMessage` RPCs
   * reach the desktop for one conversation, and it runs them one after the
   * other — so the second reply looks like a hang, and the same message is
   * answered twice. The desktop closes the identical window with its own
   * sendingRef; this is that guard.
   *
   * Mirrors `sending` at every point one is set, and is read only where a
   * decision is made inside that frame — never to render.
   */
  const sendingRef = useRef(false)
  // Submits held back because a turn was running when they arrived. In memory
  // only, and never written anywhere: a queued row is a message that has not
  // been sent, and the app has exactly one place for messages that have.
  const [queued, setQueued] = useState<QueuedPrompt[]>([])
  // The navigator — every core page, and every conversation. Closed by default
  // and mounted lazily by the sheet itself, so it costs nothing until opened.
  const [sheetOpen, setSheetOpen] = useState(false)
  // One flag for both ends: the desktop's `inapp.verbose`. The feed is a
  // display preference of the workspace, not of the device rendering it.
  const verbose = useConfigValue('inappVerbose')

  const streaming = live?.status === 'streaming' || sending

  const feed = useMemo(
    () => buildFeed({ messages: conversation?.messages, live, pendingUser, sending }),
    [conversation, live, pendingUser, sending]
  )

  /**
   * Is this conversation between turns? Not "is nothing streaming right now" —
   * that is the question this used to ask, and the two differ exactly where it
   * matters.
   *
   * A turn is over when someone SAID so. Two things can say it:
   *
   *   no overlay at all   nothing is in flight and nothing recently was. An
   *                       overlay exists for every turn this phone believes is
   *                       running — opened at the tap, on `turn.status:
   *                       started`, on the desktop's first mirror, and seeded
   *                       from the desktop's active runs when the tunnel comes
   *                       up (seedActiveRuns) — so its absence is real.
   *   ended: 'desktop'    a terminal `turn.status` for this turn. The overlay
   *                       is still up because the saved copy has not arrived,
   *                       but the turn itself is finished.
   *
   * What is deliberately NOT idle is an overlay that merely stopped streaming.
   * The reconnect re-settle clears the streaming flag on every turn it might
   * have missed the end of (attachTurnStream), which is a guess — and while
   * that guess stood, end-of-turn chrome flashed over a turn the desktop was
   * still writing and vanished again on its next frame. That is the flash this
   * closes, and a backgrounded phone coming back mid-turn hits it every time.
   */
  const idle = !live || (live.status !== 'streaming' && live.ended === 'desktop')

  const lastItem = feed[feed.length - 1]
  /**
   * The desktop's Try Again gate, ported: is the feed's last row a failed
   * assistant turn? Failure is read from the message itself — its turn_end or
   * error string — or, for the live row, from the stream the desktop marked
   * failed, which can end a turn before any segment reaches this phone.
   * A failed turn offers the retry; the desktop's card replaces its bubble
   * the same way.
   */
  const lastFailed =
    !!lastItem &&
    !lastItem.streaming &&
    lastItem.message.role === 'assistant' &&
    (!!lastItem.message.error ||
      !!failedTurnEnd(lastItem.message) ||
      (lastItem.key === LIVE_KEY && live?.status === 'error'))

  /**
   * A send that will not happen, taken back down. The live turn opened at the
   * tap has to come with it, or the thinking words run against a desktop that
   * was never asked — the same take-back sendPrompt does when its own RPC
   * throws.
   */
  const abandon = useCallback(
    (settle: (id?: string) => void): void => {
      if (conversationId) useChatRuntime.getState().endStream(conversationId)
      settle()
    },
    [conversationId]
  )

  /**
   * A message carrying files.
   *
   * The desktop copies an attachment into the workspace at the PICK and sends
   * the path; a phone cannot, because the workspace is on the other side of a
   * relay. So the bytes travel here, at the send, and the ordering is what
   * keeps the two surfaces identical:
   *
   *   stage  — the picked files move into the local workspace, and the bubble
   *            is re-published with them, so the message on screen carries its
   *            pictures while the upload is still running
   *   upload — one file at a time; the desktop names each one and, for a first
   *            message, mints the conversation it lands in
   *   send   — the prompt goes with the desktop's own attachment metadata, so
   *            the stored message is byte-for-byte what a desktop send makes
   *
   * A file that fails says so and costs only itself; the prompt and the rest
   * of the files still go, exactly as a bad file costs only itself when it is
   * dropped on the desktop composer.
   */
  const sendWithFiles = useCallback(
    async (text: string, files: PickedFile[], settle: (id?: string) => void): Promise<void> => {
      const staged = await stageForSend(files)
      const optimistic = staged.map(stagedAttachment)
      if (optimistic.length > 0) {
        const user: ConversationMessage = {
          id: mintMessageId(),
          role: 'user',
          content: text,
          timestamp: Date.now(),
          attachments: optimistic
        }
        // A conversation that exists gets the row through the live turn, not
        // through the screen's own copy: buildFeed prefers `live.user`, and a
        // stream left over from a turn whose stored copy never arrived would
        // otherwise keep showing the PREVIOUS prompt for the whole upload.
        // A chat with no id yet has no stream to file it under.
        if (conversationId) beginTurn(conversationId, user)
        else setPendingUser(user)
      }
      // Every file failed to even reach the workspace, and there is no prompt
      // to send without them: there is no message here.
      if (staged.length === 0 && !text) {
        toast.show({ tone: 'error', message: t('chat.attach.error') })
        abandon(settle)
        return
      }

      try {
        if (paired && tunnelClient.connected) {
          const result = await uploadForSend(staged, conversationId)
          if (result.failed.length > 0) {
            toast.show({
              tone: 'error',
              message: t('chat.attach.failed', { names: result.failed.join(', ') })
            })
          }
          // Nothing landed and nothing was typed — sending would be an empty
          // prompt, which the desktop refuses anyway.
          if (result.attachments.length === 0 && !text) {
            abandon(settle)
            return
          }
          const sent = await sendPrompt({
            conversationId: result.conversationId ?? conversationId,
            text,
            attachments: result.attachments
          })
          settle(sent.conversationId)
          return
        }

        // Demo, or a paired phone that cannot reach its desktop right now: the
        // files are filed under the conversation's own uploads folder, in the
        // shape the desktop would have produced, so the feed has one kind of
        // attachment rather than two. Offline, sendPrompt writes the reply
        // that says why nothing answered and the desktop's copy replaces the
        // whole conversation once the link is back.
        let id = conversationId
        if (!id) id = await ensureDemoConversation(deriveTitle(text, optimistic))
        const attachments = await fileLocally(staged, id)
        if (paired) {
          const sent = await sendPrompt({ conversationId: id, text, attachments })
          settle(sent.conversationId)
          return
        }
        await sendDemoPrompt({ conversationId: id, text, attachments })
        settle(id)
      } catch {
        discardStaged(staged)
        abandon(settle)
      }
    },
    [conversationId, paired, toast, t, abandon]
  )

  /**
   * Send one submit, now. The queue calls this too — a queued row is sent by
   * exactly the path it would have taken had it been written a moment later,
   * which is the whole reason the queue holds the composer's payload verbatim
   * rather than anything half-sent.
   */
  const performSubmit = useCallback(
    (payload: ComposerSubmit): void => {
      // The one case CSS can't cover on the desktop either: sending while
      // scrolled up. Re-pin at the send, before the message exists, so the
      // user always sees their own prompt and the reply that follows it.
      feedRef.current?.scrollToEnd()
      const attaching = payload.kind === 'text' && payload.files.length > 0
      // Everything visible about the send happens in THIS tick — before any
      // await — so the prompt and the thinking words are on screen from the tap
      // rather than from the reply. For a conversation that already exists,
      // sendPrompt opens the live turn itself; a new chat has nowhere to file
      // one yet, so the screen holds the prompt for that one round trip.
      //
      // Files make that round trip long — a video is a minute of chunks — and
      // they make it long for an EXISTING conversation too, since nothing is
      // sent until the last byte lands. So a message with attachments is always
      // held here, and re-published a moment later with its files (below) once
      // they have a path to render from.
      if (payload.kind === 'text' && (conversationId === null || attaching)) {
        setPendingUser({
          id: mintMessageId(),
          role: 'user',
          content: payload.text,
          timestamp: Date.now()
        })
      }
      sendingRef.current = true
      setSending(true)
      const generation = generationRef.current
      // Handing over is one state change, not three: by the time this runs the
      // live turn carries the prompt under the conversation's own id, so the
      // row the screen was holding is released in the same frame its
      // replacement appears.
      //
      // Unless the screen has moved on. A send survives the conversation it was
      // sent from — the user can open another one from the sheet mid-flight, and
      // the turn carries on running where it was sent — but everything below is
      // about THIS screen's state, and the conversation it now shows has its own.
      // Adopting a stale id here is how a settling send would yank the user back
      // into the chat they just left; clearing `sending` is how it would mark a
      // NEW send idle. Both are simply not this send's business any more.
      const settle = (id?: string): void => {
        if (generationRef.current !== generation) return
        sendingRef.current = false
        setPendingUser(null)
        setSending(false)
        if (id) setConversationId(id)
      }
      void (async () => {
        if (payload.kind === 'text' && !attaching) {
          try {
            // Paired: the desktop runs the turn and streams it back. Demo: the
            // on-device stand-in answers. Same call site, same result shape.
            const id = paired
              ? (await sendPrompt({ conversationId, text: payload.text })).conversationId
              : await sendDemoPrompt({ conversationId, text: payload.text })
            settle(id)
          } catch {
            settle()
          }
          return
        }

        if (payload.kind === 'text') {
          await sendWithFiles(payload.text, payload.files, settle)
          return
        }
        // Voice note. Paired, the desktop owns the workspace: upload the
        // bytes first — the desktop names the file and, for a first message,
        // creates the conversation — keep a local copy under that same path
        // so playback never re-downloads, then send the message referencing
        // it. The desktop transcribes and runs the turn from there.
        //
        // The bubble does not wait for any of that. The recording is staged
        // into the workspace — a local move — and published exactly as a file
        // send publishes its pictures, so the transport is on screen from the
        // tap and the upload runs behind a message already rendering. The
        // re-publish under the desktop's own path is a cache hit.
        const timestamp = Date.now()
        const name = `voice-${timestamp}.m4a`
        const staged = await stageOutgoingFile(payload.uri, `voice_${timestamp}`, name)
        if (!staged) {
          // The recorder's file cannot be read — there is nothing to send.
          toast.show({ tone: 'error', message: t('chat.voice.error') })
          abandon(settle)
          return
        }
        const optimistic: ConversationMessage = {
          id: mintMessageId(timestamp),
          role: 'user',
          content: '',
          timestamp,
          voicePrompt: true,
          attachments: [
            {
              type: 'audio',
              filePath: staged.relPath,
              originalName: name,
              mimeType: 'audio/mp4',
              sizeBytes: staged.sizeBytes,
              durationSeconds: payload.durationSeconds
            }
          ]
        }
        // Same handover sendWithFiles makes: an existing conversation carries
        // the row on its live turn, a chat with no id yet has no stream to
        // file one under and the screen holds it for the round trip.
        if (conversationId) beginTurn(conversationId, optimistic)
        else setPendingUser(optimistic)
        try {
          if (paired) {
            let uploaded: Awaited<ReturnType<typeof uploadFileToDesktop>> = null
            try {
              uploaded = await uploadFileToDesktop(staged.uri, name, 'audio/mp4', conversationId)
            } catch {
              uploaded = null // a broken transfer keeps the recording local, like offline
            }
            if (uploaded) {
              await importLocalFile(
                staged.uri,
                uploaded.attachment.filePath,
                uploaded.conversationId
              )
              discardStagedFile(staged.relPath)
              // The optimistic id rides along, so the desktop-path copy
              // REPLACES the bubble already on screen instead of remounting
              // it — and the stored transcript later supersedes both by the
              // same id.
              const result = await sendPrompt({
                conversationId: uploaded.conversationId,
                text: '',
                attachments: [{ ...uploaded.attachment, durationSeconds: payload.durationSeconds }],
                voicePrompt: true,
                messageId: optimistic.id
              })
              settle(result.conversationId)
              return
            }
          }
          // Demo — or a paired phone that cannot reach its desktop right now:
          // file the recording locally under the conversation's uploads dir and
          // send the same attachment shape. Offline the reply says why nothing
          // answers, and the local conversation is pruned when the real list
          // resyncs.
          let id = conversationId
          if (!id) id = await ensureDemoConversation(t('chat.voice.record'))
          const relPath = `uploads/conv-${id}/${name}`
          await importLocalFile(staged.uri, relPath, id)
          discardStagedFile(staged.relPath)
          const attachments = [
            {
              type: 'audio' as const,
              filePath: relPath,
              originalName: name,
              mimeType: 'audio/mp4',
              sizeBytes: staged.sizeBytes,
              durationSeconds: payload.durationSeconds
            }
          ]
          if (paired) {
            const result = await sendPrompt({
              conversationId: id,
              text: '',
              attachments,
              voicePrompt: true,
              messageId: optimistic.id
            })
            settle(result.conversationId)
            return
          }
          await sendDemoPrompt({
            conversationId: id,
            text: '',
            attachments,
            voicePrompt: true,
            messageId: optimistic.id
          })
          settle(id)
        } catch {
          // The send never happened; the bubble published above comes down
          // with it, like a file send's does.
          discardStagedFile(staged.relPath)
          abandon(settle)
        }
      })()
    },
    [conversationId, paired, t, toast, abandon, sendWithFiles]
  )

  /**
   * What the composer hands over. Idle it goes; mid-turn it waits.
   *
   * "Mid-turn" is `streaming`, which is both a turn running in this
   * conversation — this phone's, the desktop's, a channel's — and a send of
   * this screen's own that has not come back yet — including one handed over
   * in THIS frame, which `sending` cannot report yet and `sendingRef` can.
   * That second half matters: without it a fast second tap would race the
   * first send's round trip, and the two prompts would reach the desktop in
   * whichever order the network settled on.
   */
  const handleSubmit = useCallback(
    (payload: ComposerSubmit): void => {
      if (streaming || sendingRef.current) {
        queueSequence += 1
        // Minted here, not inside the updater: React runs updaters later, and
        // two submits in one frame would both read the sequence AFTER both
        // increments — one id for two rows, which React draws as two rows that
        // cancel as one and flush as one, leaving the twin behind.
        const id = `q_${queueSequence}`
        setQueued((prev) => [...prev, { ...payload, id }])
        return
      }
      performSubmit(payload)
    },
    [streaming, performSubmit]
  )

  const cancelQueued = useCallback((id: string): void => {
    setQueued((prev) => prev.filter((item) => item.id !== id))
  }, [])

  /**
   * The desktop's retry, verbatim: not a re-send of the failed prompt but a
   * fresh continuation turn told what broke, so the model checks what already
   * completed instead of redoing it. Dropped, never queued, while anything is
   * in flight — the button only renders idle, so this guard is the double-tap.
   */
  const handleTryAgain = useCallback(
    (reason: string): void => {
      if (streaming || sendingRef.current) return
      performSubmit({
        kind: 'text',
        text: t('errors.provider.tryAgainMessage', { reason }),
        files: []
      })
    },
    [streaming, performSubmit, t]
  )

  /**
   * The flush: while nothing is running and something is waiting, the head of
   * the queue goes. One per idle moment, not the whole queue — each send makes
   * the screen busy again, and the next row leaves when THAT turn ends, so the
   * conversation stays one ordered transcript.
   *
   * Stated as an invariant ("idle and non-empty ⇒ send") rather than as a
   * reaction to the turn ending, because the edge is missable: a prompt
   * submitted in the same frame the turn finishes would be queued just after
   * the transition it was waiting for, and would then sit there until some
   * later turn happened to end. Every path out of a turn — finished, stopped,
   * failed, offline — lands here the same way.
   *
   * `sendingRef` covers the one race the invariant cannot see: a manual send
   * that grabbed this same gap, from a tap in the frame the turn ended. The
   * queue simply holds and flushes when THAT turn ends — never needing a
   * dependency of its own, since the ref is cleared by the settle that also
   * clears `sending`, and that is a state change this effect already wakes on.
   */
  useEffect(() => {
    if (streaming || sendingRef.current || queued.length === 0) return
    const [next, ...rest] = queued
    setQueued(rest)
    // Synchronous: performSubmit marks the screen sending in this same commit,
    // so this effect cannot run again on the render it causes.
    performSubmit(next)
  }, [streaming, queued, performSubmit])

  const handleStop = useCallback((): void => {
    if (!conversationId) return
    // Paired, the turn runs on the desktop — stopping is an RPC, not a local
    // timer. Demo turns stay the demo agent's to cancel.
    if (paired) void abortTurn(conversationId)
    else stopDemoTurn(conversationId)
  }, [conversationId, paired])

  /**
   * Back to an empty chat. A turn still running in the conversation being left
   * keeps its own live entry, keyed by its id — leaving is not stopping. What
   * must not follow the user is this screen's copy of the last prompt, or
   * messages queued behind a turn they are walking away from.
   *
   * Shared with project mode, whose two actions both land here: another
   * conversation in the project, and closing the project (which has already
   * cleared it by the time this runs).
   */
  const startNewChat = useCallback((): void => {
    setPendingUser(null)
    sendingRef.current = false
    setSending(false)
    setQueued([])
    setConversationId(null)
    // Both, deliberately. `opened` re-gates the feed and is what the effect
    // above keys on; `conversationId` is what the screen actually sends into,
    // and after a first send the two differ (a new chat mints an id without
    // ever being "opened"). Clearing only one of them is how "new chat" from a
    // chat that had already been sent into ended up back in it.
    setOpened(null)
  }, [])

  /**
   * Open another conversation, in place. The sheet asks; this decides.
   *
   * Nothing is torn down here beyond what the `opened` effect resets: a turn
   * running in the conversation being left keeps writing into chatRuntime under
   * its own id, so coming back to it — from the sheet, moments or minutes later
   * — finds it exactly where it was. That is what makes concurrent conversations
   * work on the phone the way they do on the desktop.
   */
  const openConversation = useCallback(
    (id: string): void => {
      // Already here. Re-gating the feed for it would put a skeleton over a
      // transcript that is already on screen.
      if (id === conversationId) return
      setOpened(id)
    },
    [conversationId]
  )

  /**
   * Entering — or leaving — a project starts a fresh conversation in it.
   *
   * One rule in one place, because there are two ways in (the Projects screen and
   * the chat menu's picker) and both live on other screens: this screen owns the
   * open conversation, so it is the only thing that can put it down. Why it must:
   * a project's instructions are the base a conversation starts FROM, and every
   * turn of a conversation created outside the project runs without them — so
   * carrying the chat you were already in into a project would show its chrome
   * over turns that never received it.
   *
   * On the CHANGE, never on the value: opening a project's conversation from
   * History must not bounce you out of the transcript you just asked for. The ref
   * seeds from the first render, and project mode is not persisted, so a launch
   * can never arrive already inside one.
   */
  const seenProjectRef = useRef(activeProjectId)
  useEffect(() => {
    if (seenProjectRef.current === activeProjectId) return
    seenProjectRef.current = activeProjectId
    startNewChat()
  }, [activeProjectId, startNewChat])

  /**
   * A procedure's run: the prompt is left in the runtime by the Procedures
   * screen and sent from HERE, because this screen owns sending — it holds the
   * live turn, the optimistic bubble and the queue, and a prompt sent behind its
   * back would render as a reply to nothing.
   *
   * TWO PHASES, and the split is the whole point. `startNewChat` clears the open
   * conversation through state, so it is only true from the next commit —
   * submitting in the same tick would read the conversation the user was looking
   * at and send the procedure INTO it. So the first phase resets and the second
   * fires once the reset has actually landed (`conversationId === null`), which
   * is also when performSubmit's own closure sees the empty chat.
   *
   * Taken from the store rather than read, so it is consumed exactly once even
   * though both effects re-run on every render that follows.
   */
  const pendingPrompt = useChatRuntime((state) => state.pendingPrompt)
  useEffect(() => {
    if (pendingPrompt === null || conversationId === null) return
    startNewChat()
  }, [pendingPrompt, conversationId, startNewChat])
  useEffect(() => {
    if (pendingPrompt === null || conversationId !== null) return
    useChatRuntime.getState().setPendingPrompt(null)
    performSubmit({ kind: 'text', text: pendingPrompt, files: [] })
  }, [pendingPrompt, conversationId, performSubmit])

  // Emptiness is a property of the FEED, not of the stored transcript: a turn
  // in flight is on screen whether or not anything has been saved for it yet,
  // and that is what keeps a fresh send out of both the hero and the skeleton.
  const empty = feed.length === 0
  // Whether this screen has shown rows for the CURRENT `opened` (reset with
  // the gate). A ref written during render, deliberately: the fact is needed
  // in the same frame the rows appear, and it subscribes to nothing.
  if (!empty) hadRowsRef.current = true
  // Reading the conversation out of SQLite is async, so an opened conversation
  // has no messages for a frame or two. Show placeholders rather than letting
  // it fall through to the new-chat hero and snap to the feed.
  //
  // `isFetching` covers the second case: a paired conversation opened before
  // its body has been downloaded is present but empty, and the download that
  // fills it is a *refetch* — the data is no longer undefined, so the first
  // test alone would show an empty transcript while the messages are on their
  // way. Only when there is nothing to show yet: a conversation that is
  // genuinely empty stays empty while a background refresh runs.
  const loading =
    empty && conversationId !== null && (conversation === undefined || conversationFetching)
  // A transcript that VANISHED: this screen showed rows for this conversation
  // and now holds a present-but-empty copy. Nothing in the product empties a
  // conversation in place, so this is always a sync transient mid-heal (a
  // fetch that raced a desktop-side write) — never a state to draw as final.
  // Without it, the one frame the machine had for this was the worst one: the
  // hero needs `!loading`, the skeleton needed `!feedRevealed`, and a feed
  // with no rows paints nothing — the pure-blank chat reported 2026-08-26,
  // opened from a notification mid-run. A conversation the query answers
  // `null` for is genuinely gone and falls through to the hero as ever.
  const vanished = empty && hadRowsRef.current && conversation != null

  // The skeleton stands in for the whole opening sequence, not just the read:
  // it stays up while the body arrives AND while the laid-out feed is pinning
  // itself to the end behind it (ChatFeed.onReady) — and it comes BACK over
  // any later empty-but-unsettled frame (`loading` after reveal, `vanished`),
  // so no ordering of fetches and invalidations can ever paint a blank
  // transcript. A conversation that settles as genuinely empty resolves to
  // the hero — `loading` and `vanished` both false, nothing to lay out.
  const showSkeleton = (!feedRevealed && !empty) || (empty && (loading || vanished))

  return (
    // No top padding, and no top bar: the transcript owns the whole column and
    // runs under the status bar, with the two floating controls (below) laid
    // over it. What keeps the first message clear of them is padding INSIDE the
    // scroller, which is also what lets the conversation pass beneath them.
    <View className="bg-bg flex-1">
      {/* One per screen, not one per message: every bubble and tool card can
          open it, and it holds whichever text was long-pressed last. */}
      <SelectTextHost />
      {/* 'padding' on BOTH platforms. The app runs edge-to-edge on Android,
          where the window ignores adjustResize and the keyboard just paints
          over the composer — so RN has to do the lifting there exactly as it
          does on iOS. */}
      <KeyboardAvoidingView behavior="padding" className="flex-1" keyboardVerticalOffset={0}>
        <View className="flex-1">
          {empty && !loading && !vanished ? (
            // Project mode swaps the wolffish hero for the project's own
            // identity — emoji, title, and its instructions in the same
            // recessed block the cards use — because that IS what a new
            // conversation here starts from. The desktop makes the same swap.
            <View className="flex-1 items-center justify-center gap-4 px-8">
              {activeProject ? (
                <Text className="text-6xl leading-[64px]">
                  {activeProject.icon || DEFAULT_PROJECT_ICON}
                </Text>
              ) : (
                <Image
                  source={require('@/assets/images/icon-trans.png')}
                  style={{ width: 80, height: 80 }}
                  contentFit="contain"
                />
              )}
              <Text className="text-fg font-sans-semibold text-center text-2xl">
                {activeProject
                  ? activeProject.title.trim() || t('projects.untitled')
                  : t('chat.empty.title')}
              </Text>
              {activeProject ? (
                activeProject.instructions.trim() ? (
                  <View className="w-full">
                    <PromptPreview
                      value={activeProject.instructions}
                      empty={t('projects.noInstructions')}
                      maxHeight={140}
                      // The hero has no card around it, so the block takes the
                      // card colour rather than the recessed one.
                      onSurface
                    />
                  </View>
                ) : null
              ) : (
                <Text className="text-muted text-center font-sans text-sm leading-relaxed">
                  {t('chat.empty.subtitle')}
                </Text>
              )}
            </View>
          ) : (
            <ChatFeed
              // A different conversation is a different scroll position and a
              // different gate; keying on the opened id restarts both.
              key={opened ?? 'new'}
              ref={feedRef}
              gated={opened !== null}
              // The gate opens on rows, never on the empty feed that stands
              // here for the frames before the transcript arrives — that is
              // the window the skeleton is covering.
              hasContent={!empty}
              // Clearance for the floating controls, which the transcript
              // scrolls under rather than stopping below.
              topInset={insets.top + FLOATING_AREA}
              // Streamed growth is glued to the end, not eased — see ChatFeed.
              streaming={streaming}
              onReady={() => setFeedRevealed(true)}
            >
              {feed.map((item) =>
                item.message.role === 'user' ? (
                  <UserBubble
                    key={item.key}
                    message={item.message}
                    conversationId={conversationId ?? undefined}
                  />
                ) : (
                  <AssistantMessageView
                    key={item.key}
                    message={item.message}
                    conversationId={conversationId ?? undefined}
                    verbose={verbose}
                    streaming={item.streaming}
                    // The in-flight turn's row is the one that hosts the
                    // conversation's live ask/approval cards.
                    liveTurn={item.key === LIVE_KEY}
                    liveError={item.key === LIVE_KEY && live?.status === 'error'}
                    // Present only on the last row when it is a failed turn
                    // and no turn is running — the desktop's own predicate.
                    onTryAgain={
                      item === lastItem && lastFailed && !streaming && idle
                        ? handleTryAgain
                        : undefined
                    }
                  />
                )
              )}
            </ChatFeed>
          )}
          {showSkeleton && (
            // Fades out as the feed fades in — one cross-dissolve, so the
            // placeholders resolve into the messages they stood in for
            // instead of being replaced by them.
            <Animated.View exiting={FadeOut.duration(FEED_FADE_MS)} style={StyleSheet.absoluteFill}>
              <ChatSkeleton />
            </Animated.View>
          )}
        </View>

        <View style={{ paddingBottom: insets.bottom }}>
          <Composer
            streaming={streaming}
            conversation={conversation}
            queued={queued}
            onSubmit={handleSubmit}
            onCancelQueued={cancelQueued}
            onStop={handleStop}
            onNewConversation={startNewChat}
          />
        </View>
      </KeyboardAvoidingView>

      {/* Last, so they paint over the transcript and the skeleton alike. The
          navigator on the leading edge, a new chat on the trailing one — the
          only two things the header held that were worth a fixed strip. */}
      <FloatingChrome
        top={insets.top + FLOATING_GAP}
        onOpenSheet={() => setSheetOpen(true)}
        onNewChat={startNewChat}
      />
      <ConversationsSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        activeId={conversationId}
        onSelect={openConversation}
      />
    </View>
  )
}
