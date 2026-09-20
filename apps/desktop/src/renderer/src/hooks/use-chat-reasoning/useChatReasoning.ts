import {
  normalizeReasoningMode,
  reasoningModesFor,
  type ReasoningMode
} from '@main/runtime/reasoning'
import { useFlow } from '@providers/flow/useFlow'
import { useMemo } from 'react'

/**
 * The chat's reasoning contract, for the Library cards.
 *
 * `modes` is the ordered set the selected model honours — the exact
 * `reasoningModesFor('cloud', …)` result the brain button renders — and
 * `current` is the mode chat is showing right now (the per-model pick clamped
 * to `modes`). A card's thinking switch shows its item's own stamp when it
 * has one and `current` when it doesn't (the "rows saved before the field
 * existed follow the chat" contract its sibling `mode` toggle already keeps),
 * and a new item is stamped with `current` at creation.
 */
export function useChatReasoning(): {
  modes: ReasoningMode[]
  current: ReasoningMode
} {
  const { status } = useFlow()
  const llm = status?.config?.llm
  return useMemo(() => {
    const selectedModel = llm?.model ?? null
    if (!selectedModel) return { modes: [], current: 'off' as const }
    const modes = reasoningModesFor('cloud', selectedModel)
    return {
      modes,
      current: normalizeReasoningMode(llm?.thinkingModes?.[selectedModel], modes)
    }
  }, [llm])
}
