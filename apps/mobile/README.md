<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="wolffish" />
</picture>

# wfc-mobile

**Your agent's machine, in your pocket.**

> **Status in wolffish-cloud**
>
> The phone is a signed-in device of the organization. Pairing (QR or a typed code, offered by the desktop) claims a session at the organization API (`api.wolffi.sh`) — no password on the phone — and from then on the app reads and writes everything durable there: conversations, settings, files, usage. Live turns run on the desktop and travel through the API's per-user **bridge** (a Durable Object), so the desktop app has to be running for the phone to run anything, and the phone says so plainly when it is not. There is no relay and no end-to-end cipher any more: the organization's API is the trusted party on both ends, and it already holds the record. Where this document names the desktop, it means [`apps/desktop`](../desktop) in this monorepo.

Wolffish Cloud Mobile is the phone app for Wolffish Cloud, the employee agent that runs on the user's own computer. It is deliberately **not** a second agent: the desktop holds the models, the capabilities, the memory and the files, and the phone is a second view of the same account — paired once, then kept level by the organization.

Built with React Native and Expo. One codebase, iOS and Android, English and Arabic with full RTL.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.48-green.svg)](https://wolffi.sh)
[![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20Android-lightgrey.svg)](<>)

---

## Get the app

**Not on a store yet.** This app is a distinct application from the personal edition's phone app, and it has no listing of its own — build it from this repository (see [Development](#development)). The App Store and Play listings under _Wolffish_ belong to the **personal** edition and install a different app, which pairs with the personal desktop and cannot pair with an organization.

|                  | This app                                 | Personal edition     |
| ---------------- | ---------------------------------------- | -------------------- |
| Bundle / package | `sh.wolffi.cloud.mobile`                 | `sh.wolffi.mobile`   |
| URL scheme       | `wolffishcloud://`                       | `wolffish://`        |
| Expo project     | `wolffish-cloud-mobile`                  | `wolffish-mobile`    |
| Pairs with       | The Wolffish Cloud desktop + the org API | The personal desktop |

Both can be installed on the same device at once; nothing they own collides.

Requires the Wolffish Cloud desktop app ([`apps/desktop`](../desktop) in this repository) on your computer to pair with. Or open the app without pairing to explore the built-in demo.

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
- [Data on the device](#data-on-the-device)
- [Security model](#security-model)
- [Links](#links)
- [License](#license)

---

## What it does

- **Chat with your desktop agent from anywhere** — the same turns, the same tool cards, the same streamed reply your desktop shows.
- **Answer the agent while you're away** — multiple-choice questions and dangerous-tool approvals park the turn and arrive as cards on the phone.
- **Run the desktop's settings** — every panel the desktop has, rendered from a snapshot the desktop keeps synced to the organization (fresh from the desktop itself while it is up): model, capabilities, channels, projects, procedures, automations, knowledge, variables, MCP servers, services.
- **Edit, not just read** — variables, capability toggles, project and procedure CRUD, the automations file, the reflection schedule and turn scores are all written back to the desktop through the same code paths its own panels use.
- **Open what the agent made** — images, audio, PDFs, spreadsheets, code and charts come from the organization's copy of the workspace on demand and cache locally.
- **Send it work** — text, voice notes, photos, videos and documents, uploaded to the organization on send and fetched by the desktop when the turn runs.
- **Be told when something happens** — model-initiated notifications, delivered in-band when the app is open and by push when it isn't.
- **Try it with no desktop at all** — [demo mode](#demo-mode) runs the whole app against a real, anonymized dataset.

---

## How it connects

```
   iPhone / Android                 api.wolffi.sh                     Desktop
  ┌──────────────────┐        ┌──────────────────────┐        ┌──────────────────┐
  │    wfc-mobile    │──https─▶│  REST: config, index, │◀─https─│   apps/desktop   │
  │  (signed in)     │        │  records, files, usage │        │  (signed in)     │
  │                  │──wss──▶│  UserBridge (per user) │◀──wss──│                  │
  └──────────────────┘        └──────────────────────┘        └──────────────────┘
                              rpc ▶ · ◀ events · presence
```

### One account, two devices

The phone is a **device of the same organization account** the desktop is signed in to. It holds a session of its own — an access token that refreshes on a rotating refresh token, kept in the OS keystore — and every request it makes carries it. There is nothing to pin and no key to exchange: the organization's session is the trust, and unpairing is the organization revoking it.

### Pairing

The desktop asks the organization for an **offer**: an 8-character code to type and a longer token the QR carries. Both are single-use and live three minutes. The phone claims whichever it saw and receives its session — the same kind a password login issues — plus the name of the desktop that offered it. The QR also names the API it was minted at, so a fork's desktop points its phones at the fork's API for the life of the pairing.

|                     | **QR**                       | **Code**                                   |
| ------------------- | ---------------------------- | ------------------------------------------ |
| Carries             | API address + one-time token | One-time code (8 characters)               |
| Where it is claimed | The API in the payload       | The app's built-in API                     |
| Entropy             | 256 bits                     | 40 bits, rate-limited, three-minute window |

### The bridge

Turns run on the desktop, so a message sent from the phone has to reach a running desktop and its reply has to stream back. That is the **bridge**: one Durable Object per user inside the API, with the desktop parked on one WebSocket for as long as it is signed in and the phone on another while it is on screen. It forwards plain JSON — the phone's RPCs, the desktop's events — and answers **presence**, which is the phone's fast "is my desktop up" check on every launch. Nothing durable travels through it, and nothing on it is stored except the phone's push token.

### Reconnecting is the normal case

iOS suspends a backgrounded app within seconds, so the phone's socket dies every time you leave the app. Returning re-dials in well under a second: a token from the keystore, one TLS handshake, one upgrade. Two facts are kept apart on purpose — whether the **organization** is reachable (the socket is up) and whether the **desktop** is on the bridge — because a phone whose desktop is asleep is not broken: it reads everything from the organization and simply cannot run a turn, which the UI says instead of spinning.

- **Getting connected** belongs to the bridge client: exponential-backoff retries, a 15-second timeout on a dial that hangs, and a liveness timeout that tears down a socket that has gone quiet even when the OS still reports it open. Returning to the app only nudges it.
- **Catching up** hangs off the _organization_ being reachable, not off the desktop being there and not off the app opening. Every time the socket forms, the index, the settings and usage are brought level with the organization; only the desktop-dependent seeds (active runs, the overlay stack, the updater) wait for the desktop to appear.

---

## How it syncs

**The organization holds the record; the desktop writes it; the phone mirrors it and asks the desktop to change things.** There is no merge, no CRDT, no offline write queue — offline edits do not exist. When the desktop is not on the bridge, editable surfaces go read-only rather than accepting a change with nowhere to land.

### Down: metadata first, content on demand

A real workspace is hundreds of conversations and close to a gigabyte of message bodies, and a phone opens one conversation at a time. So the first sync pulls three things and nothing else:

1. **The config snapshot** — everything the settings screens render, in one object. Asked of the desktop itself while it is on the bridge (`desktop.config.snapshot`); otherwise the copy the desktop keeps synced to the organization as `brain/mobile/snapshot.json`.
2. **The conversation index** — metadata only, paged from the organization's `since` cursor with the envelope fields the desktop syncs (model, channel, icon, project, stats, summary) and a message count.
3. **Usage** — the organization's ledger, folded per day for the Usage screen.

A conversation's **body** is fetched the moment you open it — the organization's record pages, rebuilt exactly as the desktop rebuilds a transcript after a purge (newest version per message, one envelope, seq order) — cached in SQLite, and stamped with the desktop's own `updatedAt` from the envelope (never the phone's clock). Its files are prefetched right behind it.

Afterwards the phone stays current two ways:

- **Pushes** over the bridge for anything that moves while the desktop is up: conversations created or deleted, config changed (with the fresh snapshot riding along), variables changed, usage moved, projects / procedures / automations changed, the automation run pool, memory reindex progress — and `conversation.synced`, which the desktop sends once a conversation's records have actually landed in the organization, the one moment a body may be refetched and expected to carry the turn just watched.
- **Reconcile** every time the socket forms and on every return to the foreground: refetch the snapshot, pull the index since the stored cursor — tombstones included, so a deletion during a long absence converges without an id sweep — and refresh usage.

The cursor lives in SQLite beside the rows it describes, so it can never disagree with them — clear the database and the phone resyncs from zero automatically.

### Up: the outbox

The config store is a mirror that every refresh overwrites wholesale, which makes an ordinary optimistic write dangerous: a snapshot fetched an instant _before_ an edit can land an instant _after_ it and silently put the old value back under the user's thumb.

Two ideas prevent it, shared by every phone-editable key:

- A key is **dirty** from its first unsent local edit until the desktop acknowledges the latest one. While dirty, no snapshot may overwrite it.
- Every key carries an **epoch** that moves on each local edit and each settlement. A refresh captures epochs before fetching and compares after — any movement means the snapshot raced a write, so the local value stays and the next quiet refresh lands desktop truth.

Sends are **whole-value, debounced, and one-in-flight**, and go to the desktop over the bridge, which applies each through the exact function its own panel calls and syncs the result to the organization. There are **no retries** by design: resending a stale value could overwrite a newer edit made elsewhere, so a failed send abandons the local claim and asks for a refresh instead.

---

## Live turns

The desktop runs every turn; the phone hands over the prompt and renders what comes back. The reply is not a response to the send — it arrives as a stream of events (`message.appended` snapshots, `message.delta` text between them, `turn.status` around the edges), the same stream the desktop's own chat view consumes. That is why a turn started on the phone looks identical on both screens, and why a turn started on the desktop appears here with no extra machinery.

**Order is the whole contract**, and three rules follow from it:

- **The turn appears at the tap**, not at the reply. A round trip to the desktop is dead air, and dead air is where people press Send again.
- **Nothing mid-turn writes to SQLite, and nothing mid-turn refetches the body.** The desktop persists an assistant message once, when the turn ends; a fetch before that returns a transcript without it and would overwrite what's on screen.
- **Live rows carry the ids the desktop will save them under**, and the feed is a pure merge by message id with no notion of time. A live row simply isn't emitted once the stored transcript carries its id — so the overlay can be dropped whenever, arrive whenever, and repeat, and the feed looks the same either way.

Turns that park waiting on you — the agent's multiple-choice **questions** and **approval requests** for flagged tool calls — arrive as cards anchored at the tool result they belong to. Both fail closed: an unanswered request is denied when its turn ends or the phone goes away.

A memory reindex on the desktop — the one thing that blocks it outright — shows as a card over whatever screen the phone is on. It is in-memory only and cleared the instant the desktop leaves the bridge, because the card asserts something is happening _right now_ on a machine the phone can no longer see. Background runs (automations, compaction, reflection) draw nothing; the Automations screen reports them.

---

## Files

Conversation media keeps the desktop's own workspace-relative paths, and the organization holds the newest blob under every one of them. When a file is needed, its bytes come straight from the API — by content hash when the attachment carries one, by path otherwise — land in `Documents/workspace/…` and are tracked in an LRU index.

The cache budget is **50 GB**, and eviction releases the **least recently used conversation whole** — never a file out of a recent one. A dropped file is simply refetched the next time its conversation is opened.

Uploads go the other way: staged locally the moment you attach them (so the message renders immediately), then uploaded to the organization on send under a path the phone chooses the way the desktop would (`uploads/conv-<id>/<name>`, renamed Finder-style when the organization already holds a file there). A message without a conversation yet mints one, so its files have a home before the prompt is sent; the desktop creates the conversation under that id when the send arrives and fetches the attachments from the organization before the turn runs. Project, procedure and automation files take the same road, followed by one `desktop.files.adopt` call that attaches the uploaded blob through the desktop's own Add-files code.

---

## Notifications

Notifications are **100% model-initiated**: the desktop agent decides to tell you something and calls its notify tool. The desktop — never the model — stamps the notification id, and the bridge picks the route for every phone of the user:

- **In-band** over the live socket when the phone is connected (the phone acks within two seconds), and
- **Expo push** as the fallback when it isn't.

The phone registers its push token with the bridge on every connection and every foreground, and dedupes by notification id, because both routes can legitimately fire. Where a tap lands is the model's choice, from a fixed list: a deep link must be the app's own `wolffishcloud://` scheme **and** name a screen that exists — the desktop refuses anything else before sending, and the phone ignores a link it cannot resolve rather than navigating somewhere arbitrary.

---

## Demo mode

The app has something to show before you own a desktop to pair it with. Demo mode downloads a real, anonymized dataset — 164 conversations across three months, plus automations, projects, capabilities, channels, usage and every settings surface — and runs the whole app against it.

The trick is that it uses **the same tables and the same config store** paired mode fills. Every screen downstream reads the same local store either way and cannot tell the difference, which is what keeps demo mode a real exercise of the app rather than a set of mock screens.

Conversation JSON arrives as ~1.5 MB shards, each parsed, imported and released before the next starts, so entry costs a few megabytes rather than the whole archive; media resolves to a published sample per file type and is fetched only when opened. Turning demo mode off puts the app back to empty.

---

## Screens

| Area         | What's there                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Door**     | Pair by QR or code, enter demo mode, or resume straight into chat                                                                                                                                                              |
| **Chat**     | Feed, composer (text, voice notes, photos, videos, documents), tool cards, question and approval cards, file and chart viewers, conversations sheet                                                                            |
| **History**  | The conversation index, grouped and searchable, with channel badges                                                                                                                                                            |
| **Settings** | Model · Capabilities · Channels · Projects · Procedures · Automations · Knowledge · Customization · Variables · MCP · Services · Usage · Appearance (theme + language) · Preferences · Data · Connection · Updates · Changelog |

The **Connection** screen is the link made legible: the organization (account, API, status), the desktop (name, running or not), the last catch-up, frame counters, reconnect count and last error — with sign-out, which revokes this phone's session and wipes its copy. The **Data** screen shows the desktop's footprint and the device's, with a device-scoped factory reset.

---

## Tech stack

| Layer             | Technology                                                                              |
| ----------------- | --------------------------------------------------------------------------------------- |
| **Runtime**       | Expo SDK 57, React Native 0.86, React 19, Hermes                                        |
| **Routing**       | expo-router (file-based, typed routes)                                                  |
| **Styling**       | NativeWind 4 (Tailwind 3) over a token layer, light/dark/system                         |
| **Client state**  | zustand + AsyncStorage persistence                                                      |
| **Server state**  | TanStack Query, persisted (SQLite-backed families excluded)                             |
| **Database**      | expo-sqlite — conversations, messages, sync cursor, file LRU index                      |
| **Transport**     | HTTPS to the organization API; one WebSocket to its per-user bridge (plain JSON frames) |
| **Secrets**       | expo-secure-store (OS keychain / keystore) for the session tokens                       |
| **Media**         | expo-image, expo-video, expo-audio, expo-image-picker, expo-document-picker             |
| **Charts**        | Vendored ECharts 6 in a WebView, mirroring the desktop's `.chart.json` cards            |
| **i18n**          | i18next (English, Arabic) with full RTL                                                 |
| **Updates**       | expo-updates (EAS Update) on a fingerprint runtime policy                               |
| **Notifications** | expo-notifications + Expo push, bridge-routed                                           |
| **Testing**       | jest-expo + @testing-library/react-native (87 suites)                                   |

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
│   ├── cloud/              the org session, the API client, the bridge client, pairing
│   ├── bridge/             protocol.ts — THE WIRE, vendored from apps/desktop
│   ├── sync/               what travels over the API and the bridge, and when
│   ├── conversations/      SQLite repo, query hooks, feed merge, segments
│   ├── files/              the 50 GB conversation-scoped LRU cache
│   ├── db/  query/  i18n/  theme/  charts/  usage/  notifications/  updates/  demo/
│   └── automations/  emoji/  utils/
├── state/                  appStore · demoConfig · chatRuntime · runStatus
└── changelog/<YYYY-MM>/    release notes (en.md + ar.md), bundled as assets

assets/     fonts, images, charts/*.webjs (the vendored ECharts bundle)
demo/       the committed demo dataset and its built CDN bundle
scripts/    provision · release · ota · rollback, plus the demo builders
plugins/    local Expo config plugins
```

**Path aliases:** `@/*` → `src/*`, `@/assets/*` → `assets/*`.

`src/lib/bridge/protocol.ts` is **vendored byte-identical** with `apps/desktop/src/main/cloud/bridge-protocol.ts`. The wire contract is a two-app change by construction — see [AGENTS.md](AGENTS.md).

---

## Getting started

### Requirements

| Tool                     | Minimum                                                        |
| ------------------------ | -------------------------------------------------------------- |
| Node.js                  | 24+                                                            |
| Xcode                    | for iOS builds                                                 |
| A Wolffish Cloud desktop | to pair with — [`apps/desktop`](../desktop) in this repository |

There is no Expo Go build. Development runs on a native dev client.

```bash
git clone git@github.com:thewolffish/wolffish-cloud.git
cd wolffish-cloud/apps/mobile
npm install
npm run ios          # builds and installs the dev client on the simulator
```

Then either scan the pairing QR from the desktop's Mobile panel (or type its code), or tap **Demo mode** and use the app with no desktop at all.

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

Read [AGENTS.md](AGENTS.md) before changing anything under `lib/cloud/`, `lib/bridge/` or `lib/sync/`. The connection is the product, and the failure modes there are quiet ones.

---

## Data on the device

| Store                                    | Holds                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| **SQLite** (`wolffish.db`)               | Conversations, messages, the sync cursor, the file-cache LRU index                   |
| **File cache** (`Documents/workspace/…`) | Workspace media at the desktop's own relative paths, 50 GB budget                    |
| **AsyncStorage**                         | App preferences, the config mirror, the query cache                                  |
| **OS keystore**                          | The organization session (access + refresh tokens) and the API address it belongs to |

Everything on the device is a copy of the organization's record for this account; signing out revokes the session and wipes the copy.

---

## Security model

- **One session per phone, revocable.** The pairing offer is single-use and expires in three minutes; the session it mints rotates its refresh token on every refresh, and the desktop's Mobile panel (or an admin) revokes it at the organization — which closes the phone's socket and drops its push registration on the spot.
- **Tokens in the keystore**, unlocked-device-only, never in plain-text storage.
- **The organization is the trusted party.** Every request is authenticated and scoped to the account; blobs are served only to their owner; the bridge forwards frames only between a user's own devices.
- **Paths are validated on the desktop** — anything escaping the workspace root is refused, and a phone upload never supersedes a file the desktop already holds under the same name.
- **Dangerous tool calls still gate.** The desktop's approval flow reaches the phone as a card and fails closed if nobody answers.
- **Camera is pairing-only.** No capture, no library access, no recording — the photo picker runs out of process and returns only what you chose.
- **Notifications are desktop-stamped.** Ids come from the desktop, never from the model; the bridge addresses the user's own devices; deep links are restricted to the app's own scheme and to screens it actually has.

---

## Links

- **Website** — [wolffi.sh](https://wolffi.sh)
- **App Store** — [Wolffish for iOS](https://apps.apple.com/us/app/wolffish/id6792797989)
- **Desktop app** — [`apps/desktop`](../desktop) in this repository
- **Documentation** — [docs.wolffi.sh](https://docs.wolffi.sh/)
- **Discord** — [Join the community](https://discord.com/invite/F5Ue36PzQ)
- **X** — [@younesbites](https://x.com/younesbites)

---

## License

MIT License — Copyright (c) 2026 [Younes Alturkey](mailto:younes@wolffi.sh)

See [LICENSE](../../LICENSE) at the repository root for the full text.
