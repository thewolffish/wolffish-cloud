import { createContext } from 'react'

/**
 * Set by Settings around a panel drilled open from a card grid (Services and
 * Models); null everywhere else, so PanelBackChevron (drillNav.tsx) collapses
 * to nothing when the same panel renders outside a drill (ModelPicker during
 * onboarding, a channel sub-tab, and so on).
 */
export const DrillBackContext = createContext<(() => void) | null>(null)

export type TabKey =
  | 'appearance'
  | 'model'
  | 'channels'
  | 'services'
  | 'mcp'
  | 'wolffish'
  | 'variables'
  | 'capabilities'
  | 'knowledge'
  | 'usage'
  | 'data'

let nextTab: TabKey | null = null

export function preselectSettingsTab(tab: TabKey): void {
  nextTab = tab
}

export function consumeNextTab(): TabKey | null {
  const t = nextTab
  nextTab = null
  return t
}

type TabRequestListener = (tab: TabKey) => void
let tabRequestListener: TabRequestListener | null = null

/**
 * A mounted Settings page follows tab jumps requested from nested panels
 * (e.g. a capability gate card's "Open Capabilities" button). Returns the
 * unsubscribe.
 */
export function onTabRequest(listener: TabRequestListener): () => void {
  tabRequestListener = listener
  return () => {
    if (tabRequestListener === listener) tabRequestListener = null
  }
}

export function requestSettingsTab(tab: TabKey): void {
  if (tabRequestListener) tabRequestListener(tab)
  else preselectSettingsTab(tab)
}

/**
 * The tiers that have an admin page. Owner and admin can change things;
 * support is the read-only tier and still needs the page to look at.
 *
 * Lives here rather than in the screen that renders it because two surfaces
 * gate on it — the sheet's page row and the screen itself — and a second
 * copy is how one of them ends up offering a page the other hides.
 */
export const ADMIN_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'support'])
