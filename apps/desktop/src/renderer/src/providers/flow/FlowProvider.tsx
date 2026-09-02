import { clearProfile, prefetchProfile, setAvatarLocal } from '@lib/profile/profileStore'
import type { AuthState, DataAnalytics, SystemInfo, WorkspaceStatus } from '@preload/index'
import { FlowContext, type FlowContextValue, type Screen } from '@providers/flow/useFlow'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

// 5 GiB. Anything below this and Wolffish can't pull a model, persist
// conversations, or breathe — warn on every launch. The warning is
// dismissible: once the user closes it they proceed at their own risk,
// and any disk-full errors downstream are on them.
export const MIN_FREE_DISK_BYTES = 5 * 1024 ** 3

export function FlowProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [screen, setScreen] = useState<Screen>('auth')
  const [returnTo, setReturnTo] = useState<Screen | null>(null)
  const [ready, setReady] = useState(false)
  const [dataAnalytics, setDataAnalytics] = useState<DataAnalytics | null>(null)
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)

  // Session-only dismissal of the low-disk warning. A ref (not state) so
  // decideInitialScreen keeps a stable identity — it resets on relaunch,
  // which is exactly the contract: warn once per startup, then stay out
  // of the way for the rest of the session.
  const diskGateDismissedRef = useRef(false)

  const decideInitialScreen = useCallback(async (): Promise<{
    screen: Screen
    status: WorkspaceStatus
    auth: AuthState
  }> => {
    const s = await window.api.workspace.getStatus()

    // -1. The cloud session gates everything: until it is ready, the only
    //     screen is the auth gate (splash → sign in → change → PIN).
    const a = await window.api.auth.getState()
    if (a.status !== 'ready') {
      return { screen: 'auth' as Screen, status: s, auth: a }
    }

    // 0. Free disk warning. If we can't read free disk (null), don't block —
    //    let the user through and surface real errors downstream rather
    //    than stranding them on a warning they can't dismiss. Skipped once
    //    the user has dismissed it this session — they were warned.
    const sys = await window.api.system.getInfo()
    if (
      !diskGateDismissedRef.current &&
      sys.freeDiskBytes != null &&
      sys.freeDiskBytes < MIN_FREE_DISK_BYTES
    ) {
      return { screen: 'low-disk-space' as Screen, status: s, auth: a }
    }

    // Onboarding incomplete → welcome (theme/locale); otherwise straight to
    // chat. Model availability is the org API's concern — sign-in and the
    // server-driven catalog land with the auth + API integration phases.
    if (!s.onboardingCompleted) {
      return { screen: 'welcome' as Screen, status: s, auth: a }
    }
    return { screen: 'chat' as Screen, status: s, auth: a }
  }, [])

  // Live auth transitions: a session becoming ready leaves the gate via
  // the normal initial-screen decision; losing it (sign-out, revocation,
  // PIN lockout) drops every surface back to the gate immediately.
  const screenRef = useRef<Screen>('auth')
  useEffect(() => {
    screenRef.current = screen
  }, [screen])
  // Avatar revalidations (an update or removal, here or on another device)
  // land in the profile store so the sheet and sidebar card stay current.
  useEffect(() => {
    return window.api.auth.onAvatarChanged((dataUrl) => setAvatarLocal(dataUrl))
  }, [])
  useEffect(() => {
    return window.api.auth.onChanged((state) => {
      setAuth(state)
      if (state.status === 'ready') {
        prefetchProfile()
        if (screenRef.current === 'auth') {
          void decideInitialScreen().then((r) => {
            setAuth(r.auth)
            setStatus(r.status)
            setScreen(r.screen)
          })
        }
      } else if (state.status !== 'initializing') {
        clearProfile()
        setScreen('auth')
      }
    })
  }, [decideInitialScreen])

  useEffect(() => {
    let cancelled = false
    void Promise.all([decideInitialScreen(), window.api.system.getInfo()]).then(([r, sys]) => {
      if (cancelled) return
      setAuth(r.auth)
      if (r.auth.status === 'ready') prefetchProfile()
      setStatus(r.status)
      setScreen(r.screen)
      setSystemInfo(sys)
      setReady(true)
    })
    // Analytics feed only the Data panel, but getAnalytics() walks the whole
    // workspace and then sits out a 250ms CPU sample — first paint must not
    // wait on that. Land it whenever it lands; DataPanel renders a skeleton
    // until it does.
    void window.api.data.getAnalytics().then((analytics) => {
      if (!cancelled) setDataAnalytics(analytics)
    })
    return () => {
      cancelled = true
    }
  }, [decideInitialScreen])

  const refreshStatus = useCallback(async () => {
    const s = await window.api.workspace.getStatus()
    setStatus(s)
  }, [])

  const refreshData = useCallback(async () => {
    const [analytics, sys] = await Promise.all([
      window.api.data.getAnalytics(),
      window.api.system.getInfo()
    ])
    setDataAnalytics(analytics)
    setSystemInfo(sys)
  }, [])

  const goTo = useCallback((next: Screen, ret?: Screen | null) => {
    if (ret !== undefined) setReturnTo(ret)
    setScreen(next)
  }, [])

  const revalidateScreen = useCallback(async () => {
    const r = await decideInitialScreen()
    setStatus(r.status)
    setScreen(r.screen)
  }, [decideInitialScreen])

  const dismissDiskGate = useCallback(async () => {
    diskGateDismissedRef.current = true
    await revalidateScreen()
  }, [revalidateScreen])

  const value = useMemo<FlowContextValue>(
    () => ({
      screen,
      auth,
      status,
      dataAnalytics,
      systemInfo,
      refreshData,
      goTo,
      returnTo,
      refreshStatus,
      revalidateScreen,
      dismissDiskGate
    }),
    [
      screen,
      auth,
      status,
      dataAnalytics,
      systemInfo,
      refreshData,
      goTo,
      returnTo,
      refreshStatus,
      revalidateScreen,
      dismissDiskGate
    ]
  )

  if (!ready) return <div className="bg-bg h-full w-full" aria-hidden />

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>
}
