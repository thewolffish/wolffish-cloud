/**
 * The overlay stack on screen: what is drawn, what is not, and which text a
 * card ends up with.
 *
 * The one that matters is the last: `body` is a DUAL-PURPOSE field on the wire.
 * An automation's is the literal prompt the user wrote; a compaction's or
 * reflection's is an i18n key the desktop mints (see OverlayKind). Translate
 * the wrong one and a card either prints `heartbeat.overlay.reflection` at the
 * user or runs their prompt through i18next, and neither fails loudly.
 */

// The store reaches the tunnel client, which reaches the push registration,
// which touches AsyncStorage at import time.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import { ActiveOverlays } from '@/components/overlays/ActiveOverlays'
import { applyOverlayReindex, applyOverlayRuns, clearOverlays } from '@/lib/sync/overlays'
import { useDemoConfig } from '@/state/demoConfig'
import { ThemeContext } from '@/providers/theme/useTheme'
import type { AutomationRun } from '@/lib/tunnel/protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'

// The pulse and the enter/exit transitions need the native runtime and have no
// say in what is on the card.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  return {
    __esModule: true,
    default: { View },
    Easing: { out: (fn: unknown) => fn, ease: 0 },
    FadeInUp: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    LinearTransition: { duration: () => ({}) },
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: (style: () => object) => style(),
    withRepeat: (value: number) => value,
    withTiming: (value: number) => value
  }
})

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 })
}))

function run(id: string, over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id,
    label: id,
    body: `prompt for ${id}`,
    kind: 'automation',
    startedAt: 1_000,
    mode: null,
    ...over
  }
}

/** Turn the three card switches on or off, as the desktop config would. */
function showCards(value: boolean): void {
  const { setValue } = useDemoConfig.getState()
  setValue('mobileRunCards', value)
  setValue('compactionCards', value)
  setValue('reflectionCards', value)
}

beforeEach(() => {
  clearOverlays()
  // Every family ships OFF (they are noise by default — see composeOverlays),
  // so the cases below that are ABOUT a drawn card have to ask for one first.
  showCards(true)
})

/**
 * The sheet's Modal reads the theme, so the stack always needs the context.
 *
 * Awaited, as every screen test here is: a bare `render()` called from inside a
 * helper never binds `screen`, and every later query then fails with "render
 * function has not been called" rather than with what is actually wrong.
 */
async function mount(): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <ActiveOverlays />
    </ThemeContext.Provider>
  )
}

it('draws nothing at all when the desktop is idle', async () => {
  // Not an empty container — nothing, so no invisible strip sits over the
  // screen swallowing the top of every other view.
  await mount()
  expect(screen.toJSON()).toBeNull()
})

it('draws one row per run, oldest first', async () => {
  applyOverlayRuns({
    running: [run('Weekly digest', { startedAt: 2_000 }), run('Daily sweep', { startedAt: 1_000 })],
    queued: []
  })
  await mount()
  const titles = screen.getAllByRole('button').map((node) => node.props.accessibilityLabel)
  expect(titles).toEqual(['Daily sweep', 'Weekly digest'])
})

it('prints an automation’s prompt verbatim and translates a built-in job’s key', async () => {
  applyOverlayRuns({
    running: [
      run('mine', { body: 'Check the overnight logs' }),
      run('Nightly reflection', { kind: 'reflection', body: 'heartbeat.overlay.reflection' })
    ],
    queued: []
  })
  await mount()
  expect(screen.getByText('Check the overnight logs')).toBeTruthy()
  expect(screen.getByText(/Review settled conversations/)).toBeTruthy()
  // The key itself must never reach the screen.
  expect(screen.queryByText('heartbeat.overlay.reflection')).toBeNull()
})

it('falls back to the kind name when the wire carries no label', async () => {
  applyOverlayRuns({ running: [run('id-only', { label: '', kind: 'compaction' })], queued: [] })
  await mount()
  expect(screen.getByText('Compaction')).toBeTruthy()
})

it('cards a procedure run under the automations switch', async () => {
  // One switch for both: a procedure is a saved prompt run in the background,
  // and "is something running for me" is one question. Its body is the prompt
  // itself, like an automation's — never an i18n key.
  applyOverlayRuns({
    running: [run('Morning brief', { kind: 'procedure', body: 'Summarise the inbox' })],
    queued: []
  })
  await mount()
  expect(screen.getByText('Summarise the inbox')).toBeTruthy()

  useDemoConfig.getState().setValue('mobileRunCards', false)
  await waitFor(() => expect(screen.toJSON()).toBeNull())
})

it('draws nothing for a family whose cards are switched off', async () => {
  // The whole point of the switches: the run still happens and the phone still
  // hears about it — it simply does not interrupt. Not even the queue strip,
  // which would otherwise announce a card the user cannot open.
  showCards(false)
  applyOverlayRuns({
    running: [run('Daily sweep'), run('Nightly reflection', { kind: 'reflection' })],
    queued: [{ id: 'q', label: 'Monthly report', kind: 'automation', queuedAt: 9 }]
  })
  await mount()
  expect(screen.toJSON()).toBeNull()
})

it('hides one family without touching the others', async () => {
  useDemoConfig.getState().setValue('mobileRunCards', false)
  applyOverlayRuns({
    running: [run('Daily sweep'), run('Nightly reflection', { kind: 'reflection' })],
    queued: []
  })
  await mount()
  const titles = screen.getAllByRole('button').map((node) => node.props.accessibilityLabel)
  expect(titles).toEqual(['Nightly reflection'])
})

it('still shows a reindex, which has no switch of its own', async () => {
  showCards(false)
  applyOverlayReindex({ startedAt: 1_000, done: 1204, total: 3900 })
  await mount()
  expect(screen.getByText('Rebuilding memory index')).toBeTruthy()
})

it('shows a reindex as its file count, not a prompt', async () => {
  applyOverlayReindex({ startedAt: 1_000, done: 1204, total: 3900 })
  await mount()
  expect(screen.getByText('Rebuilding memory index')).toBeTruthy()
  expect(screen.getByText('1,204 / 3,900')).toBeTruthy()
})

it('owns up to the queue and to rows the cap left out', async () => {
  applyOverlayRuns({
    running: [run('a', { startedAt: 1 }), run('b', { startedAt: 2 }), run('c', { startedAt: 3 })],
    queued: [{ id: 'q', label: 'Monthly report', kind: 'automation', queuedAt: 9 }]
  })
  applyOverlayReindex({ startedAt: 0, done: 1, total: 2 })
  await mount()
  expect(screen.getByText('+1 more running · 1 queued')).toBeTruthy()
  expect(screen.getByText('Monthly report')).toBeTruthy()
})

it('opens the full prompt on tap, and closes it when that run ends', async () => {
  applyOverlayRuns({
    running: [run('Daily sweep', { body: 'Read every unread thread' })],
    queued: []
  })
  await mount()

  fireEvent.press(screen.getByRole('button', { name: 'Daily sweep' }))
  // The sheet says where it is running; the card never does.
  await waitFor(() => expect(screen.getByText(/running on your desktop/)).toBeTruthy())

  // The run ends. A sheet left standing over a finished run would go on
  // claiming it is still going.
  applyOverlayRuns({ running: [], queued: [] })
  await waitFor(() => expect(screen.toJSON()).toBeNull())
})
