# Wolffish Cloud Mobile — Agent Guide

The phone half of Wolffish Cloud. React Native + Expo (SDK 57) + TypeScript, one codebase for iOS and Android. It is **not a second agent** — it is a signed-in device of the same organization account as the user's desktop: it reads the record from the organization API and reaches the desktop, for the things only a running desktop can do, over the API's per-user bridge.

> **Status in wolffish-cloud**
>
> Re-aimed at the organization API (`api.wolffi.sh`) on 2026-09-03. Pairing claims an org session (no password on the phone); config, conversations, files and usage come from the API; live turns and workspace writes go to the desktop through the API's `UserBridge` Durable Object. The relay, the Noise tunnel and the chunked file RPCs are gone. Where this document names the desktop, it means [`apps/desktop`](../desktop) in this monorepo.

The desktop app (`../desktop` — `apps/desktop` in this monorepo) is the design source of truth for every screen. When a UI question comes up, look at what the desktop does and mirror it.

---

## The one rule

**The organization holds the record; the desktop writes it; the phone mirrors it and asks the desktop to change things.**

Everything below follows from that sentence. The phone renders the organization's copy of the desktop's state, and every edit it makes is a request the desktop applies through the exact same code path its own panels use — never a local write that gets reconciled later. There is no merge, no CRDT, no offline queue. Offline edits do not exist by design: when the desktop is not on the bridge, editable surfaces go read-only rather than accepting a change with nowhere to land.

**Syncing and keeping the connection alive is the critical constraint on every change.** A feature that works beautifully on a warm connection and silently breaks after a background/foreground cycle is a regression, not a feature. Read [Sync & connection](#sync--connection) before touching anything under `src/lib/cloud/`, `src/lib/bridge/`, `src/lib/sync/`, or `src/state/demoConfig.ts`.

---

## Stack

- **Expo SDK 57** + **expo-router** (file-based routing, typed routes on), React Native 0.86, React 19, Hermes.
- **NativeWind 4** (Tailwind 3 classes on RN primitives) + a token layer in `src/lib/theme/colors.ts`.
- **zustand** for client state, **TanStack Query** for server state, **expo-sqlite** for the conversation store.
- **i18next** (en / ar) with full RTL; switching language restarts the app, because RTL layout direction only applies on a fresh start.
- No Expo Go. Development runs on a native dev client (`npm run ios`).

---

## Project layout

```
src/
├── app/                    expo-router routes — the file tree IS the navigation
│   ├── _layout.tsx         root: providers, splash gate, useConnection(), OTA check
│   ├── index.tsx           the door — pair, demo, or resume
│   ├── chat.tsx            the chat screen
│   ├── history.tsx         conversation list
│   └── settings/           one file per settings screen (mirrors the desktop's tabs)
├── components/
│   ├── core/               primitives (Modal, Select, icons, ZoomableImage, …)
│   ├── chat/               feed, composer, bubbles, cards, media, chart cards
│   ├── conversations/  history/  workspace/  settings/  overlays/  pairing/  updates/
│   └── common/             composed, cross-screen widgets
├── lib/
│   ├── cloud/              session (keystore tokens), api (REST client), bridge (WebSocket client), pairing
│   ├── bridge/             protocol.ts — THE WIRE, vendored from apps/desktop, see below
│   ├── sync/               what travels over the API and the bridge, and when
│   ├── conversations/      SQLite repo, query hooks, feed merge, segments
│   ├── db/                 schema + migrations (expo-sqlite)
│   ├── files/              50 GB conversation-scoped LRU file cache
│   ├── query/  i18n/  theme/  charts/  usage/  notifications/  updates/  demo/
│   └── automations/  emoji/  utils/
├── state/                  zustand stores (appStore, demoConfig, chatRuntime, runStatus)
├── changelog/<YYYY-MM>/    release notes, en.md + ar.md, bundled as Metro assets
└── types/

assets/       fonts, images, charts/*.webjs (vendored ECharts for the chart WebViews)
demo/         the committed demo dataset + the built bundle uploaded to the CDN
scripts/      provision / release / ota / rollback + scripts/demo/* builders
plugins/      local Expo config plugins
```

**Path aliases:** `@/*` → `src/*`, `@/assets/*` → `assets/*`. Declared in `tsconfig.json` and mirrored in the jest `moduleNameMapper`. Use them across folders; `./` only within one folder.

Unlike the desktop, this repo does **not** use one-thing-per-folder. Files are grouped by area and named for what they export.

---

## Commands

```bash
npm run ios            # native dev client on the simulator (LANG is set — keep it)
npm run ios:device     # on a connected device
npm start              # Metro only, for an already-installed dev client
npm run ts:check       # tsc --noEmit
npm run test           # jest
npm run format         # prettier --write
```

**Never start Metro with `CI=1`** — it disables file watching and every edit looks like it did nothing.

After structural changes always run `npm run ts:check` **and** `npm run test`. The ship scripts gate on Prettier too, so run `npm run format` before committing.

Deploying a version is [DEPLOY.md](DEPLOY.md) — checks, this app's own changelog, commit, push, then **one** ship command chosen by a gate: `npm run ota` when the fingerprint still matches every shipped store build _and_ nothing in the batch is too risky to land on all phones at once, `npm run provision` otherwise. **`ota` publishes to every installed phone and tags; `provision` publishes nothing.** When the gate is unclear, provision — the costs are not symmetric. Never run `release` or `rollback`, never set `OTA_SKIP_RUNTIME_CHECK=1`, never run `eas` beyond the read-only `build:list` the gate uses, never create or push a tag by hand. Versions and the README badge are written by `scripts/provision.js` and `scripts/ota.js`; never write them by hand.

---

## Sync & connection

### The shape of it

```
  phone  ──https──▶  api.wolffi.sh  ◀──https──  desktop     (REST: the record)
  phone  ──wss────▶  UserBridge     ◀──wss────  desktop     (rpc ▶, ◀ events, presence)
```

Durable state — the config snapshot, the conversation index and record pages, blobs, usage — is read from the API's REST routes (`src/lib/cloud/api.ts`) with the session `src/lib/cloud/session.ts` holds in the keystore. The bridge (`src/lib/cloud/bridge.ts`) is one WebSocket to the API's per-user Durable Object; it carries the phone's RPCs to the desktop, the desktop's events back, and presence. There is no relay, no key exchange and no cipher: the organization's API is the trusted party, and it already holds the record.

Pairing (`src/lib/cloud/pairing.ts`): the desktop asks the org for an offer — an 8-character code and a QR token, single-use, three minutes. The phone claims either at `POST /auth/pair/claim` and receives a session. The QR carries the API it was minted at (a fork's phone follows a fork's desktop); the code claims against the built-in `EXPO_PUBLIC_API_URL`.

Two facts the client keeps apart, and every screen must too: `bridgeClient.online` (the socket to the org is up) and `bridgeClient.connected` (online AND a desktop is on the bridge). Reading works online; editing and sending need connected. `useDesktopReachable` is the one predicate for the latter.

### The wire is a two-app contract

`src/lib/bridge/protocol.ts` is vendored **byte-identical** from `apps/desktop/src/main/cloud/bridge-protocol.ts`. It has no imports for exactly this reason. Check with `diff src/lib/bridge/protocol.ts ../desktop/src/main/cloud/bridge-protocol.ts` — any difference is a protocol split; stop and fix it before anything else.

**Adding an `Rpc` method or `Event` topic is always a change in both apps.** The mobile half alone compiles and does nothing:

- New RPC → add to `Rpc` in **both** copies, implement the handler in the desktop's `channels/mobile/channel.ts`, then call it here.
- New push → add to `Event` in both, emit on the desktop, subscribe in `attachLiveUpdates` (or `attachTurnStream`).
- `configSet` keys must be on the **desktop's whitelist**; an unknown key is an error and the phone reverts by refetching the snapshot.
- Widen payloads **additively** and read them tolerantly — an older desktop simply won't send the new fields. `lib/sync/overlays.ts` normalizes every row rather than trusting the shape; copy that habit.
- A new API route is a change in `apps/api` first; the client in `src/lib/cloud/api.ts` follows.

### What travels, and when

**Down (API → phone):**

|                    |                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config snapshot    | `desktop.config.snapshot` over the bridge while the desktop is up; otherwise `brain/mobile/snapshot.json` from `GET /v1/files/path` (the desktop writes it on every config change and syncs it like any workspace file). `lib/sync/snapshot.ts` decides; `state/demoConfig.ts` applies. |
| Conversation index | `GET /v1/conversations?since=<cursor>&include=meta` — metadata with the envelope fields and a message count, tombstones included. The cursor lives in SQLite's `sync_meta`.                                                                                                             |
| Conversation body  | `GET /v1/conversations/:id/records`, rebuilt like the desktop's restore (newest version per message, one envelope, seq order), stamped with the envelope's `updatedAt` in `body_synced_at` (never `Date.now()`).                                                                        |
| Files              | `GET /v1/files/:sha` (attachments carry their hash) or `GET /v1/files/path?name=` into the LRU cache.                                                                                                                                                                                   |
| Usage              | `GET /v1/usage/days?tz=` folded per local day (`lib/usage/ledger.ts`).                                                                                                                                                                                                                  |

**Down (bridge → phone), only while the desktop is up:** `message.delta` / `message.appended` / `turn.status`, `ask.request` / `approval.request`, `conversation.upserted/deleted`, **`conversation.synced`** (the records landed in the org — the one signal a body may be refetched on and expected to carry the turn just watched), `config.changed` (with the snapshot riding along), `variables.changed`, `usage.changed`, `projects/procedures/automations.changed`, `automations.runs`, `reindex.status`, `updater.state`.

**Up (phone → desktop over the bridge):** `chat.send`, `chat.abort`, `chat.askRespond`, `chat.approvalRespond`, `variables.set`, `capabilities.set`, `config.set`, the projects/procedures/automations CRUD trios, `files.adopt`, `diagnostics.export`.

**Up (phone → API):** `POST /v1/files/upload` for every attachment and Add-files (content-addressed, under `uploads/conv-<id>/…` or `uploads/project-<id>/…`, with a `HEAD /v1/files/path` collision check first — `lib/sync/files.ts`); push frames (`register_push`, `set_badge`, `notification_ack`, `unregister_push`) to the bridge.

### Writing from the phone: the outbox

A naive optimistic write loses to a snapshot fetched an instant earlier that lands an instant later. `lib/sync/outbox.ts` is the guard, and **every new phone-editable key must use it**:

- A key is **dirty** from its first unsent local edit until the desktop acknowledges the latest one; snapshots must not overwrite a dirty key.
- Every key carries an **epoch** that moves on every local edit and every settlement. A refresh captures the epochs before fetching and compares after — any movement means the snapshot raced a write and cannot be trusted for that key — local stays. The next quiet refresh reapplies desktop truth, which by then includes the write.
- Sends are **whole-value, debounced, one-in-flight**. Last write wins identically on both screens.
- **No retries.** A failed send abandons the local claim and asks for a refresh. Resending a stale value could overwrite a newer edit made elsewhere; honest reversion beats silent divergence.

### Live turns: order is the whole contract

`lib/sync/prompt.ts` + `state/chatRuntime.ts` + `lib/conversations/feed.ts`. Three rules that are load-bearing:

1. **The turn appears at the tap**, not at the reply — a round trip is dead air, and dead air is where users press Send again.
2. **Nothing mid-turn writes SQLite, and nothing mid-turn refetches the body.** The desktop persists an assistant message once, at the end of the turn, and pushes it to the org a moment later; a fetch before that returns a transcript _without_ it and overwrites what's on screen — the vanishing reply. `conversation.synced` is the signal that the org has it; the settle path's bounded retries cover the gap between `turn.status: done` and that push.
3. **Live rows carry the ids the desktop will save them under**, and `feed.ts` is a pure merge by message id with no notion of time. That is what makes every arrival order safe; do not reintroduce sequencing.

A message with files uploads them to the org FIRST, under a conversation id the phone mints when there is none yet; the desktop creates the conversation under that id when `chat.send` arrives and hydrates the attachments from the org before the turn runs.

### Staying connected

iOS suspends a backgrounded app within seconds, so the socket dies whenever the user leaves. **That is the normal cycle, not an error** — reconnecting is one authenticated upgrade in well under a second, and the org keeps the desktop's end parked.

`lib/sync/useConnection.ts` keeps two jobs deliberately separate:

- **Getting connected** is the bridge client's own affair: backoff retries, a 15 s dial timeout, a liveness timeout that tears down a socket gone quiet, a short-fuse probe on foreground. Foregrounding only _nudges_ it.
- **Catching up hangs off the org being reachable** — the `online` edge, not the desktop's presence and not the app opening. On each socket: `attachLiveUpdates()`, `attachTurnStream()`, `reconcile()` (snapshot + index with tombstones + usage). On each desktop appearance (`connected` edge): `seedActiveRuns()`, `seedOverlays()`, `seedDesktopUpdater()`. On each desktop departure: `clearOverlays()`. **Handlers are stored per topic, so re-attaching replaces rather than stacks** — keep it that way, or a reconnect doubles every event.

Push-only state needs a **seed** as well as a subscription: a phone that connects while a nightly reflection is halfway through has already missed the only announcement it was going to get; `overlaysRead` exists for exactly that. Ask "what does a phone that arrives mid-event see?" for every new push.

A socket closed with code 4001 means the org revoked this device (unpaired from the desktop, an admin): the session is cleared, `paired` drops, and the door is next.

### Checklist for any change that touches sync

- [ ] `diff src/lib/bridge/protocol.ts ../desktop/src/main/cloud/bridge-protocol.ts` is empty.
- [ ] Wire additions exist in **both** apps (and in `apps/api` for a new route), and the desktop actually serves/emits them.
- [ ] New payload fields are additive and read tolerantly.
- [ ] Phone-side edits go through the outbox (dirty + epoch), and go read-only when the desktop is not on the bridge.
- [ ] Nothing new writes SQLite or refetches a body mid-turn.
- [ ] Re-running the attach path is idempotent; push-only state has a seed.
- [ ] Verified on a device against a real desktop: pair → send a turn → background → foreground → confirm both directions still land, then quit the desktop and confirm the phone still reads and says the desktop is away.

---

## Data on the device

| Store                  | Holds                                                                 | Notes                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite (`wolffish.db`) | Conversations, messages, `sync_meta` cursor, `cached_files` LRU index | Durable. Excluded from the query persister — mirroring it into AsyncStorage would defeat the point.                                     |
| File cache             | `Documents/workspace/…` at the desktop's own relative paths           | 50 GB budget; eviction releases the **least recently used conversation whole**, never a recent one. A deleted file is simply refetched. |
| AsyncStorage           | `appStore` + `demoConfig` (zustand persist), the TanStack Query cache | Plain text on disk — never keys or secrets.                                                                                             |
| OS keystore            | The org session (access + refresh tokens), the API address            | `expo-secure-store` only.                                                                                                               |

Factory reset is device-scoped; signing out (Settings → Connection) additionally revokes the session at the org.

---

## Three modes, one set of screens

`appStore` carries `paired` and `demoMode` as independent flags — a device can be neither (the door screen), and disconnecting returns to demo mode being _available_ rather than implicitly entering it.

**Demo mode** downloads a committed dataset (`demo/bundle/`, published to `cdn.wolffi.sh/demo`) into the same SQLite tables and the same config store that paired mode fills. Every screen downstream reads the same local store either way **and cannot tell the difference** — that is what keeps demo mode intact instead of special-cased. When you add a screen, it must work in both modes without branching; if it needs a branch, the branch belongs in the layer that fills the store, not in the screen.

The demo dataset workflow (edit `demo/` → `scripts/demo/build-demo-bundle.mjs` → serve locally with `EXPO_PUBLIC_DEMO_BASE_URL` → verify → upload) is its own procedure; don't regenerate the bundle as a side effect of an unrelated change.

---

## Conventions to preserve

- **Comments explain _why_, never _what_.** This codebase's comments carry the reasoning behind non-obvious decisions — the failure mode a guard prevents, the bug an ordering rule was written for. When you change such code, update the comment; when you add a guard, say what it stops. Don't narrate mechanics.
- **No barrel `index.ts` files.** Explicit paths via `@/`.
- **Prettier decides formatting** — 100 columns, single quotes, no semicolons, no trailing commas. Don't hand-format.
- **No ESLint in this repo.** Prettier + `tsc --noEmit` + jest are the gates.
- **The desktop is the design reference.** Match its layout, wording and behavior unless there's a phone-specific reason not to — and say what that reason is.
- **Both languages, always.** New user-facing strings go in `src/lib/i18n/locales/en.json` **and** `ar.json`, and RTL must be checked, not assumed.
- **No scope creep.** A bug fix is a bug fix.
- **A UI change needs a device check**, not just a typecheck. Use the simulator tooling and look at it.

---

## Testing

87 jest suites via `jest-expo` + `@testing-library/react-native`, matched by `**/__tests__/**/*.test.[jt]s?(x)`.

Two rules that cost real debugging time to learn:

1. **`render` and `fireEvent` are asynchronous** — RNTL 14 renders through `act()` and publishes the result asynchronously. `await` them. A mount helper that forgets `await render(...)` leaves its `view` unbound and every later query in the file fails against an empty tree.
2. **Wrap only _out-of-band_ state changes in `await act(async () => { … })`** — a zustand `getState().putStream(…)`, a mocked RPC resolving. Do not wrap renders or `fireEvent` in it; they already run inside act, and nesting corrupts the scope.

Anything touching sync gets a test against a mocked API client and bridge, not just a rendered screen. The existing suites under `src/lib/sync/__tests__/` and `src/app/__tests__/chat*.test.tsx` are the patterns to copy.

---

## Known gotchas

- **Native vs JS changes decide how a fix ships.** A new dependency, an `app.config.ts` plugin, an SDK bump, anything in `plugins/` or `ios/` forks the fingerprint runtime version and can only reach users in a store build. Everything else can go out over the air. `npm run ota` checks this and refuses; never set `OTA_SKIP_RUNTIME_CHECK=1`.
- **`ios/` drifts against `app.config.ts`.** Resyncing is `npx expo prebuild` **and** `pod install` (with `LANG=en_US.UTF-8`), not just one of them.
- **A new changelog month needs a code change** — static imports plus a `PAGES` entry in `src/lib/changelog/index.ts`. Metro cannot glob a folder.
- **`.md` and `.webjs` are registered asset extensions** in `metro.config.js`. That is how changelog markdown and the vendored ECharts bundle get packed into the binary.
- **Chart cards mirror the desktop's `.chart.json` cards** through vendored ECharts in WebViews. Three files must track the desktop copy; changing one repo alone splits the rendering.
- **Toasts raised inside a React Native `Modal` never paint on iOS.** Use inline errors in sheets (see `PairSheet`).
- **An iOS system picker launched during a Modal dismissal is silently killed.** Launch it from `onDismiss`.
- **Deep links are scheme-only (`wolffish://`) on purpose.** Universal links are deferred — the recipe and its two blockers are commented in `app.config.ts`; don't uncomment half of it.
- **A new screen a notification should be able to open needs `DEEPLINK_ROUTES`** in `src/lib/bridge/protocol.ts` **and the desktop's mirrored copy**. It is an allowlist on both ends: the desktop refuses a link naming anything else (which is how the model learns the real page list), and this app ignores one, so a screen missing from it is simply unreachable by tap.
- **Unfocused single-line `TextInput`s show only the prefix of a long value** on iOS.
