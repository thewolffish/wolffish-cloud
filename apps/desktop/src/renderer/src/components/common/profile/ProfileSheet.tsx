/**
 * The user's profile — a slide-over sheet in the exact visual language of
 * the conversations sheet (same backdrop, same panel treatment, same edge),
 * mounted by FloatingChrome so it outlives the sidebar that opens it. The
 * content region scrolls, so the form can grow forever without pushing the
 * sheet out of view.
 *
 * Feedback contract:
 *  - API failures render ONE alert card above the form (chat-error voice:
 *    icon, message, wire detail) and the sheet scrolls to top so it is seen.
 *  - Client validation renders under the offending field and clears the
 *    moment that field is edited.
 *  - Success is a toast, never inline.
 *
 * Opens instantly and fetches nothing: the profile store is prefetched
 * the moment the session becomes ready, so seeding is a synchronous read.
 * If the store fills late (sheet opened within ms of sign-in), untouched
 * fields top up when it lands.
 * While anything is edited the sheet refuses to dismiss; the header's
 * "Discard changes" is the deliberate way out.
 */
import { Avatar } from '@components/common/profile/Avatar'
import {
  getProfileSnapshot,
  setAvatarLocal,
  setProfileLocal,
  useProfile
} from '@lib/profile/profileStore'
import { Button } from '@components/core/Button'
import { Modal } from '@components/core/Modal'
import { PasswordInput } from '@components/core/PasswordInput'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { isMac } from '@lib/utils/platform'
import { useFlow } from '@providers/flow/useFlow'
import { Alert02Icon, ImageUpload01Icon, Logout03Icon } from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Red validation border, layered onto any field whose error is showing. */
const fieldErrCls = 'border-red-500/70 focus:border-red-500/80 focus-visible:ring-red-500/30'

const fieldClass = cn(
  'border-border bg-bg text-fg placeholder:text-muted/60 w-full rounded-lg border px-3 py-2.5 text-sm',
  'focus:border-primary/60 outline-none focus-visible:ring-2 focus-visible:ring-accent'
)

/** The chat-error voice: icon, one-line message, wire detail underneath. */
function ErrorAlert({
  text,
  detail
}: {
  text: string | null
  detail?: string | null
}): React.JSX.Element | null {
  if (!text) return null
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5"
    >
      <Alert02Icon size={16} className="mt-0.5 shrink-0 text-red-500 dark:text-red-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug font-medium text-red-600 dark:text-red-400" dir="auto">
          {text}
        </p>
        {detail ? (
          <p className="text-muted mt-0.5 text-xs leading-snug break-words" dir="auto">
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** Under-field validation line. */
function FieldError({ text }: { text: string | undefined }): React.JSX.Element | null {
  if (!text) return null
  return (
    <p className="text-xs leading-snug text-red-500 dark:text-red-400" dir="auto">
      {text}
    </p>
  )
}

type FieldErrors = {
  name?: string
  position?: string
  phone?: string
  bio?: string
  currentPw?: string
  newPw?: string
  confirmPw?: string
  currentPin?: string
  newPin?: string
  avatar?: string
}

export function ProfileSheet({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { auth } = useFlow()
  const toast = useToast()
  const scrollerRef = useRef<HTMLDivElement>(null)

  const [baseline, setBaseline] = useState({ name: '', phone: '', position: '', bio: '' })
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [position, setPosition] = useState('')
  const [bio, setBio] = useState('')

  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')

  const [currentPin, setCurrentPin] = useState('')
  const [newPin, setNewPin] = useState('')

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [apiError, setApiError] = useState<{ text: string; detail?: string | null } | null>(null)
  const [busy, setBusy] = useState<null | 'profile' | 'password' | 'pin' | 'avatar'>(null)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  // Opening: seed during render (the canonical adjust-state-on-prop-change
  // pattern — instant paint, no effect round trip), then hydrate async.
  const [openSeed, setOpenSeed] = useState({ phone: '', position: '', bio: '' })
  const [seededOpen, setSeededOpen] = useState(false)
  if (open && !seededOpen) {
    setSeededOpen(true)
    const snap = getProfileSnapshot().profile
    const seedName = snap?.name ?? auth?.user?.name ?? ''
    const seed = snap
      ? { phone: snap.phone, position: snap.position, bio: snap.bio }
      : { phone: '', position: '', bio: '' }
    setOpenSeed(seed)
    setBaseline({ name: seedName, ...seed })
    setName(seedName)
    setPhone(seed.phone)
    setPosition(seed.position)
    setBio(seed.bio)
    setFieldErrors({})
    setApiError(null)
    setCurrentPw('')
    setNewPw('')
    setConfirmPw('')
    setCurrentPin('')
    setNewPin('')
    setConfirmSignOut(false)
    setSigningOut(false)
  }
  if (!open && seededOpen) setSeededOpen(false)

  // If the store fills AFTER the sheet opened (opened within ms of
  // sign-in), top up during render — untouched fields only.
  const { profile: storedProfile, avatar } = useProfile()
  const [hydratedFrom, setHydratedFrom] = useState<typeof storedProfile>(null)
  if (open && storedProfile && storedProfile !== hydratedFrom) {
    setHydratedFrom(storedProfile)
    const seed = openSeed
    const fresh = {
      phone: storedProfile.phone,
      position: storedProfile.position,
      bio: storedProfile.bio
    }
    setBaseline((b) => ({ ...b, ...fresh }))
    setPhone((cur) => (cur === seed.phone ? fresh.phone : cur))
    setPosition((cur) => (cur === seed.position ? fresh.position : cur))
    setBio((cur) => (cur === seed.bio ? fresh.bio : cur))
  }
  if (!open && hydratedFrom) setHydratedFrom(null)

  const photoInputRef = useRef<HTMLInputElement>(null)

  const pickPhoto = async (file: File): Promise<void> => {
    clearField('avatar')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setFieldErrors((f) => ({ ...f, avatar: t('profile.validation.photoType') }))
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setFieldErrors((f) => ({ ...f, avatar: t('profile.validation.photoTooLarge') }))
      return
    }
    setBusy('avatar')
    setApiError(null)
    try {
      const bytes = await file.arrayBuffer()
      const result = await window.api.auth.setAvatar(bytes, file.type)
      if (!result.ok) {
        showApiError(result.code ?? null, result.detail)
        return
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('read_failed'))
        reader.readAsDataURL(file)
      })
      setAvatarLocal(dataUrl)
      toast.show({ message: t('profile.photoUpdated'), tone: 'success' })
    } finally {
      setBusy(null)
    }
  }

  const removePhoto = async (): Promise<void> => {
    setBusy('avatar')
    setApiError(null)
    try {
      const result = await window.api.auth.removeAvatar()
      if (!result.ok) {
        showApiError(result.code ?? null, result.detail)
        return
      }
      setAvatarLocal(null)
      toast.show({ message: t('profile.photoRemoved'), tone: 'success' })
    } finally {
      setBusy(null)
    }
  }

  const dirty =
    name.trim() !== baseline.name.trim() ||
    phone.trim() !== baseline.phone.trim() ||
    position.trim() !== baseline.position.trim() ||
    bio.trim() !== baseline.bio.trim() ||
    currentPw.length > 0 ||
    newPw.length > 0 ||
    confirmPw.length > 0 ||
    currentPin.length > 0 ||
    newPin.length > 0

  // Escape mirrors the conversations sheet — but a dirty sheet stays put.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !dirty && !confirmSignOut) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dirty, onClose, confirmSignOut])

  const discard = (): void => {
    setName(baseline.name)
    setPhone(baseline.phone)
    setPosition(baseline.position)
    setBio(baseline.bio)
    setCurrentPw('')
    setNewPw('')
    setConfirmPw('')
    setCurrentPin('')
    setNewPin('')
    setFieldErrors({})
    setApiError(null)
    onClose()
  }

  const clearField = (key: keyof FieldErrors): void =>
    setFieldErrors((f) => (f[key] ? { ...f, [key]: undefined } : f))

  const err = (code: string | null): string =>
    code &&
    [
      'invalid_credentials',
      'wrong_password',
      'weak_password',
      'pin_wrong',
      'pin_format',
      'network'
    ].includes(code)
      ? t(`auth.errors.${code}`)
      : t('auth.errors.generic')

  const showApiError = (code: string | null, detail?: string | null): void => {
    setApiError({ text: err(code), detail })
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const saveProfile = async (): Promise<void> => {
    const errors: FieldErrors = {}
    if (name.trim().length === 0) errors.name = t('profile.validation.nameRequired')
    else if (name.trim().length > 200) errors.name = t('profile.validation.nameLong')
    if (position.trim().length > 120) errors.position = t('profile.validation.positionLong')
    if (!/^[+0-9 ()-]*$/.test(phone.trim())) errors.phone = t('profile.validation.phoneFormat')
    else if (phone.trim().length > 32) errors.phone = t('profile.validation.phoneLong')
    if (bio.trim().length > 500) errors.bio = t('profile.validation.bioLong')
    if (Object.values(errors).some(Boolean)) {
      setFieldErrors((f) => ({ ...f, ...errors }))
      return
    }
    setBusy('profile')
    setApiError(null)
    try {
      const state = await window.api.auth.updateProfile({
        name: name.trim(),
        phone: phone.trim(),
        position: position.trim(),
        bio: bio.trim()
      })
      if (state.lastError) {
        showApiError(state.lastError, state.lastErrorDetail)
      } else {
        setProfileLocal({
          name: name.trim(),
          phone: phone.trim(),
          position: position.trim(),
          bio: bio.trim()
        })
        setBaseline({
          name: name.trim(),
          phone: phone.trim(),
          position: position.trim(),
          bio: bio.trim()
        })
        toast.show({ message: t('profile.saved'), tone: 'success' })
      }
    } finally {
      setBusy(null)
    }
  }

  const changePassword = async (): Promise<void> => {
    const errors: FieldErrors = {}
    if (currentPw.length === 0) errors.currentPw = t('profile.validation.currentRequired')
    if (newPw.length < 10) errors.newPw = t('auth.errors.weak_password')
    if (confirmPw !== newPw) errors.confirmPw = t('auth.change.mismatch')
    if (Object.values(errors).some(Boolean)) {
      setFieldErrors((f) => ({ ...f, ...errors }))
      return
    }
    setBusy('password')
    setApiError(null)
    try {
      const state = await window.api.auth.changePasswordSelf(currentPw, newPw)
      if (state.lastError) {
        showApiError(state.lastError, state.lastErrorDetail)
      } else {
        setCurrentPw('')
        setNewPw('')
        setConfirmPw('')
        toast.show({ message: t('profile.passwordChanged'), tone: 'success' })
      }
    } finally {
      setBusy(null)
    }
  }

  const changePin = async (): Promise<void> => {
    const errors: FieldErrors = {}
    if (currentPin.length !== 4) errors.currentPin = t('auth.errors.pin_format')
    if (newPin.length !== 4) errors.newPin = t('auth.errors.pin_format')
    if (Object.values(errors).some(Boolean)) {
      setFieldErrors((f) => ({ ...f, ...errors }))
      return
    }
    setBusy('pin')
    setApiError(null)
    try {
      const state = await window.api.auth.changePin(currentPin, newPin)
      if (state.lastError) {
        showApiError(state.lastError, state.lastErrorDetail)
      } else {
        setCurrentPin('')
        setNewPin('')
        toast.show({ message: t('profile.pinChanged'), tone: 'success' })
      }
    } finally {
      setBusy(null)
    }
  }

  if (!open || !auth?.user) return null
  const user = auth.user

  return (
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden
        onClick={dirty ? undefined : onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t('profile.title')}
        className={cn(
          'wf-sheet-panel bg-bg border-border/40 absolute inset-y-0 start-0 flex w-[520px] max-w-[92vw] flex-col border-e'
        )}
      >
        <header
          className={cn(
            'flex shrink-0 items-center justify-between gap-3 px-5 pb-3',
            isMac ? 'pt-12' : 'pt-6'
          )}
        >
          <h2 className="text-fg text-lg font-semibold tracking-tight">{t('profile.title')}</h2>
          {dirty && (
            <button
              type="button"
              onClick={discard}
              className="border-border text-muted hover:text-fg hover:bg-border/40 cursor-pointer rounded-lg border px-3 py-1 text-xs font-medium"
            >
              {t('profile.discard')}
            </button>
          )}
        </header>

        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-10">
          <div className="flex flex-col gap-5">
            <ErrorAlert text={apiError?.text ?? null} detail={apiError?.detail} />

            <div className="flex items-center gap-3">
              <Avatar name={user.name} size={48} src={avatar} />
              <div className="min-w-0 flex-1">
                <p className="text-fg truncate text-sm font-semibold">{user.name}</p>
                <p className="text-muted truncate text-xs" dir="ltr">
                  {user.email}
                </p>
                <p className="text-muted truncate text-xs">
                  {user.role}
                  {auth.orgName ? ` · ${auth.orgName}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmSignOut(true)}
                className={cn(
                  'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium',
                  'border-red-500/40 bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-400',
                  'focus-visible:ring-2 focus-visible:ring-accent'
                )}
              >
                <Logout03Icon size={14} />
                {t('profile.signOut')}
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (file) void pickPhoto(file)
                  }}
                />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => photoInputRef.current?.click()}
                  className="border-border text-fg hover:bg-border/40 flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ImageUpload01Icon size={14} />
                  {t('profile.uploadPhoto')}
                </button>
                {avatar && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void removePhoto()}
                    className="text-muted hover:text-fg cursor-pointer rounded-lg px-2 py-1.5 text-xs font-medium underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('profile.removePhoto')}
                  </button>
                )}
              </div>
              <FieldError text={fieldErrors.avatar} />
            </div>

            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                void saveProfile()
              }}
            >
              <h3 className="text-muted text-[10px] font-medium tracking-wide uppercase">
                {t('profile.sectionProfile')}
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-muted text-xs">{t('profile.name')}</span>
                  <input
                    className={cn(fieldClass, fieldErrors.name && fieldErrCls)}
                    aria-invalid={fieldErrors.name ? true : undefined}
                    value={name}
                    maxLength={200}
                    onChange={(e) => {
                      setName(e.target.value)
                      clearField('name')
                    }}
                  />
                  <FieldError text={fieldErrors.name} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-muted text-xs">{t('profile.position')}</span>
                  <input
                    className={cn(fieldClass, fieldErrors.position && fieldErrCls)}
                    aria-invalid={fieldErrors.position ? true : undefined}
                    value={position}
                    maxLength={120}
                    placeholder={t('profile.positionPlaceholder')}
                    onChange={(e) => {
                      setPosition(e.target.value)
                      clearField('position')
                    }}
                  />
                  <FieldError text={fieldErrors.position} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-muted text-xs">{t('profile.email')}</span>
                  <input
                    className={cn(fieldClass, 'opacity-60')}
                    value={user.email}
                    disabled
                    readOnly
                    dir="ltr"
                    title={t('profile.emailLocked')}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-muted text-xs">{t('profile.phone')}</span>
                  <input
                    className={cn(fieldClass, fieldErrors.phone && fieldErrCls)}
                    aria-invalid={fieldErrors.phone ? true : undefined}
                    value={phone}
                    maxLength={32}
                    placeholder="+966 5x xxx xxxx"
                    inputMode="tel"
                    dir="ltr"
                    onChange={(e) => {
                      setPhone(e.target.value)
                      clearField('phone')
                    }}
                  />
                  <FieldError text={fieldErrors.phone} />
                </label>
                <label className="col-span-2 flex flex-col gap-1.5">
                  <span className="text-muted text-xs">
                    {t('profile.bio')}
                    <span className="text-muted/60"> · {bio.trim().length}/500</span>
                  </span>
                  <textarea
                    className={cn(fieldClass, 'min-h-20 resize-y leading-relaxed')}
                    value={bio}
                    maxLength={500}
                    placeholder={t('profile.bioPlaceholder')}
                    onChange={(e) => {
                      setBio(e.target.value)
                      clearField('bio')
                    }}
                  />
                  <FieldError text={fieldErrors.bio} />
                </label>
              </div>
              <Button type="submit" className="self-end" disabled={busy !== null}>
                {t('profile.save')}
              </Button>
            </form>

            <form
              className="border-border/60 flex flex-col gap-4 border-t pt-5"
              onSubmit={(e) => {
                e.preventDefault()
                void changePassword()
              }}
            >
              <h3 className="text-muted text-[10px] font-medium tracking-wide uppercase">
                {t('profile.sectionPassword')}
              </h3>
              <div className="flex flex-col gap-1.5">
                <PasswordInput
                  value={currentPw}
                  onChange={(v) => {
                    setCurrentPw(v)
                    clearField('currentPw')
                  }}
                  placeholder={t('profile.currentPassword')}
                  autoComplete="current-password"
                  invalid={Boolean(fieldErrors.currentPw)}
                />
                <FieldError text={fieldErrors.currentPw} />
              </div>
              <div className="flex flex-col gap-1.5">
                <PasswordInput
                  value={newPw}
                  onChange={(v) => {
                    setNewPw(v)
                    clearField('newPw')
                  }}
                  placeholder={t('auth.change.newPassword')}
                  autoComplete="new-password"
                  invalid={Boolean(fieldErrors.newPw)}
                />
                <FieldError text={fieldErrors.newPw} />
              </div>
              <div className="flex flex-col gap-1.5">
                <PasswordInput
                  value={confirmPw}
                  onChange={(v) => {
                    setConfirmPw(v)
                    clearField('confirmPw')
                  }}
                  placeholder={t('auth.change.confirmPassword')}
                  autoComplete="new-password"
                  invalid={Boolean(fieldErrors.confirmPw)}
                />
                <FieldError text={fieldErrors.confirmPw} />
              </div>
              <Button type="submit" className="self-end" disabled={busy !== null}>
                {t('profile.changePassword')}
              </Button>
            </form>

            <form
              className="border-border/60 flex flex-col gap-4 border-t pt-5"
              onSubmit={(e) => {
                e.preventDefault()
                void changePin()
              }}
            >
              <h3 className="text-muted text-[10px] font-medium tracking-wide uppercase">
                {t('profile.sectionPin')}
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    className={cn(
                      fieldClass,
                      'text-center tracking-[0.4em]',
                      fieldErrors.currentPin && fieldErrCls
                    )}
                    aria-invalid={fieldErrors.currentPin ? true : undefined}
                    value={currentPin}
                    placeholder={t('profile.currentPin')}
                    onChange={(e) => {
                      setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 4))
                      clearField('currentPin')
                    }}
                    dir="ltr"
                  />
                  <FieldError text={fieldErrors.currentPin} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    className={cn(
                      fieldClass,
                      'text-center tracking-[0.4em]',
                      fieldErrors.newPin && fieldErrCls
                    )}
                    aria-invalid={fieldErrors.newPin ? true : undefined}
                    value={newPin}
                    placeholder={t('profile.newPin')}
                    onChange={(e) => {
                      setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))
                      clearField('newPin')
                    }}
                    dir="ltr"
                  />
                  <FieldError text={fieldErrors.newPin} />
                </div>
              </div>
              <Button type="submit" className="self-end" disabled={busy !== null}>
                {t('profile.changePin')}
              </Button>
            </form>
          </div>
        </div>
      </aside>

      <Modal
        open={confirmSignOut}
        onClose={() => setConfirmSignOut(false)}
        dismissable={!signingOut}
        title={t('profile.signOutTitle')}
        footer={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmSignOut(false)}
              disabled={signingOut}
              className="flex-1"
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true)
                // Auth flips to loggedOut and FlowProvider swaps in the
                // sign-in screen, unmounting this whole layer.
                void window.api.auth.signOut()
              }}
              className="flex-1 border border-transparent bg-red-600 text-white shadow-none hover:bg-red-700"
            >
              {t('profile.signOut')}
            </Button>
          </div>
        }
      >
        <p className="text-muted">{t('profile.signOutBody')}</p>
      </Modal>
    </div>
  )
}
