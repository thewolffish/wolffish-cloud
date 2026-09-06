# wolffish-cloud

> **This repository is a fork of the personal [Wolffish](https://github.com/thewolffish) setup**, re-aimed at a B2B platform: every employee runs their own AI agent on their own machine, and the organization's API is the master record. The personal repos remain the upstream for the agent core (see [Provenance](#provenance)).

**Keep the agent on the device. Move the truth to the edge.**

Wolffish Cloud is the enterprise edition of Wolffish: a desktop agent that thinks, acts and learns on the employee's machine, while every model call, every conversation, every file and every setting flows through one Cloudflare Worker the organization owns. Admins route every model request, decide who may use which model, cap spend, and revoke access in one call. The device holds a session, never a provider key; the folder on disk is a cache the API can rebuild.

---

## The design, as built

One architectural inversion from the personal edition, and everything else follows from it: **the API is the master, the device folder is the cache.**

- **The agent runs on the device.** The 15-region brain, the tools, the files, the sessions — execution never moves to the cloud. `~/.wfc` holds all of it.
- **One lane for models.** The agent never calls a model provider. Every request goes to `POST /ai/v1/chat/completions` on the org's API with the device's session token; the Worker enforces the org's model allowlist and quotas, admits the call through a fair queue in front of the org's hosts, forwards it with the org's key, streams the answer back and meters the call. Provider keys live in Worker secrets, never on a device.
- **One lane for web search.** `POST /v1/search` does the same for the org's search plan (Brave): one key at the edge, a fair per-employee queue, per-query metering, no query text ever stored.
- **Everything syncs.** Seconds after a turn ends, the desktop pushes the conversation (incrementally), workspace files (content-addressed blobs) and the config row. Delete `~/.wfc`, sign in on any machine, and the workspace walks back out of the org — conversation media hydrates when a conversation is opened. Signing out drains the outbox, revokes the session and purges the cache.
- **Capabilities are cloud-distributed.** The org's capability registry (versioned zip packages in R2, indexed in D1) is mirrored onto every desktop on session ready; admins publish, update or retire a capability and every device follows on its next pull. Sources live in [`capabilities/`](capabilities/).
- **Admin is pure API.** Invites, roles, teams, suspend and revoke, PIN clear, per-user model policy, org defaults, the org's config overlay, capability grants, usage totals by person and by team, live gate stats, audit log. The admin UI lives in the admin's own desktop client; every endpoint re-verifies authorization server-side against one rule table (`src/lib/permissions.ts`), so what each role may do is a list you can read rather than a pattern spread through the handlers.
- **The org controls behavior, not just spend.** Beyond the model allowlist and the token and search caps, an admin can claim any config path for the organization: the overlay is applied on every read and forced on every write, so a claimed setting is the org's on every device and everything else stays the employee's. Capabilities narrow the same way — a registry entry with no grants is the whole org's, and one granted to a role, a team or named people reaches only them, on the manifest and on the download alike.
- **The org can see itself.** `GET /v1/leaderboard` ranks every employee by token spend, conversations and agentic tasks (the runs an automation or a procedure started on its own) — readable by everyone, not just admins, and carrying no money. One cached board for the whole org answers every page, search and rank, so opening it never costs a table scan. Reachable from the side sheet on both the desktop and the phone.

### Two tiers, one system

| Tier | Where | What lives there |
| --- | --- | --- |
| **Tier 1 — the agent** | Employee device | The 15-region brain (prefrontal, thalamus, hippocampus, cerebellum, cortex, …), capabilities as markdown + plugins, channels (Telegram, WhatsApp, CLI, browser extension), the markdown workspace. `~/.wfc` is workbench + cache. |
| **Tier 2 — the master** | Cloudflare edge | One Worker (auth, model router, search lane, sync ingest, capability registry, admin). D1 holds the relational master, R2 the blobs and archives, KV the hot config cache and session kill-markers, two Durable Objects the admission gates and the exact quota counters. |

---

## Repository layout

```
wolffish-cloud/
├── apps/
│   ├── api/         · the master API — one Cloudflare Worker, live at api.wolffi.sh (Tier 2)
│   ├── desktop/     · the Electron desktop agent, cloud-first (Tier 1)
│   ├── mobile/      · the Expo companion phone app — carried over, PARKED (see below)
│   └── site/
│       └── docs/    · documentation (Mintlify, EN + AR) — rewritten for the cloud
├── packages/
│   └── extension/   · browser capability, bundled into desktop; local-only, no cloud endpoint
├── capabilities/    · official capability sources — published to the org registry, never bundled
└── .github/workflows/ci.yml · typecheck both apps + the desktop seam tests on every push
```

Every app is self-contained (own lockfile, own package manager); `cd` into it and run it as its README describes. There is no workspace tooling yet.

## The modules

### `apps/api` — the master

The single choke point at `api.wolffi.sh`. Auth (invite-only, temp password with forced first-login change, 15-minute signed access tokens, rotating refresh tokens with reuse detection, instant server-side revoke, e-mailed reset codes), the model router (OpenAI-compatible, per-user allowlists, daily and monthly token caps, exact metering with the host's own cost), the web-search lane, sync (last-write-wins config sealed at rest, idempotent outbox batches that name every item they refuse, content-addressed files in R2, one-call bootstrap restore, per-user usage read-back), the capability registry, and the full admin layer.

Built to carry hundreds of employees running long agentic sessions at once, and to slow down rather than fail when they all arrive together: the `ModelGate` Durable Object admits every model call against the org's hosts' documented concurrency (fair by employee, sticky per conversation for the host's prefix cache, cooldowns on 429/5xx, durable leases with a heartbeat), the `SearchGate` does the same for the search plans, streams are pumped rather than buffered, and D1 stays a bounded hot window (idle conversations move to gzipped archives in R2 nightly; raw usage rows retire after 180 days while a daily rollup keeps the totals).

Verified by: per-layer smoke suites against `wrangler dev` with mock hosts (`npm test`), a 500-employee load simulation (`scripts/load-500.mjs`), and the live gate `scripts/verify-live.mjs` that runs every scenario against the deployed edge with no test-mode bypass.

### `apps/desktop` — the agent

The employee's desktop app. Sign-in (email + password, forced first-login change, emailed reset), a 4-digit PIN quick-lock that never leaves the device, the one cloud lane, the sync engine, the capability mirror, and the full agent core carried from the personal edition: brain regions, channels, workspace. Dev-only by design (`npm run dev`); client forks ship their own signed builds. See [`apps/desktop/README.md`](apps/desktop/README.md) for the cloud-first contract and [`apps/desktop/src/defaults/AGENTS.md`](apps/desktop/src/defaults/AGENTS.md) for the per-path map of what syncs.

### `apps/mobile` — the phone

The companion phone app, re-aimed at the API. Pairing (QR or a typed code the desktop offers) claims an org session for the phone; from then on it reads and writes the record at the API — config snapshot, conversation index and bodies, files, usage — and reaches the desktop for live turns and workspace edits over the API's per-user `UserBridge` Durable Object. No relay, no end-to-end cipher: the org is the trusted party on both ends. See [`apps/mobile/README.md`](apps/mobile/README.md) for how it connects and syncs, and [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md) for the wire contract.

### `apps/site` — the tenant-facing web

The bilingual Mintlify documentation (EN + AR), rewritten for this edition: sixteen pages per language covering where the agents run, the API endpoint by endpoint, how the desktop, phone and browser extension sync, how quotas are enforced and what is logged, and how to stand a tenant up. The personal edition's 78-page tree — provider pages, channels, integrations, memory internals — is gone with the features it described. The marketing landing page is not part of this package — it is a public-web concern, not a tenant deliverable, and stays in its own repo ([wolffish-landing](https://github.com/thewolffish/wolffish-landing)).

### `packages/extension` — the browser capability

The Chrome extension that gives the agent eyes and hands in the user's own browser. Local-only: it talks to the desktop over `localhost:23152`, needs no cloud endpoint, and is bundled into the desktop defaults (`apps/desktop/scripts/extension/sync.mjs` copies a build in).

---

## How it all works together

1. **Sign in** — the desktop posts email + password to `/auth/login`; the Worker checks the PBKDF2 hash, reuses the device row it already knows, and issues a 15-minute access token plus a rotating refresh token. The desktop seals both with the OS keychain and asks for a local PIN.
2. **Restore** — on the first ready state the desktop calls `/v1/sync/bootstrap` and walks every page of the conversation index and file manifest; a fresh install adopts the org's config, rebuilds every transcript and materializes the workspace files before the chat screen opens. Conversation media downloads when a conversation is opened.
3. **Run** — the agent does the work locally: brain, tools, files, sessions. Nothing syncs during execution.
4. **Route** — every model request hits `POST /ai/v1/chat/completions`: verify session → enforce allowlist and caps → admit through the ModelGate → forward with the org's key → pump the stream back → meter tokens, latency, cost → release the slot. Web searches take the same path through `/v1/search`.
5. **Sync** — within seconds of a turn, the outbox pushes the conversation row, its envelope and the new message records (idempotent, replays are no-ops), uploads attachments as content-addressed blobs, and pushes the config row when it changed. The usage ledger is read back from the org's metering table so every device shows the org's record.
6. **Govern** — admins read the same tables the router and sync engine write: usage totals per user, live gate state, the audit log; they edit policy and it lands on devices within the edge cache window; they revoke and the session dies at the next request.

---

## Status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Carve the monorepo; place the sources | done |
| 1 | API: auth — users, roles, invites, sessions, password login, reset e-mails, revoke | done, live |
| 2 | API: router — host pool + ModelGate, allowlists, quotas, metering | done, live |
| 3 | API: sync — sealed config, outbox ingest, R2 files, bootstrap restore, archive window | done, live |
| 4 | API: admin layer, capability registry, search lane, Wolffish Inc seed, simulator, load sim | done, live |
| 5 | Desktop: one cloud lane, sign-in + PIN, sync engine, capability mirror, personal-edition residue removed | done |
| 6 | Mobile re-aim: pairing as an org session, the record read from the API, the desktop reached over the `UserBridge` Durable Object (api 1.7.1) | done, live |
| 7 | Packages extraction; release tagging | later |

CI (`.github/workflows/ci.yml`) typechecks both apps and runs the desktop seam tests on every push; the API's smoke suites and the live gate stay a local step because they need a running Worker and a Cloudflare account.

## Versioning

Two levels, incremented independently: the monorepo carries a master version in [VERSION](VERSION) for platform releases; each module versions itself in its own manifest (`apps/api` moves fastest and shows its version at `/health`).

## Provenance

Every carried folder is a clean export of the corresponding personal repo (tracked files only, no history imported); `apps/api` and `capabilities/` are new to this repository.

| Folder | Source repo |
| --- | --- |
| `apps/desktop` | [wolffish-app](https://github.com/thewolffish/wolffish-app) |
| `apps/mobile` | [wolffish-mobile](https://github.com/thewolffish/wolffish-mobile) |
| `apps/site/docs` | [wolffish-docs](https://github.com/thewolffish/wolffish-docs) — scaffolding only; every page rewritten |
| `packages/extension` | [wolffish-extension](https://github.com/thewolffish/wolffish-extension) |

## License

The entire repository — every app and package — is covered by a single [MIT license](LICENSE) at the root, © 2026 Younes Alturkey. Third-party licenses bundled with assets (such as font OFL files) remain alongside those assets.
