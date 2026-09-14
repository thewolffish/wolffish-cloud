/**
 * The sign-in gate, daemon side.
 *
 * The window cannot send a message while signed out: AuthGate.tsx covers the
 * chat until the session is `ready`. A terminal has no such screen, and a
 * turn started signed out would fail deep inside the model lane with
 * "authentication failed" — true, unhelpful, and a step late. So `cli:send`
 * refuses up front, naming the command that fixes it. The wording mirrors
 * src/cli/lib/auth.mjs (the client's own gate) so the two surfaces agree.
 */
import type { AuthStatus } from '@main/cloud/session'

export function authGateMessage(status: AuthStatus): string | null {
  switch (status) {
    case 'ready':
      return null
    case 'locked':
      return 'locked — unlock with your PIN: wfc unlock'
    case 'needsPin':
      return 'finish signing in (create your PIN): wfc login'
    case 'mustChangePassword':
      return 'finish signing in (set a new password): wfc login'
    case 'initializing':
      return 'the session is still starting — try again in a moment'
    default:
      return 'not signed in: wfc login'
  }
}
