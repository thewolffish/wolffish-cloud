/**
 * Account activation — the one place an invite code is minted, stored and
 * mailed, because two routers need it: an admin adding a person
 * (routes/admin.ts) and the person themselves asking for a fresh code
 * (routes/auth.ts).
 *
 * The code is what makes the invite self-serve. Before it, adding someone
 * minted a temp password that came back to the admin to pass along by hand:
 * a real credential travelling over chat or a sticky note, and no proof the
 * address was even the person's. Now the only thing that reaches anyone is
 * a 6-digit code sent to the address itself, and it buys exactly one thing —
 * the right to set a password on an account that has none yet.
 *
 * Consuming the code lives in routes/auth.ts beside the reset flow's
 * equivalent: same shape (delete first, then write the password), same
 * reason (a used code must be dead before the new password is usable).
 */
import { sixDigitCode } from '@/lib/crypto'
import { sendSystemEmail, type EmailResult } from '@/lib/email'
import type { Env } from '@/index'

/** How long an invite is good for — the window invites have always had. */
export const ACTIVATION_TTL_DAYS = 7

/** Wrong guesses before the code is burnt. Looser than a reset's 5: this
 *  one has to survive a week of being typed from a phone screen. */
export const ACTIVATION_MAX_ATTEMPTS = 10

/**
 * Mint a code for this user and make it the only live one — a re-send
 * invalidates whatever was sent before, so a forwarded old email is dead
 * rather than a second working key.
 */
export async function issueActivation(
  env: Env,
  userId: string
): Promise<{ code: string; expiresAt: string }> {
  const code = sixDigitCode()
  const expiresAt = new Date(Date.now() + ACTIVATION_TTL_DAYS * 86_400_000).toISOString()
  await env.DB.prepare(
    `INSERT INTO account_activations (user_id, code, attempts, expires_at) VALUES (?1, ?2, 0, ?3)
     ON CONFLICT(user_id) DO UPDATE SET code = excluded.code, attempts = 0,
       expires_at = excluded.expires_at, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  )
    .bind(userId, code, expiresAt)
    .run()
  return { code, expiresAt }
}

export async function sendActivationEmail(
  env: Env,
  user: { email: string; name: string },
  code: string,
  orgName: string
): Promise<EmailResult> {
  const first = user.name.trim().split(/\s+/)[0] ?? ''
  return sendSystemEmail(env, {
    to: user.email,
    subject: `${code} is your Wolffish Cloud activation code`,
    heading: 'Activate your account',
    lines: [
      `${first ? `Hi ${first}, an` : 'An'} account was created for you on ${orgName}.`,
      // The wording quotes the sign-in screen's link verbatim — a first-time
      // user should be hunting for the exact words this email gave them.
      'Open Wolffish Cloud, choose "Have an activation code?", and enter this code to set your password. It expires in 7 days.',
      'If you were not expecting this, you can ignore this email — the account cannot be used until the code is entered.'
    ],
    code
  })
}

/** An invite is gone the moment the account is activated by any route —
 *  an admin-issued temp password or a password reset both do it — so a
 *  stale code can never set a second password later. */
export async function dropActivation(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM account_activations WHERE user_id = ?1').bind(userId).run()
}
