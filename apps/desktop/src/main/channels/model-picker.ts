/**
 * Shared helpers behind the channel `/model` command (WhatsApp + Telegram).
 *
 * One lane in Wolffish Cloud: a "model option" is just a model id — the
 * catalog of ids a user may pick is served per-user by the org API. Until
 * that integration lands, the only listable option is the currently
 * selected model, so `/model` reads as "here is your model" rather than a
 * picker with choices.
 */
export type ModelOption = { model: string }

/**
 * Max models a channel lists at once. A phone chat is a poor place to
 * scroll a large catalog, so the picker caps the list and tells the user
 * to narrow with `/model <query>` instead.
 */
export const MODEL_LIST_CAP = 20

/**
 * The selectable models. PLACEHOLDER: only the current selection exists
 * until GET /v1/models is wired in — then this expands to the user's
 * allowlist from the API.
 */
export function collectModelOptions(selectedModel: string | null): ModelOption[] {
  return selectedModel ? [{ model: selectedModel }] : []
}

/**
 * Case-insensitive substring filter over model id — powers `/model deepseek`
 * quick select. An empty query returns everything.
 */
export function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((o) => o.model.toLowerCase().includes(q))
}
