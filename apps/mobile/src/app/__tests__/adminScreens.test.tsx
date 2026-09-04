jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The admin screens on the phone.
 *
 * What could break here without looking broken, and nothing else:
 *
 *  - the GATE. An employee must not see the admin screens at all, and the
 *    support tier must see them without a single control it can press. Both
 *    are re-checked by the org, so a mistake here is not a security hole —
 *    it is a screen full of buttons that all fail, which is worse to use
 *    than one that never offered them.
 *  - the CONFIRMATIONS. Three of these actions sign somebody out of
 *    everything, and on a phone a mis-tap is ordinary. Each must ask first,
 *    and cancelling must reach the org with nothing.
 *  - the PLAN. It is the control this screen exists for; it must send the
 *    plan the admin picked and it must be visible again after.
 *  - the ONE-TIME PASSWORD. The org mints it once and never stores it in
 *    the clear, so the screen has to keep it on display rather than behind
 *    a toast.
 */

const mockRoster = jest.fn()
const mockOverview = jest.fn()
const mockSetPlan = jest.fn()
const mockUpdateUser = jest.fn()
const mockResetPassword = jest.fn()
const mockRevokeSessions = jest.fn()
const mockClearPin = jest.fn()

jest.mock('@/lib/cloud/admin', () => ({
  ...jest.requireActual('@/lib/cloud/admin'),
  adminRoster: (...a: unknown[]) => mockRoster(...a),
  adminUserOverview: (...a: unknown[]) => mockOverview(...a),
  adminSetPlan: (...a: unknown[]) => mockSetPlan(...a),
  adminUpdateUser: (...a: unknown[]) => mockUpdateUser(...a),
  adminResetPassword: (...a: unknown[]) => mockResetPassword(...a),
  adminRevokeSessions: (...a: unknown[]) => mockRevokeSessions(...a),
  adminClearPin: (...a: unknown[]) => mockClearPin(...a)
}))

const mockUser = { id: 'usr_me', email: 'me@wolffi.sh', name: 'Me', role: 'owner' }
jest.mock('@/lib/cloud/session', () => ({
  cloudSession: {
    withAccessToken: (fn: (token: string) => Promise<unknown>) => fn('token'),
    get current() {
      return { session: { user: mockUser } }
    },
    subscribe: () => () => undefined
  }
}))

const mockAppState = { paired: true, demoMode: false }
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
const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: (...a: unknown[]) => mockPush(...a) },
  useLocalSearchParams: () => ({ userId: 'usr_1' })
}))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }))
// The toast provider animates; reanimated needs a native runtime this env
// has no business booting. Same stub the chat screen tests use.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  const fade = { duration: () => fade }
  return { __esModule: true, default: { View }, FadeOut: fade, FadeInDown: fade, FadeInUp: fade }
})

import AdminPeopleScreen from '@/app/settings/admin/index'
import AdminPersonScreen from '@/app/settings/admin/person/[userId]'
import { LocaleContext } from '@/providers/locale/useLocale'
import { ThemeContext } from '@/providers/theme/useTheme'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

const person = (over: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  email: 'sam@wolffi.sh',
  name: 'Sam Employee',
  role: 'employee',
  status: 'active',
  must_change_password: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  last_login_at: '2026-09-01T00:00:00.000Z',
  token_plan: 'standard',
  ceilings: { monthlyIn: 100_000_000, monthlyOut: 8_000_000 },
  daily_token_cap: null,
  daily_search_cap: null,
  requests: 40,
  denied: 0,
  tokens_in: 1_500_000,
  tokens_out: 90_000,
  tokens_cached: 900_000,
  cost_microusd: 420_000,
  searches: 12,
  days_active: 6,
  last_active_day: '2026-09-03',
  month_tokens_in: 90_000_000,
  month_tokens_out: 1_000_000,
  month_cost_microusd: 400_000,
  month_searches: 10,
  devices: 2,
  phones: 1,
  conversations: 9,
  ...over
})

const roster = (people: Array<Record<string, unknown>>) => ({
  since: '2026-08-05',
  days: 30,
  month_start: '2026-09-01',
  plans: {
    standard: { monthlyIn: 100_000_000, monthlyOut: 8_000_000 },
    high: { monthlyIn: 300_000_000, monthlyOut: 25_000_000 },
    unmetered: { monthlyIn: 0, monthlyOut: 0 }
  },
  people
})

const overview = ({
  user: userOver,
  policy: policyOver,
  ...over
}: Record<string, unknown> = {}) => ({
  user: {
    id: 'usr_1',
    email: 'sam@wolffi.sh',
    name: 'Sam Employee',
    role: 'employee',
    status: 'active',
    must_change_password: 0,
    phone: '',
    position: '',
    bio: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    last_login_at: '2026-09-01T00:00:00.000Z',
    temp_password_expires_at: null,
    ...((userOver as object) ?? {})
  },
  window: { since: '2026-08-05', days: 30, month_start: '2026-09-01' },
  policy: {
    token_plan: 'standard',
    ceilings: { monthlyIn: 100_000_000, monthlyOut: 8_000_000 },
    ...((policyOver as object) ?? {})
  },
  plans: {
    standard: { monthlyIn: 100_000_000, monthlyOut: 8_000_000 },
    high: { monthlyIn: 300_000_000, monthlyOut: 25_000_000 },
    unmetered: { monthlyIn: 0, monthlyOut: 0 }
  },
  standing: {
    tokens: { userDayUsed: 1, orgMonthUsed: 2, userMonthIn: 90_000_000, userMonthOut: 1_000_000 },
    searches: null
  },
  lanes: [
    {
      kind: 'chat',
      requests: 40,
      denied: 0,
      tokens_in: 1_500_000,
      tokens_out: 90_000,
      tokens_cached: 900_000,
      cost_microusd: 420_000,
      month_requests: 40,
      month_tokens_in: 90_000_000,
      month_tokens_out: 1_000_000,
      month_cost_microusd: 400_000
    }
  ],
  surfaces: [
    {
      surface: 'mobile',
      kind: 'chat',
      requests: 5,
      denied: 0,
      tokens_in: 100,
      tokens_out: 50,
      cost_microusd: 900
    }
  ],
  daily: [],
  devices: [],
  sessions: [],
  recent: [],
  counts: { conversations: 9, files: 3, bytes: 100 },
  ...over
})

function draw(node: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        <LocaleContext.Provider
          value={{ locale: 'en', isRtl: false, setLocale: async () => undefined }}
        >
          <ToastProvider>{node}</ToastProvider>
        </LocaleContext.Provider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  for (const m of [
    mockRoster,
    mockOverview,
    mockSetPlan,
    mockUpdateUser,
    mockResetPassword,
    mockRevokeSessions,
    mockClearPin,
    mockPush
  ]) {
    m.mockReset()
  }
  mockUser.role = 'owner'
  mockSetPlan.mockResolvedValue({ ok: true })
  mockUpdateUser.mockResolvedValue({ ok: true })
  mockRevokeSessions.mockResolvedValue({ ok: true, revoked: 3 })
  mockClearPin.mockResolvedValue({ ok: true })
})

describe('the people list', () => {
  it('shows the company and opens a person', async () => {
    mockRoster.mockResolvedValue(roster([person()]))
    draw(<AdminPeopleScreen />)

    await waitFor(() => expect(screen.getByText('Sam Employee')).toBeTruthy())
    // The row's second line is the phone's whole summary of a person.
    expect(screen.getByText(/Standard · 1\.6m · 6 days active/)).toBeTruthy()

    fireEvent.press(screen.getByText('Sam Employee'))
    expect(mockPush).toHaveBeenCalledWith('/settings/admin/person/usr_1')
  })

  it('filters by name without asking the org again', async () => {
    mockRoster.mockResolvedValue(roster([person(), person({ id: 'usr_2', name: 'Dana Admin' })]))
    draw(<AdminPeopleScreen />)
    await waitFor(() => expect(screen.getByText('Dana Admin')).toBeTruthy())

    fireEvent.changeText(screen.getByPlaceholderText('Search people'), 'dana')
    await waitFor(() => expect(screen.queryByText('Sam Employee')).toBeNull())
    expect(screen.getByText('Dana Admin')).toBeTruthy()
    // The roster is already here — filtering must not re-fetch the company.
    expect(mockRoster).toHaveBeenCalledTimes(1)
  })

  it('tells an employee there is nothing here, and asks the org nothing', async () => {
    mockUser.role = 'employee'
    draw(<AdminPeopleScreen />)
    await waitFor(() =>
      expect(screen.getByText('The admin page is available to owners and admins.')).toBeTruthy()
    )
    expect(mockRoster).not.toHaveBeenCalled()
  })
})

describe('one person', () => {
  it('shows the plan against the live gate counters', async () => {
    mockOverview.mockResolvedValue(overview())
    draw(<AdminPersonScreen />)

    await waitFor(() => expect(screen.getByText('sam@wolffi.sh')).toBeTruthy())
    // 90M of the 100M standard input ceiling — read from the GATE, which is
    // what the ceiling is actually enforced against, not from the rollup.
    expect(screen.getByText('90m / 100m')).toBeTruthy()
    expect(screen.getByText('100m in · 8m out per month')).toBeTruthy()
  })

  it('sends the plan the admin picked', async () => {
    mockOverview.mockResolvedValue(overview())
    draw(<AdminPersonScreen />)
    await waitFor(() => expect(screen.getByText('sam@wolffi.sh')).toBeTruthy())

    fireEvent.press(screen.getByText('High'))
    await waitFor(() => expect(mockSetPlan).toHaveBeenCalledWith('token', 'usr_1', 'high'))
  })

  it('confirms before disabling, and cancelling reaches the org with nothing', async () => {
    mockOverview.mockResolvedValue(overview())
    draw(<AdminPersonScreen />)
    await waitFor(() => expect(screen.getByText('sam@wolffi.sh')).toBeTruthy())

    fireEvent.press(screen.getByText('Disable'))
    // The consequence is spelled out before the tap that causes it.
    await waitFor(() => expect(screen.getByText('Disable access?')).toBeTruthy())
    expect(screen.getByText(/signed out everywhere immediately/)).toBeTruthy()
    expect(mockUpdateUser).not.toHaveBeenCalled()

    fireEvent.press(screen.getByText('Cancel'))
    await waitFor(() => expect(screen.queryByText('Disable access?')).toBeNull())
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('disables only after the confirmation is accepted', async () => {
    mockOverview.mockResolvedValue(overview())
    draw(<AdminPersonScreen />)
    await waitFor(() => expect(screen.getByText('sam@wolffi.sh')).toBeTruthy())

    fireEvent.press(screen.getByText('Disable'))
    await waitFor(() => expect(screen.getByText('Disable access?')).toBeTruthy())
    // The dialog's own confirm, not the row's button.
    fireEvent.press(screen.getAllByText('Disable')[1]!)
    await waitFor(() =>
      expect(mockUpdateUser).toHaveBeenCalledWith('token', 'usr_1', { status: 'suspended' })
    )
  })

  it('keeps the one-time password on screen after a reset', async () => {
    mockOverview.mockResolvedValue(overview())
    mockResetPassword.mockResolvedValue({
      user_id: 'usr_1',
      temp_password: 'plum-otter-9134',
      temp_password_expires_at: '2026-09-11T00:00:00.000Z'
    })
    draw(<AdminPersonScreen />)
    await waitFor(() => expect(screen.getByText('sam@wolffi.sh')).toBeTruthy())

    fireEvent.press(screen.getByText('Reset'))
    await waitFor(() => expect(screen.getByText('Reset password?')).toBeTruthy())
    fireEvent.press(screen.getAllByText('Reset')[1]!)

    // The org mints it once and never stores it in the clear: it has to stay
    // visible, not flash past in a toast.
    await waitFor(() => expect(screen.getByText('plum-otter-9134')).toBeTruthy())
  })

  it('gives the support tier the page without a single control it can press', async () => {
    mockUser.role = 'support'
    mockOverview.mockResolvedValue(overview())
    draw(<AdminPersonScreen />)
    await waitFor(() => expect(screen.getByText('sam@wolffi.sh')).toBeTruthy())

    expect(screen.getByText('Your tier can view this page but not change it.')).toBeTruthy()
    fireEvent.press(screen.getByText('Disable'))
    fireEvent.press(screen.getByText('High'))
    expect(screen.queryByText('Disable access?')).toBeNull()
    expect(mockUpdateUser).not.toHaveBeenCalled()
    expect(mockSetPlan).not.toHaveBeenCalled()
  })

  it('refuses an admin the controls on an owner, and says why', async () => {
    mockUser.role = 'admin'
    mockOverview.mockResolvedValue(overview({ user: { role: 'owner' } }))
    draw(<AdminPersonScreen />)
    await waitFor(() => expect(screen.getByText('sam@wolffi.sh')).toBeTruthy())

    expect(screen.getByText('Only an owner can change an owner.')).toBeTruthy()
    fireEvent.press(screen.getByText('Disable'))
    expect(screen.queryByText('Disable access?')).toBeNull()
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })
})
