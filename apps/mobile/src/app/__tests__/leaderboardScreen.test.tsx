jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Leaderboard screen — the org's standing on the phone.
 *
 * The three things that could break silently here, and nothing else:
 *
 *  - the WIRE. The screen must ask the org for the page it is showing —
 *    ten rows at this offset, this search — and must render what comes back
 *    verbatim. It never sorts and never renumbers, so a row's rank is the
 *    org's rank; a screen that quietly re-sorted would look identical and
 *    be wrong.
 *  - the PAGER. Previous/Next move by ten, go inert at the ends, and keep
 *    their labels while a fetch is in flight (a button that renames itself
 *    mid-tap is a moving target). A tap on a dead edge must leave nothing.
 *  - the "where am I". `me` is rendered whatever the page shows, and is not
 *    duplicated when the page already holds that row.
 *
 * Unpaired is its own case: no session, so nothing may be asked of the org
 * at all — the screen says to connect instead of failing a request.
 */

const mockLeaderboard = jest.fn()
// Only the one call is stubbed: the rest of the client is real, because the
// screen pulls in SettingsUI, which pulls in the bridge, which reads
// `getApiBase` at import time.
jest.mock('@/lib/cloud/api', () => ({
  ...jest.requireActual('@/lib/cloud/api'),
  leaderboard: (...args: unknown[]) => mockLeaderboard(...args)
}))
jest.mock('@/lib/cloud/session', () => ({
  cloudSession: {
    withAccessToken: (fn: (token: string) => Promise<unknown>) => fn('token')
  }
}))

const mockAppState = { paired: true }
jest.mock('@/state/appStore', () => {
  const useAppStore = (selector: (s: typeof mockAppState) => unknown): unknown =>
    selector(mockAppState)
  useAppStore.getState = (): typeof mockAppState => mockAppState
  return { useAppStore }
})

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() } }))

import LeaderboardScreen from '@/app/settings/leaderboard'
import { LocaleContext } from '@/providers/locale/useLocale'
import { ThemeContext } from '@/providers/theme/useTheme'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

type Row = {
  rank: number
  user_id: string
  name: string
  role: string
  tokens: number
  conversations: number
  agentic_tasks: number
}

const row = (rank: number, over: Partial<Row> = {}): Row => ({
  rank,
  user_id: `usr_${rank}`,
  name: `Person ${rank}`,
  role: 'employee',
  tokens: 1000 * rank,
  conversations: rank,
  agentic_tasks: 0,
  ...over
})

/** A page as the org sends it: rows, the filtered total, and `me`. */
const page = (rows: Row[], over: Record<string, unknown> = {}) => ({
  generated_at: '2026-09-04T00:00:00.000Z',
  total: rows.length,
  board_size: rows.length,
  truncated: false,
  limit: 10,
  offset: 0,
  rows,
  me: null,
  ...over
})

async function draw(): Promise<void> {
  // Retries off and a fresh cache per test: a failure must surface as the
  // error state on the first attempt, and one test's page must never paint
  // in the next one.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  await render(
    <QueryClientProvider client={client}>
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        <LocaleContext.Provider
          value={{ locale: 'en', isRtl: false, setLocale: async () => undefined }}
        >
          <LeaderboardScreen />
        </LocaleContext.Provider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  )
}

const lastAsk = (): Record<string, unknown> =>
  mockLeaderboard.mock.calls[mockLeaderboard.mock.calls.length - 1]![1] as Record<string, unknown>

beforeEach(() => {
  mockLeaderboard.mockReset()
  mockAppState.paired = true
})

describe('the leaderboard', () => {
  it('asks for the top ten and renders the org’s own ranking', async () => {
    const rows = [row(1), row(2), row(3)]
    mockLeaderboard.mockResolvedValue(page(rows))
    await draw()

    await waitFor(() => expect(screen.getByText('Person 1')).toBeTruthy())
    expect(lastAsk()).toEqual({ limit: 10, offset: 0, q: undefined })

    // The rank shown is the rank the org sent — not the row's position.
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    // All three figures ride the row, in the order the desktop shows them.
    expect(screen.getByText('1k tokens · 1 chats · 0 tasks')).toBeTruthy()
  })

  it('keeps a searched row’s ORG rank instead of renumbering it', async () => {
    mockLeaderboard.mockResolvedValue(page([row(42)], { total: 1, board_size: 60 }))
    await draw()
    await waitFor(() => expect(screen.getByText('Person 42')).toBeTruthy())
    // 42, not 1: the match keeps where it stands in the whole organization.
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.getByText('1–1 of 1')).toBeTruthy()
  })

  it('pages by ten, and refuses to walk off either end', async () => {
    const full = Array.from({ length: 10 }, (_, i) => row(i + 1))
    mockLeaderboard.mockResolvedValue(page(full, { total: 14 }))
    await draw()
    await waitFor(() => expect(screen.getByText('Person 1')).toBeTruthy())

    // At the top: Previous is dead, and pressing it must ask for nothing.
    const before = mockLeaderboard.mock.calls.length
    expect(screen.getByText('Previous')).toBeDisabled()
    fireEvent.press(screen.getByText('Previous'))
    expect(mockLeaderboard).toHaveBeenCalledTimes(before)

    fireEvent.press(screen.getByText('Next'))
    await waitFor(() => expect(lastAsk()).toEqual({ limit: 10, offset: 10, q: undefined }))
    // The labels are the same words they were — only the disabled state moves.
    expect(screen.getByText('Next')).toBeTruthy()
    expect(screen.getByText('Previous')).toBeTruthy()
  })

  it('shows where you stand even when the page does not', async () => {
    const mine = row(37, { user_id: 'usr_me', name: 'Me Myself' })
    mockLeaderboard.mockResolvedValue(page([row(1), row(2)], { me: mine }))
    await draw()

    await waitFor(() => expect(screen.getByText(/Me Myself/)).toBeTruthy())
    expect(screen.getByText('(you)')).toBeTruthy()
    // 37, not 1: your standing is your standing in the whole organization,
    // not your position among the rows that happen to be on screen.
    expect(screen.getByText('37')).toBeTruthy()
  })

  it('does not print you twice when the page already holds you', async () => {
    const mine = row(37, { user_id: 'usr_me', name: 'Me Myself' })
    mockLeaderboard.mockResolvedValue(page([mine, row(2)], { me: mine }))
    await draw()

    await waitFor(() => expect(screen.getAllByText(/Me Myself/)).toHaveLength(1))
  })

  it('says what is wrong instead of showing an empty board', async () => {
    mockLeaderboard.mockRejectedValue(new Error('nope'))
    await draw()
    await waitFor(() => expect(screen.getByText("Couldn't load the leaderboard.")).toBeTruthy())
  })

  it('asks the org for nothing at all when the phone is not paired', async () => {
    mockAppState.paired = false
    await draw()
    await waitFor(() =>
      expect(screen.getByText('Connect to your organization to see the leaderboard.')).toBeTruthy()
    )
    expect(mockLeaderboard).not.toHaveBeenCalled()
  })

  // LAST, deliberately: a fake clock leaks into whatever runs after it here
  // (react-query schedules its notifications on a timer), and a leaked clock
  // shows up as the next test rendering nothing at all.
  it('sends the search, debounced, and starts it back at the top', async () => {
    jest.useFakeTimers()
    try {
      mockLeaderboard.mockResolvedValue(page([row(1)]))
      await draw()
      fireEvent.changeText(screen.getByLabelText('Search by name'), 'zeta')
      // Nothing leaves on the keystroke itself.
      expect(mockLeaderboard.mock.calls.every(([, p]) => !(p as { q?: string }).q)).toBe(true)
      await act(async () => {
        jest.advanceTimersByTime(300)
      })
      await waitFor(() => expect(lastAsk()).toEqual({ limit: 10, offset: 0, q: 'zeta' }))
    } finally {
      jest.useRealTimers()
    }
  })
})
