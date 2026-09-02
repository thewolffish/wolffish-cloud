/**
 * Kick + observe the on-open media hydration of one conversation.
 *
 * Opening a conversation is what downloads its media (nothing is
 * predownloaded at restore): this hook fires the hydrate IPC once per
 * visible conversation and returns the live progress for the banner.
 * The main process dedupes concurrent flights, and a fully-hydrated
 * conversation resolves instantly with filesTotal 0 — so calling this on
 * every open is free in the steady state.
 */
import { useHydration } from '@lib/hydration/hydrationStore'
import type { ConversationHydrationProgress } from '@preload/index'
import { useEffect } from 'react'

export function useConversationHydration(
  conversationId: string | null,
  enabled: boolean
): ConversationHydrationProgress | null {
  useEffect(() => {
    if (!conversationId || !enabled) return
    void window.api.conversation.hydrate(conversationId).catch(() => undefined)
  }, [conversationId, enabled])
  return useHydration(conversationId)
}
