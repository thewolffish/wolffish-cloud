import type { ConversationFile, ConversationMessage, PersistedApproval } from '@preload/index'
import type { ApprovalCardState, AssistantStatus, ChatMessage } from '@providers/flow/useFlow'

/**
 * Map ONE persisted message into a feed message. Extracted so the live
 * channel-turn mirror (conversation.onMessageMirror) can map a single
 * in-progress assistant snapshot with the exact same rules the full-file
 * load uses — the mirrored message and the one the load later reads must be
 * byte-for-byte the same shape, or the id-keyed upsert would flicker.
 */
export function mapConversationMessage(m: ConversationMessage): ChatMessage {
  // The persisted id IS the feed id: persistConversation writes it back, so
  // the message keeps one identity across load → feed → save → merge (the
  // id-keyed reconcile in mergeConversationOnto depends on that round-trip).
  // Minting is the fallback for a pre-id file only — the launch migration
  // ids those before the renderer can load one, so it should never fire —
  // and the first save then adopts the minted ids onto disk.
  const msgId = m.id ?? `m_${m.timestamp}_${Math.random().toString(36).slice(2, 6)}`
  if (m.role === 'user') {
    return {
      id: msgId,
      role: 'user' as const,
      content: m.content,
      timestamp: m.timestamp,
      ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      // Voice-note provenance has to survive the round-trip: dropping it
      // here would let a continued Telegram/WhatsApp conversation replay
      // every voice note's audio back to the LLM, which is exactly what
      // the flag exists to prevent.
      ...(m.voicePrompt ? { voicePrompt: true } : {}),
      ...(m.voiceLang ? { voiceLang: m.voiceLang } : {})
    }
  }
  const segments = m.segments ?? [
    {
      kind: 'text' as const,
      delta: m.content,
      turnId: '',
      segmentId: `seg_${m.timestamp}`
    }
  ]
  const approvals = m.approvals
    ? (Object.fromEntries(
        Object.entries(m.approvals).map(([k, v]: [string, PersistedApproval]) => [
          k,
          v as ApprovalCardState
        ])
      ) as Record<string, ApprovalCardState>)
    : undefined
  const isError = !!m.error
  return {
    id: msgId,
    role: 'assistant' as const,
    segments,
    approvals,
    toolTimings: m.toolTimings,
    status: (isError ? 'error' : 'complete') as AssistantStatus,
    stopReason: m.stopReason,
    ...(isError ? { error: m.error } : {}),
    timestamp: m.timestamp
  }
}

/**
 * Map a persisted conversation's messages into feed messages — the shape a
 * Chat session renders. Shared by every open-conversation entry point
 * (History rows, the sidebar's Conversations list) so they can't drift.
 */
export function mapConversationMessages(conv: ConversationFile): ChatMessage[] {
  return conv.messages.map(mapConversationMessage)
}
