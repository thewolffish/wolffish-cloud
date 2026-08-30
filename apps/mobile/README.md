<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="wolffish" />
</picture>

# wolffish-mobile

**Your agent's machine, in your pocket.**

Wolffish Mobile is the official phone app for [Wolffish](https://github.com/thewolffish/wolffish-app), the personal AI agent that runs on your own computer. It is deliberately **not** a second agent and not a cloud account: the desktop holds the models, the capabilities, the memory and the files, and the phone is a remote for it — paired once by scanning a QR code, then connected over an end-to-end encrypted tunnel that no server can read.

Built with React Native and Expo. One codebase, iOS and Android, English and Arabic with full RTL.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.48-green.svg)](https://wolffi.sh)
[![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20Android-lightgrey.svg)]()

---

## Get the app

<table>
  <tr>
    <td align="center">
      <a href="https://apps.apple.com/us/app/wolffish/id6792797989"><img src="https://cdn.wolffi.sh/generic/app-store.svg" width="168" height="56" alt="Download on the App Store" /></a>
    </td>
    <td align="center">
      <a href="https://play.google.com/store/apps/details?id=sh.wolffi.mobile"><img src="https://cdn.wolffi.sh/generic/google-play.svg" width="189" height="56" alt="Get it on Google Play" /></a>
    </td>
  </tr>
</table>

Requires the [Wolffish desktop app](https://github.com/thewolffish/wolffish-app) on your computer to pair with. Or open the app without pairing to explore the built-in demo.

---

## Watch

<table>
  <tr>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=oog1q7T8H-s"><img src="https://cdn.wolffi.sh/generic/demo_walkthrough.jpg" width="360" alt="Demo walkthrough" /></a>
      <br /><b>Demo walkthrough</b>
    </td>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=XZdBttn-99E"><img src="https://cdn.wolffi.sh/generic/cinematic_launch.jpg" width="360" alt="Cinematic launch" /></a>
      <br /><b>Cinematic launch</b>
    </td>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=TKdTWd6BXR8"><img src="https://cdn.wolffi.sh/generic/cinematic_reveal.jpg" width="360" alt="Cinematic reveal" /></a>
      <br /><b>Cinematic reveal</b>
    </td>
  </tr>
</table>

---

## Table of Contents

- [Get the app](#get-the-app)
- [Watch](#watch)
- [What it does](#what-it-does)
- [How it connects](#how-it-connects)
- [How it syncs](#how-it-syncs)
- [Live turns](#live-turns)
- [Files](#files)
- [Notifications](#notifications)
- [Demo mode](#demo-mode)
- [Screens](#screens)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Development](#development)
- [Releasing](#releasing)
- [Data on the device](#data-on-the-device)
- [Security model](#security-model)
- [Links](#links)
- [License](#license)

---

## What it does

- **Chat with your desktop agent from anywhere** — the same turns, the same tool cards, the same streamed reply your desktop shows.
- **Answer the agent while you're away** — multiple-choice questions and dangerous-tool approvals park the turn and arrive as cards on the phone.
- **Run the desktop's settings** — every panel the desktop has, rendered from a live snapshot: model and providers, capabilities, channels, projects, procedures, automations, knowledge, variables, MCP servers, services.
- **Edit, not just read** — variables, capability toggles, project and procedure CRUD, the automations file, the reflection schedule and turn scores are all written back to the desktop through the same code paths its own panels use.
- **Open what the agent made** — images, video, audio, PDFs, spreadsheets, code and charts stream out of the desktop's workspace on demand and cache locally.
- **Send it work** — text, voice notes, photos, videos and documents, uploaded on send.
- **Be told when something happens** — model-initiated notifications, delivered in-band when the tunnel is up and by push when it isn't.
- **Try it with no desktop at all** — [demo mode](#demo-mode) runs the whole app against a real, anonymized dataset.

---

## How it connects

```
   iPhone / Android                relay.wolffi.sh                 Desktop
  ┌──────────────────┐          ┌────────────────────┐        ┌──────────────────┐
  │  wolffish-mobile │──wss────▶│  Cloudflare Worker │◀───wss─│   wolffish-app   │
  │     "guest"      │          │  + Durable Object  │        │      "host"      │
  └──────────────────┘          └────────────────────┘        └──────────────────┘
          │                       forwards opaque                      │
          └───────────── Noise-encrypted, end to end ──────────────────┘
```

### The relay is a rendezvous, not a server

`relay.wolffi.sh` matches exactly one **host** (your desktop) with one **guest** (your phone) that presented the same 256-bit rendezvous ID, and forwards binary records between them. It never parses a payload, never stores conversation data, and cannot decrypt anything — every frame is sealed end to end before it reaches the socket. The relay URL travels with the pairing, so a self-hosted relay works with no code change.

The one deliberate exception is `CONTROL` records: plaintext JSON addressed to the relay itself, used only by the [push-notification control plane](#notifications), terminated there and never forwarded.

### Pairing

The desktop shows two ways in, and they differ only in how much the phone learns up front:

| | **QR** | **Code** |
|---|---|---|
| Carries | Relay URL + desktop public key + pairing secret | Pairing secret only (8 characters) |
| Handshake | `Noise_IKpsk2_25519_ChaChaPoly_SHA256` — one round trip | `Noise_XXpsk3_…` — one extra message |
| Desktop key | Already known | Learned inside the handshake and **pinned** |

The pairing secret enters both patterns as the pre-shared key, so only a device that actually saw the QR or the code can complete a handshake — a hostile relay that knows the rendezvous ID still cannot sit in the middle. Ephemeral keys give forward secrecy. After a code pairing the desktop's key is pinned, and every reconnect from then on uses the cheaper `IK` path.

The phone's long-lived keypair and the pairing record live in the **OS keystore** (Keychain on iOS, Keystore-encrypted preferences on Android), readable only while the device is unlocked — never in AsyncStorage.

### Reconnecting is the normal case

iOS suspends a backgrounded app within seconds, so the socket dies every time you leave the app. That is the designed cycle, not an error: the desktop parks on the relay waiting, and returning re-handshakes with fresh session keys in well under a second.

Two jobs are kept deliberately separate:

- **Getting connected** belongs to the tunnel: exponential-backoff retries, a 15-second timeout on a dial that hangs, and a liveness timeout that tears down a socket that has gone quiet even when the OS still reports it open. Returning to the app only nudges it past the remaining backoff.
- **Catching up** hangs off the *connection*, not off the app opening — those are not the same moment. Foregrounding often finds the network still down; a catch-up wired to that alone would leave the phone stale until the user happened to open it again. Instead, every connection that forms brings the phone level with nobody watching.

---

## How it syncs

**The desktop owns the truth. The phone mirrors it and asks it to change things.** There is no merge, no CRDT, no offline write queue — offline edits do not exist. When the tunnel is down, editable surfaces go read-only rather than accepting a change with nowhere to land.

### Down: metadata first, content on demand

A real workspace is hundreds of conversations and close to a gigabyte of message bodies, and a phone opens one conversation at a time. So the first sync pulls three things and nothing else:

1. **The config snapshot** — everything the settings screens render, in one object.
2. **The conversation index** — metadata only: title, model, channel, icon, project, counts, stats, summary.
3. **Usage** — the ledger the Usage screen aggregates on device.

A conversation's **body** is fetched the moment you open it and cached in SQLite, stamped with the desktop's own `updatedAt` (never the phone's clock — the two aren't synchronized, and comparing across them either refetches on every open or, worse, never refetches again). Its **files** are prefetched right behind it.

Afterwards the phone stays current two ways:

- **Pushes** for anything that moves: conversations created or deleted, config changed, variables changed, usage moved, projects / procedures / automations changed, the automation run pool, memory reindex progress, and turn scores cast on any surface.
- **Reconcile** on every connection: refetch the config, pull the index since the stored cursor, and prune anything the desktop no longer lists. An incremental pull can only describe what still exists, so the prune is what makes a deletion during a long absence converge.

The cursor lives in SQLite beside the rows it describes, so it can never disagree with them — clear the database and the phone resyncs from zero automatically.

### Up: the outbox

The config store is a mirror that every refresh overwrites wholesale, which makes an ordinary optimistic write dangerous: a snapshot fetched an instant *before* an edit can land an instant *after* it and silently put the old value back under the user's thumb.

Two ideas prevent it, shared by every phone-editable key:

- A key is **dirty** from its first unsent local edit until the desktop acknowledges the latest one. While dirty, no snapshot may overwrite it.
- Every key carries an **epoch** that moves on each local edit and each settlement. A refresh captures epochs before fetching and compares after — any movement means the snapshot raced a write, so the local value stays and the next quiet refresh lands desktop truth.

Sends are **whole-value, debounced, and one-in-flight**, so a typing burst becomes a few writes and the desktop's arrival order is the only order there is. There are **no retries** by design: resending a stale value could overwrite a newer edit made elsewhere, so a failed send abandons the local claim and asks for a refresh instead. Honest reversion beats silent divergence.

Every write is applied by the desktop through the exact function its own panel calls, so a change from either screen is one write serialized by one mutation tail — and the push that follows is the confirmation both screens render.

---

## Live turns

The desktop runs every turn; the phone hands over the prompt and renders what comes back. The reply is not a response to the send — it arrives as a stream of events (`message.appended` snapshots, `message.delta` text between them, `turn.status` around the edges), the same stream the desktop's own chat view consumes. That is why a turn started on the phone looks identical on both screens, and why a turn started on the desktop appears here with no extra machinery.

**Order is the whole contract**, and three rules follow from it:

- **The turn appears at the tap**, not at the reply. A round trip to the desktop is dead air, and dead air is where people press Send again.
- **Nothing mid-turn writes to SQLite, and nothing mid-turn refetches the body.** The desktop persists an assistant message once, when the turn ends; a fetch before that returns a transcript without it and would overwrite what's on screen.
- **Live rows carry the ids the desktop will save them under**, and the feed is a pure merge by message id with no notion of time. A live row simply isn't emitted once the stored transcript carries its id — so the overlay can be dropped whenever, arrive whenever, and repeat, and the feed looks the same either way.

Turns that park waiting on you — the agent's multiple-choice **questions** and **approval requests** for flagged tool calls — arrive as cards anchored at the tool result they belong to. Both fail closed: an unanswered request is denied when its turn ends or the phone goes away.

Anything the desktop is busy with in the background — automations, compaction, nightly reflection, a memory reindex — shows as a card in an overlay stack. It is in-memory only and cleared the instant the tunnel drops, because every card asserts something is happening *right now* on a machine the phone can no longer see.

---

## Files

Conversation media keeps the desktop's own workspace-relative paths. When a file is needed, its bytes come down the tunnel in 256 KiB chunks riding ordinary RPC frames, land in `Documents/workspace/…` and are tracked in an LRU index.

The cache budget is **50 GB**, and eviction releases the **least recently used conversation whole** — never a file out of a recent one. A dropped file is simply refetched the next time its conversation is opened.

Uploads go the other way through the same shape: staged locally the moment you attach them (so the message renders immediately), then streamed on send. The **desktop chooses the final path**, resolving collisions Finder-style, and the answer is what the phone stores. The same three frames retarget at a project's file list when a `projectId` is supplied.

---

## Notifications

Notifications are **100% model-initiated**: the desktop agent decides to tell you something and calls its notify tool. The desktop — never the model — stamps the notification id and the target phone id, and the relay picks the route:

- **In-band** over the live tunnel when the phone is connected, and
- **Expo push** as the fallback when it isn't.

The phone registers its push token by a stable per-device id on pairing, on reconnect and on every foreground, and dedupes by notification id, because both routes can legitimately fire. Where a tap lands is the model's choice, from a fixed list: a deep link must be the app's own `wolffish://` scheme **and** name a screen that exists — the desktop refuses anything else before sending, and the phone ignores a link it cannot resolve rather than navigating somewhere arbitrary.

---

## Demo mode

The app has something to show before you own a desktop to pair it with. Demo mode downloads a real, anonymized dataset — 164 conversations across three months, plus automations, projects, capabilities, channels, usage and every settings surface — and runs the whole app against it.

The trick is that it uses **the same tables and the same config store** paired mode fills. Every screen downstream reads the same local store either way and cannot tell the difference, which is what keeps demo mode a real exercise of the app rather than a set of mock screens.

Conversation JSON arrives as ~1.5 MB shards, each parsed, imported and released before the next starts, so entry costs a few megabytes rather than the whole archive; media resolves to a published sample per file type and is fetched only when opened. Turning demo mode off puts the app back to empty.

---

## Screens

| Area | What's there |
|---|---|
| **Door** | Pair by QR or code, enter demo mode, or resume straight into chat |
| **Chat** | Feed, composer (text, voice notes, photos, videos, documents), tool cards, question and approval cards, turn rating, file and chart viewers, conversations sheet |
| **History** | The conversation index, grouped and searchable, with channel badges |
| **Settings** | Model · Capabilities · Channels · Projects · Procedures · Automations · Knowledge · Customization · Variables · MCP · Services · Usage · Appearance (theme + language) · Preferences · Data · Relay · Updates · Changelog |

The **Relay** screen is the connection itself made legible: status, rendezvous and key fingerprints, session identifier, frame and byte counters, reconnect count and last error. The **Data** screen shows the desktop's footprint and the device's, with a device-scoped factory reset.

---

## Tech stack

| Layer | Technology |
|---|---|
| **Runtime** | Expo SDK 57, React Native 0.86, React 19, Hermes |
| **Routing** | expo-router (file-based, typed routes) |
| **Styling** | NativeWind 4 (Tailwind 3) over a token layer, light/dark/system |
| **Client state** | zustand + AsyncStorage persistence |
| **Server state** | TanStack Query, persisted (SQLite-backed families excluded) |
| **Database** | expo-sqlite — conversations, messages, sync cursor, file LRU index |
| **Transport** | WebSocket + Noise `IKpsk2` / `XXpsk3` via `@noble` (curves, ciphers, hashes) |
| **Secrets** | expo-secure-store (OS keychain / keystore) |
| **Media** | expo-image, expo-video, expo-audio, expo-image-picker, expo-document-picker |
| **Charts** | Vendored ECharts 6 in a WebView, mirroring the desktop's `.chart.json` cards |
| **i18n** | i18next (English, Arabic) with full RTL |
| **Updates** | expo-updates (EAS Update) on a fingerprint runtime policy |
| **Notifications** | expo-notifications + Expo push, relay-routed |
| **Testing** | jest-expo + @testing-library/react-native (66 suites) |

---

## Project structure

```
src/
├── app/                    expo-router routes — the file tree IS the navigation
│   ├── _layout.tsx         providers, splash gate, connection lifecycle, OTA check
│   ├── index.tsx           the door — pair, demo, or resume
│   ├── chat.tsx  history.tsx  showcase.tsx
│   └── settings/           one file per settings screen
├── components/
│   ├── core/               primitives (Modal, Select, icons, ZoomableImage, …)
│   ├── chat/               feed, composer, bubbles, cards, media, charts
│   ├── conversations/  workspace/  settings/  overlays/  pairing/  updates/  history/
│   └── common/             composed, cross-screen widgets
├── lib/
│   ├── tunnel/             protocol, Noise, pairing, the tunnel endpoint, the client
│   ├── sync/               what travels over the tunnel, and when
│   ├── conversations/      SQLite repo, query hooks, feed merge, segments
│   ├── files/              the 50 GB conversation-scoped LRU cache
│   ├── db/  query/  i18n/  theme/  charts/  usage/  notifications/  updates/  demo/
│   └── automations/  emoji/  utils/  api/
├── state/                  appStore · demoConfig · chatRuntime · runStatus
└── changelog/<YYYY-MM>/    release notes (en.md + ar.md), bundled as assets

assets/     fonts, images, charts/*.webjs (the vendored ECharts bundle)
demo/       the committed demo dataset and its built CDN bundle
scripts/    provision · release · ota · rollback, plus the demo builders
plugins/    local Expo config plugins
```

**Path aliases:** `@/*` → `src/*`, `@/assets/*` → `assets/*`.

`src/lib/tunnel/protocol.ts` and `noise.ts` are **vendored byte-identical** with `wolffish-app/src/main/tunnel/`; `pairing.ts` and `tunnel.ts` differ only in import specifiers. The wire contract is a two-repo change by construction — see [AGENTS.md](AGENTS.md).

---

## Getting started

### Requirements

| Tool | Minimum |
|---|---|
| Node.js | 24+ |
| Xcode | for iOS builds |
| A Wolffish desktop | to pair with — [wolffish-app](https://github.com/thewolffish/wolffish-app) |

There is no Expo Go build. Development runs on a native dev client.

```bash
git clone git@github.com:thewolffish/wolffish-mobile.git
cd wolffish-mobile
npm install
npm run ios          # builds and installs the dev client on the simulator
```

Then either scan the pairing QR from the desktop's Mobile panel, or tap **Demo mode** and use the app with no desktop at all.

---

## Development

```bash
npm run ios              # native dev client on the simulator
npm run ios:device       # on a connected device
npm start                # Metro only, for an already-installed dev client
npm run ts:check         # tsc --noEmit
npm run test             # jest
npm run format           # prettier --write
```

Never start Metro with `CI=1` — it disables file watching, and every edit then looks like it did nothing.

Read [AGENTS.md](AGENTS.md) before changing anything under `lib/tunnel/` or `lib/sync/`. The connection is the product, and the failure modes there are quiet ones.

---

## Releasing

The app ships two ways, and they are not interchangeable:

| | **OTA update** | **Store build** |
|---|---|---|
| Carries | JS, assets, locales | Everything, including native |
| Command | `npm run ota` | `npm run provision` → EAS build → submit → `npm run release` |
| Reaches users | Minutes, no review | After store review |

A native change — a new dependency, an `app.config.ts` plugin, an SDK bump — forks the fingerprint runtime version and can only reach users in a new binary. `npm run ota` generates the local fingerprint, compares it against the latest shipped store build and refuses to publish an update no installed binary could receive.

A bad update is reversible: `npm run rollback` republishes the previous update group (or the bundle embedded in the store build) and devices converge on the next launch.

Versions live in `app.config.ts` — `APP_VERSION` (user-visible) and `CODE_VERSION` (the store build counter). `ota` and `provision` own them, and bump `package.json` and the version badge at the top of this file in the same commit, so nothing about a version is ever written by hand. Pushing a `v*` tag creates the GitHub Release with a sideload APK, the released `.ipa` and checksums.

**[DEPLOY.md](DEPLOY.md)** is the procedure for shipping the next version — checks, changelog, commit, push, then a gate that picks the path: `npm run ota` for a batch the shipped binaries can actually receive and that is safe to land on every phone at once, `npm run provision` for anything else. Building, submitting and `npm run release` stay manual.

---

## Data on the device

| Store | Holds |
|---|---|
| **SQLite** (`wolffish.db`) | Conversations, messages, the sync cursor, the file-cache LRU index |
| **File cache** (`Documents/workspace/…`) | Workspace media at the desktop's own relative paths, 50 GB budget |
| **AsyncStorage** | App preferences, the config mirror, the query cache |
| **OS keystore** | The device identity keypair and the pairing record |

Conversation data never leaves the pair. The relay stores none of it, and there is no Wolffish account.

---

## Security model

- **End-to-end encrypted.** ChaCha20-Poly1305 over a Noise handshake, with the pairing secret as the pre-shared key. The relay forwards ciphertext it cannot read.
- **Forward secret.** Every reconnect is a fresh handshake with new ephemeral keys.
- **Pinned peers.** The desktop's static public key is known from the QR or learned once during a code pairing and pinned from then on.
- **Keys in the keystore**, unlocked-device-only, never in plain-text storage.
- **Paths are validated on the desktop** — anything escaping the workspace root is refused, and upload destinations are the desktop's choice, not the phone's.
- **Dangerous tool calls still gate.** The desktop's approval flow reaches the phone as a card and fails closed if nobody answers.
- **Camera is pairing-only.** No capture, no library access, no recording — the photo picker runs out of process and returns only what you chose.
- **Notifications are desktop-stamped.** Ids and targets come from the pairing record, never from the model, and deep links are restricted to the app's own scheme and to screens it actually has.

---

## Links

- **Website** — [wolffi.sh](https://wolffi.sh)
- **App Store** — [Wolffish for iOS](https://apps.apple.com/us/app/wolffish/id6792797989)
- **Google Play** — [Wolffish for Android](https://play.google.com/store/apps/details?id=sh.wolffi.mobile)
- **Desktop app** — [thewolffish/wolffish-app](https://github.com/thewolffish/wolffish-app)
- **Documentation** — [docs.wolffi.sh](https://docs.wolffi.sh/)
- **Discord** — [Join the community](https://discord.com/invite/F5Ue36PzQ)
- **X** — [@younesbites](https://x.com/younesbites)

---

## License

MIT License — Copyright (c) 2026 [Younes Alturkey](mailto:younes@wolffi.sh)

See [LICENSE](LICENSE) for the full text.
