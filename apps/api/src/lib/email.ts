/**
 * Email relay — one generic seam over Resend for everything the platform
 * sends. System mail (password resets, invites) goes through the branded
 * template helpers; future agentic mail calls `sendEmail` directly with
 * its own content. Nothing else in the codebase talks to Resend.
 *
 * The sending domain (wolffi.sh) is verified in Resend; the API key lives
 * in the RESEND_API_KEY worker secret. Client forks swap FROM + secret.
 */
import type { Env } from '@/index'

const FROM = 'Wolffish Cloud <system@wolffi.sh>'
const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export type EmailResult =
  | { ok: true; id: string }
  | { ok: false; code: 'email_not_configured' | 'email_send_failed'; detail?: string }

export async function sendEmail(
  env: Env,
  msg: { to: string; subject: string; html: string; text?: string; from?: string }
): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) return { ok: false, code: 'email_not_configured' }
  let res: Response
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from: msg.from ?? FROM,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        ...(msg.text ? { text: msg.text } : {})
      })
    })
  } catch {
    return { ok: false, code: 'email_send_failed', detail: 'network error reaching Resend' }
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const detail =
      typeof json?.message === 'string' ? json.message : `resend responded ${res.status}`
    return { ok: false, code: 'email_send_failed', detail }
  }
  return { ok: true, id: typeof json?.id === 'string' ? json.id : '' }
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The one system-mail look: minimal and quiet — wordmark, a line or two,
 * and when there is a code, the code front and center in a plain block
 * whose text is exactly the digits, so a copy grabs nothing else.
 */
export function systemEmailHtml(input: {
  heading: string
  lines: string[]
  code?: string
  footer?: string
}): string {
  const code = input.code
    ? `<div style="margin:24px 0;padding:20px;background:#f4f4f5;border-radius:12px;text-align:center;"><span style="font-size:36px;font-weight:700;letter-spacing:0.25em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#18181b;">${esc(input.code)}</span></div>`
    : ''
  const lines = input.lines
    .map(
      (l) =>
        `<p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#52525b;">${esc(l)}</p>`
    )
    .join('')
  const footer = esc(input.footer ?? 'Wolffish Cloud — sent by the system, no reply needed.')
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
  <div style="max-width:440px;margin:0 auto;padding:48px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="font-size:15px;font-weight:700;color:#18181b;margin-bottom:28px;">Wolffish <span style="background:#fce7f3;color:#be185d;border-radius:6px;padding:1px 7px;font-size:12px;font-weight:600;">cloud</span></div>
    <h1 style="margin:0 0 12px;font-size:17px;color:#18181b;">${esc(input.heading)}</h1>
    ${lines}
    ${code}
    <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;">${footer}</p>
  </div>
</body></html>`
}

export async function sendSystemEmail(
  env: Env,
  input: { to: string; subject: string; heading: string; lines: string[]; code?: string }
): Promise<EmailResult> {
  return sendEmail(env, {
    to: input.to,
    subject: input.subject,
    html: systemEmailHtml(input),
    text: [...input.lines, input.code ?? ''].filter(Boolean).join('\n\n')
  })
}
