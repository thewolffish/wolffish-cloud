/**
 * A model id as the composer chip wears it: the model's own name, without the
 * provider that serves it. `deepseek-ai/DeepSeek-V3` reads as `DeepSeek-V3`.
 *
 * The desktop's composer chip shows exactly this (its `shortModelName`), and
 * for the same reason: the chip already carries the provider's mark beside the
 * text, so repeating the slug spends the chip's whole width saying what the
 * logo has said. The trailing date stamp and `-latest`/`-preview` go too —
 * they distinguish releases of one model, which is a thing to read on the
 * Model screen, not on a one-line chip.
 *
 * The full id is never rewritten anywhere it is the subject rather than a
 * label: the Model screen's row shows it whole, and so does the chip's
 * accessibility label.
 */
export function shortModelName(id: string): string {
  let name = id.split('/').pop() ?? id
  name = name.replace(/[-_.](20\d{6}|20\d{2}-\d{2}-\d{2})$/, '')
  name = name.replace(/-(latest|preview)$/i, '')
  return name
}
