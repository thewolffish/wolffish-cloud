import { Button } from '@components/core/Button'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { MobilePairedPhone, MobileStatus } from '@preload/index'
import {
  AndroidIcon,
  AppleIcon,
  Copy01Icon,
  Globe02Icon,
  Key01Icon,
  KeyboardIcon,
  LinkSquare02Icon,
  PlugSocketIcon,
  QrCode01Icon,
  RefreshIcon,
  SmartPhone01Icon,
  Tick02Icon,
  Unlink01Icon
} from 'hugeicons-react'
import QRCode from 'qrcode'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Mobile — the phone as a companion surface, managed like any other channel.
 *
 * There is no token to paste: this desktop OFFERS a pairing (a QR or a short
 * code the org mints) and the phone claims it, becoming a signed-in device
 * of the same org account. From then on the phone reads everything — the
 * conversations, settings, files and usage — straight from the org, and only
 * live turns travel through this desktop, over the org bridge. So the panel
 * is a list of paired phones, the way to add one, and the bridge's own
 * health: never a form, never a key.
 *
 * Module-level snapshot cache: the panel is eagerly imported by Settings, so
 * the status is already in memory by the time the user opens it and paints
 * on the first frame.
 */
/**
 * One phone at a time — a UI decision, not a limit of the org.
 *
 * The organization pairs as many phones as you like: each holds its own
 * session, the bridge fans every event out to all of them, and unpairing one
 * leaves the rest alone. The panel still offers a pairing only while NO phone
 * is paired, because an offer sitting next to a live phone reads as "replace
 * this one" and would quietly add a second — the desktop app has always meant
 * "your phone", singular. Unpair to pair a different handset.
 *
 * Flip this to false and the multi-phone controls come back; nothing else
 * needs to change.
 */
const SINGLE_PHONE = true

let cachedStatus: MobileStatus | null = null
let loadPromise: Promise<MobileStatus | null> | null = null

function loadStatus(): Promise<MobileStatus | null> {
  if (cachedStatus) return Promise.resolve(cachedStatus)
  const api = window.api?.mobile
  if (!api) return Promise.resolve(null) // preload not ready; the mount effect retries
  if (!loadPromise) {
    loadPromise = api
      .status()
      .then((status) => {
        cachedStatus = status
        return cachedStatus
      })
      .catch(() => null)
      .finally(() => {
        loadPromise = null
      })
  }
  return loadPromise
}

void loadStatus()

// Keep the cache warm while the panel is closed so reopening paints live state.
window.api?.mobile?.onStatusChange((status) => {
  cachedStatus = status
})

const STATUS_DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500',
  reconnecting: 'bg-amber-500',
  error: 'bg-rose-500',
  idle: 'bg-border'
}

export function MobilePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [status, setStatus] = useState<MobileStatus | null>(cachedStatus)
  // The rendered QR, remembered with the payload it was drawn from — so the
  // image can only ever show the CURRENT offer (a stale one reads as absent)
  // without resetting state inside the effect that draws it.
  const [qrFor, setQrFor] = useState<{ payload: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const loaded = status !== null

  useEffect(() => {
    let alive = true
    void loadStatus().then((next) => {
      if (alive && next) setStatus(next)
    })
    const off = window.api?.mobile?.onStatusChange((next) => {
      if (alive) setStatus(next)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  // Render the pairing payload as a QR whenever an offer is open. Encoded
  // with error-correction M — the phone's camera reads it off this screen.
  const payload = status?.offer?.payload ?? null
  useEffect(() => {
    if (!payload) return
    let alive = true
    void QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
      .then((url) => {
        if (alive) setQrFor({ payload, url })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [payload])
  const qr = payload && qrFor?.payload === payload ? qrFor.url : null

  const offer = status?.offer ?? null
  const bridge = status?.bridge ?? null
  const phones = status?.phones ?? []
  // An offer already open always stays on screen — including the one being
  // claimed right now, which is how the card turns into a phone.
  const canPair = !SINGLE_PHONE || phones.length === 0

  // Ticks once a second while an offer is open so its countdown reads true.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!offer) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [offer])

  const act = useCallback(
    async (fn: () => Promise<MobileStatus>): Promise<void> => {
      setBusy(true)
      try {
        setStatus(await fn())
      } catch {
        toast.show({ tone: 'error', message: t('settings.mobile.offerFailed') })
      } finally {
        setBusy(false)
      }
    },
    [t, toast]
  )

  const copyCode = (): void => {
    if (!offer?.code) return
    void navigator.clipboard.writeText(offer.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const toggleOptions = useMemo(
    () => [
      { value: false, label: t('settings.mobile.toggle.off') },
      { value: true, label: t('settings.mobile.toggle.on') }
    ],
    [t]
  )
  const verbose = status?.verbose ?? null
  const runCards = status?.runCards ?? null

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.mobile.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">{t('settings.mobile.description')}</p>
        </header>

        {/* Paired phones, each its own row; below them the way to add one. */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          {status?.paired ? (
            <div className="flex flex-col gap-5">
              <span className="text-fg text-sm font-medium">{t('settings.mobile.phones')}</span>
              {phones.map((phone, index) => (
                <Fragment key={phone.id}>
                  {index > 0 && <div className="border-border/60 border-t" />}
                  <PhoneRow
                    phone={phone}
                    busy={busy || !loaded}
                    onUnpair={() => void act(() => window.api.mobile.unpair(phone.id))}
                  />
                </Fragment>
              ))}
            </div>
          ) : (
            !offer && (
              <p className="text-muted text-sm leading-relaxed">{t('settings.mobile.notPaired')}</p>
            )
          )}

          {status?.paired && <div className="border-border/60 border-t" />}

          {offer ? (
            <div className="flex flex-col items-center gap-4">
              {offer.mode === 'qr' ? (
                qr ? (
                  <img
                    src={qr}
                    alt={t('settings.mobile.qrAlt')}
                    width={240}
                    height={240}
                    className="rounded-xl bg-white p-3"
                  />
                ) : (
                  <div className="bg-border/30 size-60 animate-pulse rounded-xl" />
                )
              ) : (
                <button
                  type="button"
                  onClick={copyCode}
                  title={t('common.copy')}
                  className={cn(
                    'text-fg flex items-center gap-3 rounded-xl px-6 py-4 font-mono text-3xl tracking-[0.2em]',
                    'bg-bg border-border hover:border-fg/30 border',
                    'focus-visible:ring-accent focus-visible:ring-offset-bg focus-visible:ring-2 focus-visible:ring-offset-2'
                  )}
                >
                  <span dir="ltr">{offer.code}</span>
                  {copied ? (
                    <Tick02Icon size={18} className="text-emerald-500" />
                  ) : (
                    <Copy01Icon size={18} className="text-muted" />
                  )}
                </button>
              )}
              <p className="text-muted max-w-sm text-center text-xs leading-relaxed">
                {offer.mode === 'qr'
                  ? t('settings.mobile.scanHint')
                  : t('settings.mobile.codeHint')}
              </p>
              <p className="text-muted text-xs">
                {t('settings.mobile.expires', {
                  minutes: Math.max(1, Math.round((offer.expiresAt - now) / 60000))
                })}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      offer.mode === 'qr'
                        ? window.api.mobile.offerQr()
                        : window.api.mobile.offerCode()
                    )
                  }
                >
                  <RefreshIcon size={14} />
                  {t('settings.mobile.newCode')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(() => window.api.mobile.cancelOffer())}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : !canPair ? (
            <p className="text-muted text-sm leading-relaxed">
              {t('settings.mobile.singlePhoneHint')}
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              {status?.paired && (
                <span className="text-fg text-sm font-medium">
                  {t('settings.mobile.pairAnother')}
                </span>
              )}
              <ActionRow
                icon={<QrCode01Icon size={18} className="text-muted mt-0.5 shrink-0" />}
                title={t('settings.mobile.qrTitle')}
                body={t('settings.mobile.qrDesc')}
                action={
                  <Button
                    disabled={busy || !loaded}
                    className="shrink-0"
                    onClick={() => void act(() => window.api.mobile.offerQr())}
                  >
                    {t('settings.mobile.generate')}
                  </Button>
                }
              />
              <div className="border-border/60 border-t" />
              <ActionRow
                icon={<KeyboardIcon size={18} className="text-muted mt-0.5 shrink-0" />}
                title={t('settings.mobile.codeTitle')}
                body={t('settings.mobile.codeDesc')}
                action={
                  <Button
                    variant="outline"
                    disabled={busy || !loaded}
                    className="shrink-0"
                    onClick={() => void act(() => window.api.mobile.offerCode())}
                  >
                    {t('settings.mobile.generate')}
                  </Button>
                }
              />
            </div>
          )}
        </section>

        {/* The org bridge — this desktop's own end of the live link. Phones
            read their data from the org; only turns and answers come through
            here, and only while this desktop is on the bridge. */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  STATUS_DOT[bridge?.status ?? 'idle'] ?? 'bg-border'
                )}
              />
              <span className="text-fg text-sm font-medium">
                {t('settings.mobile.bridge')}
                {' · '}
                {t(`settings.mobile.status.${bridge?.status ?? 'idle'}`)}
              </span>
            </div>
            <span dir="ltr" className="text-muted truncate font-mono text-xs">
              {status?.apiBase ?? '—'}
            </span>
          </div>
          <p className="text-muted text-sm leading-relaxed">{t('settings.mobile.bridgeHint')}</p>
          {bridge?.lastError && bridge.status === 'error' && (
            <p dir="ltr" className="text-left font-mono text-xs text-rose-500">
              {bridge.lastError}
            </p>
          )}

          {/* What the link has actually done — the numbers that say whether it
              is alive when the status dot alone is ambiguous. */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <Row label={t('settings.mobile.connectedSince')} value={stamp(bridge?.connectedAt)} />
            <Row label={t('settings.mobile.reconnects')} value={String(bridge?.reconnects ?? 0)} />
            <Row
              label={t('settings.mobile.frames')}
              value={`${bridge?.framesSent ?? 0} ↑ · ${bridge?.framesReceived ?? 0} ↓`}
            />
            <Row
              label={t('settings.mobile.bytes')}
              value={`${bytes(bridge?.bytesSent ?? 0)} ↑ · ${bytes(bridge?.bytesReceived ?? 0)} ↓`}
            />
            <Row
              label={t('settings.mobile.livePhones')}
              value={String(bridge?.phones.length ?? 0)}
            />
            <Row label={t('settings.mobile.endpoint')} value={status?.apiBase ?? '—'} mono />
          </dl>

          <div className="border-border/60 border-t" />
          <HowRow
            icon={<Key01Icon size={18} className="text-muted mt-0.5 shrink-0" />}
            title={t('settings.mobile.how.pairTitle')}
            body={t('settings.mobile.how.pairBody')}
          />
          <HowRow
            icon={<Globe02Icon size={18} className="text-muted mt-0.5 shrink-0" />}
            title={t('settings.mobile.how.orgTitle')}
            body={t('settings.mobile.how.orgBody')}
          />
          <HowRow
            icon={<PlugSocketIcon size={18} className="text-muted mt-0.5 shrink-0" />}
            title={t('settings.mobile.how.liveTitle')}
            body={t('settings.mobile.how.liveBody')}
          />
        </section>

        {/* The stores' permanent links — installing the app is step zero of
            pairing, so the panel hands them over instead of sending the user
            hunting. */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex flex-col gap-1">
            <span className="text-fg text-sm font-medium">{t('settings.mobile.getApp.title')}</span>
            <p className="text-muted text-xs leading-relaxed">{t('settings.mobile.getApp.body')}</p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <AppleIcon size={18} className="text-muted shrink-0" />
              <span className="text-fg text-sm font-medium">{t('settings.mobile.getApp.ios')}</span>
            </div>
            <ExternalLink
              href="https://apps.apple.com/us/app/wolffish/id6792797989"
              label={t('settings.mobile.getApp.appStore')}
            />
          </div>
          <div className="border-border/60 border-t" />
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <AndroidIcon size={18} className="text-muted shrink-0" />
              <span className="text-fg text-sm font-medium">
                {t('settings.mobile.getApp.android')}
              </span>
            </div>
            <ExternalLink
              href="https://play.google.com/store/apps/details?id=sh.wolffi.mobile"
              label={t('settings.mobile.getApp.googlePlay')}
            />
          </div>
        </section>

        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <Toggle
            title={t('settings.mobile.notifications')}
            hint={t('settings.mobile.notificationsHint')}
            value={status?.notificationsEnabled ?? null}
            options={toggleOptions}
            disabled={busy || !loaded}
            onChange={(value) => void act(() => window.api.mobile.setNotifications(value))}
          />
          <Toggle
            title={t('settings.mobile.verbose')}
            hint={t('settings.mobile.verboseHint')}
            value={verbose}
            options={toggleOptions}
            disabled={busy || !loaded}
            onChange={(value) => void act(() => window.api.mobile.setVerbose(value))}
          />
          <Toggle
            title={t('settings.mobile.runCards')}
            hint={t('settings.mobile.runCardsHint')}
            value={runCards}
            options={toggleOptions}
            disabled={busy || !loaded}
            onChange={(value) => void act(() => window.api.mobile.setRunCards(value))}
          />
        </section>
      </div>
    </div>
  )
}

/**
 * One paired phone: what it is, when it was here, and the way to forget it.
 *
 * Every value comes from the organization's own device row, so a phone that
 * is asleep still reads in full — what it said the last time it connected is
 * the org's record, not this desktop's memory of the session.
 */
function PhoneRow({
  phone,
  busy,
  onUnpair
}: {
  phone: MobilePairedPhone
  busy: boolean
  onUnpair: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const os = osLabel(phone.platform, phone.osVersion)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {phone.platform === 'ios' ? (
            <AppleIcon size={18} className="text-muted mt-0.5 shrink-0" />
          ) : phone.platform === 'android' ? (
            <AndroidIcon size={18} className="text-muted mt-0.5 shrink-0" />
          ) : (
            <SmartPhone01Icon size={18} className="text-muted mt-0.5 shrink-0" />
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-fg truncate text-sm font-medium">
                {phone.name || t('settings.mobile.unknownDevice')}
              </span>
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  phone.connected ? 'bg-emerald-500' : 'bg-border'
                )}
              />
              <span className="text-muted text-xs">
                {phone.connected ? t('settings.mobile.appOpen') : t('settings.mobile.appClosed')}
              </span>
            </div>
            <p className="text-muted text-xs">{os || t('settings.mobile.unknownOs')}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" disabled={busy} className="shrink-0" onClick={onUnpair}>
          <Unlink01Icon size={14} />
          {t('settings.mobile.unpairAction')}
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Row label={t('settings.mobile.device')} value={phone.model ?? '—'} />
        <Row label={t('settings.mobile.appVersion')} value={phone.appVersion ?? '—'} />
        <Row label={t('settings.mobile.pairedAt')} value={stamp(phone.pairedAt)} />
        <Row
          label={t('settings.mobile.method')}
          value={phone.pairMethod ? t(`settings.mobile.methodValue.${phone.pairMethod}`) : '—'}
        />
        <Row label={t('settings.mobile.lastSeen')} value={stamp(phone.lastSeenAt)} />
        <Row
          label={t('settings.mobile.connectedSince')}
          value={phone.connected ? stamp(phone.connectedSince) : '—'}
        />
        <Row label={t('settings.mobile.deviceId')} value={phone.id} mono className="col-span-2" />
      </dl>
    </div>
  )
}

/** A timestamp as the user's locale writes it, or an em dash for "never". */
function stamp(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—'
}

/** Bytes at the scale they are actually read at — a phone's link never moves
 *  gigabytes, and "1.2 MB" beats seven digits. */
function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** One label-over-value cell of a detail grid. */
function Row({
  label,
  value,
  mono,
  className
}: {
  label: string
  value: string
  mono?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <dt className="text-muted text-xs">{label}</dt>
      <dd
        dir={mono ? 'ltr' : undefined}
        className={cn('text-fg truncate text-sm', mono && 'font-mono text-xs')}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}

/** "iOS 18.2" / "Android 15" — the OS name the platform implies, plus its
 *  version. Either half may be missing; null when both are. */
function osLabel(platform: string | null | undefined, version: string | null | undefined): string {
  const name = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : null
  return [name, version].filter(Boolean).join(' ')
}

function Toggle({
  title,
  hint,
  value,
  options,
  disabled,
  onChange
}: {
  title: string
  hint: string
  value: boolean | null
  options: Array<{ value: boolean; label: string }>
  disabled: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-fg text-sm font-medium">{title}</span>
        <p className="text-muted text-xs">{hint}</p>
      </div>
      {value === null ? (
        <div
          aria-hidden="true"
          className="bg-border/30 h-7 w-[78px] shrink-0 animate-pulse rounded-lg"
        />
      ) : (
        <div
          role="tablist"
          className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
        >
          {options.map((opt) => {
            const active = opt.value === value
            return (
              <button
                key={String(opt.value)}
                role="tab"
                type="button"
                aria-selected={active}
                disabled={disabled}
                onClick={() => {
                  if (opt.value !== value) onChange(opt.value)
                }}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium',
                  'focus-visible:ring-accent focus-visible:ring-offset-bg focus-visible:ring-2 focus-visible:ring-offset-2',
                  active
                    ? 'bg-primary text-primary-fg shadow-sm'
                    : 'text-muted hover:text-fg cursor-pointer'
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ExternalLink({ href, label }: { href: string; label: string }): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'text-muted hover:text-fg flex shrink-0 items-center gap-1.5 text-xs',
        'focus-visible:ring-accent focus-visible:ring-offset-bg rounded-md px-1.5 py-1 focus-visible:ring-2 focus-visible:ring-offset-2'
      )}
    >
      <span>{label}</span>
      <LinkSquare02Icon size={13} className="shrink-0" />
    </a>
  )
}

/** An action with its reason attached: icon, what it is, what it does. */
function ActionRow({
  icon,
  title,
  body,
  action
}: {
  icon: React.ReactNode
  title: string
  body: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon}
        <div className="flex flex-col gap-1">
          <span className="text-fg text-sm font-medium">{title}</span>
          <p className="text-muted text-xs leading-relaxed">{body}</p>
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  )
}

function HowRow({
  icon,
  title,
  body
}: {
  icon: React.ReactNode
  title: string
  body: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      {icon}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-fg text-sm font-medium">{title}</span>
        <p className="text-muted text-xs leading-relaxed">{body}</p>
      </div>
    </div>
  )
}
