// TEMPORARY harness — deleted after the visual check.
import '@lib/i18n'
import './assets/main.css'
import { InviteSheet } from '@pages/settings/admin/InviteSheet'
import { LocaleContext } from '@providers/locale/useLocale'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'

;(window as unknown as { api: unknown }).api = {
  admin: {
    invite: async (input: { email: string }) => {
      await new Promise((r) => setTimeout(r, 300))
      return {
        user_id: 'usr_preview',
        email: input.email,
        role: 'employee',
        activation_expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        email_sent: true
      }
    }
  }
}

function Harness(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  ;(window as unknown as { __open: boolean }).__open = open
  return (
    <div className="bg-bg text-fg min-h-screen p-10">
      <p className="text-muted text-sm">sheet open: {String(open)}</p>
      <button className="border-border mt-4 rounded-lg border px-4 py-2 text-sm" onClick={() => setOpen(true)}>
        Add person
      </button>
      <LocaleContext.Provider value={{ locale: 'en', setLocale: async () => undefined }}>
        <InviteSheet open={open} onClose={() => setOpen(false)} onInvited={() => undefined} />
      </LocaleContext.Provider>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
