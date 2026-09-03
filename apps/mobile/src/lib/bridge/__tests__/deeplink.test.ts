import {
  DEEPLINK_ROUTES,
  DEEPLINK_SCHEME,
  buildDeeplink,
  parseDeeplink
} from '@/lib/bridge/protocol'

/**
 * Every link below is built from DEEPLINK_SCHEME rather than spelled out, so
 * renaming the scheme (this app must not answer the personal edition's
 * `wolffish://` — both are installed side by side) moves the tests with it
 * instead of leaving them green against a scheme the app no longer has.
 */
const S = DEEPLINK_SCHEME

/**
 * The route table is what a notification tap is allowed to steer, and both
 * ends of the wire hold the same copy: the desktop refuses a link that fails
 * this, and the phone ignores one — which is the difference between a tap that
 * does nothing and a tap that dumps the user on some unrelated screen.
 */
describe('parseDeeplink', () => {
  it('resolves every route the app actually has', () => {
    for (const route of DEEPLINK_ROUTES) {
      expect(parseDeeplink(`${S}${route}`)).toEqual({ route, conversationId: null })
    }
  })

  it('carries the conversation id, and only for chat', () => {
    expect(parseDeeplink(`${S}chat?id=2026-08-05_10-00-00`)).toEqual({
      route: 'chat',
      conversationId: '2026-08-05_10-00-00'
    })
    // A settings page has no parameters; one written anyway is ignored, not
    // mistaken for a conversation.
    expect(parseDeeplink(`${S}settings/usage?id=2026-08-05_10-00-00`)).toEqual({
      route: 'settings/usage',
      conversationId: null
    })
  })

  // The shapes a model (or an older desktop) actually writes. None of these
  // are worth refusing — they name a real screen unambiguously.
  it('tolerates sloppy but unambiguous links', () => {
    expect(parseDeeplink(`${S}/chat`)?.route).toBe('chat')
    expect(parseDeeplink(`${S}settings/model/`)?.route).toBe('settings/model')
    expect(parseDeeplink(`${S}history?from=notify`)?.route).toBe('history')
    expect(parseDeeplink(`${S}chat?from=notify&id=abc`)?.conversationId).toBe('abc')
  })

  // The regression this table exists for: an unknown path used to fall through
  // to the not-found route, which redirects home, which on a paired phone
  // redirects into the last chat — a tap that looked like it did something
  // arbitrary rather than nothing.
  it('refuses a screen the app does not have', () => {
    expect(parseDeeplink(`${S}runs/1`)).toBeNull()
    expect(parseDeeplink(`${S}settings/notifications`)).toBeNull()
    expect(parseDeeplink(`${S}chat/2026-08-05_10-00-00`)).toBeNull()
    expect(parseDeeplink(`${S}`)).toBeNull()
    // Not destinations: the pairing door and the component gallery.
    expect(parseDeeplink(`${S}`)).toBeNull()
    expect(parseDeeplink(`${S}showcase`)).toBeNull()
  })

  it('refuses anything outside the app scheme', () => {
    expect(parseDeeplink('https://evil.example/chat')).toBeNull()
    // The personal edition's scheme. Both apps can be installed at once, and
    // each must answer only its own links.
    expect(parseDeeplink('wolffish://chat')).toBeNull()
    expect(parseDeeplink(DEEPLINK_SCHEME.replace('//', '/') + 'chat')).toBeNull()
    expect(parseDeeplink(`${S}chat\nid=x`)).toBeNull()
    expect(parseDeeplink(null)).toBeNull()
    expect(parseDeeplink(42)).toBeNull()
  })

  // A conversation id is a filename on the desktop. Anything that could not be
  // one is a title, a sentence or a guess — and opening a chat that will never
  // fill in is worse than not navigating.
  it('refuses a conversation reference that is not an id', () => {
    expect(parseDeeplink(`${S}chat?id=my%20morning%20digest`)).toBeNull()
    expect(parseDeeplink(`${S}chat?id=${'x'.repeat(129)}`)).toBeNull()
    // An empty id is simply no id: a new chat.
    expect(parseDeeplink(`${S}chat?id=`)).toEqual({ route: 'chat', conversationId: null })
  })

  it('round-trips through the canonical form', () => {
    for (const link of [
      `${S}chat`,
      `${S}chat?id=2026-08-05_10-00-00`,
      `${S}history`,
      `${S}settings/automations`
    ]) {
      const target = parseDeeplink(link)
      expect(target).not.toBeNull()
      expect(buildDeeplink(target!)).toBe(link)
    }
  })
})
