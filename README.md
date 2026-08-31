# wolffish-cloud

> **This repository is a fork of the personal [Wolffish](https://github.com/thewolffish) setup.** It carves the existing local-first personal-agent repos into one monorepo and re-aims them at a multi-tenant B2B platform. The personal repos remain the upstream and keep their own history; every folder here was carried over from its personal repo (see [Provenance](#provenance)).

**Keep the agent on the device. Move the truth to the edge.**

Wolffish Cloud is the enterprise edition of Wolffish — a B2B platform where every employee runs their own local AI agent on their own machine, while every config, setting, conversation, and file syncs to a Cloudflare-backed master record owned by their company. Admins route every model request, govern who uses which model, cap token spend, watch the stream in real time, and revoke access instantly.

---

## The vision

Wolffish today is a personal agent: `~/.wolffish` on your machine is the single source of truth, and the relay is a dumb pipe that forwards end-to-end-encrypted bytes and retains nothing. Delete the folder and the agent is gone — one device, one truth, one owner.

Wolffish Cloud inverts exactly one architectural fact, and it changes everything about ownership, governance, and recoverability:

**The API becomes the master; the device folder becomes the cache.**

- The agent still runs entirely on the employee's device — the brain, the tools, the files, the sessions. Execution never moves to the cloud.
- After every execution, an outbox ships the results (conversation records, memory episodes, generated files, settings deltas) to the org's API. Reinstall the app, log in, and the exact same state returns.
- The agent never calls a model provider directly. Every model request flows through one choke-point Worker that authenticates the device, enforces the org's model allowlist and token budgets, strips identity to an anonymous UUID, and forwards to Cloudflare AI Gateway on **Zero Data Retention**.
- Two guarantees, deliberately separate: **the org retains everything the agent did** (its own master record), and **no model provider retains anything about the request** (ZDR). Nothing is lost, and nothing leaks.
- Cloud-model keys never exist on the employee device. Provider keys live at the router (BYOK per org); the device gets short-lived scoped tokens.

### Two tiers, one system

| Tier | Where | What lives there |
| --- | --- | --- |
| **Tier 1 — the agent** | Employee device | The 15-region brain (prefrontal, thalamus, hippocampus, cerebellum, cortex, …), skills as markdown + plugins, services, the markdown workspace. `~/.wolffish` becomes workbench + cache. |
| **Tier 2 — the master** | Cloudflare edge | One choke-point Worker (auth, ZDR router, sync ingest, device relay, admin backend). D1 holds the relational master, R2 the blobs, KV the hot config, Durable Objects the per-device/per-conversation state, Queues the async work. |

---

## Repository layout

```
wolffish-cloud/
├── apps/
│   ├── api/         · NEW — the master API, one Cloudflare Worker, live at api.wolffi.sh (Tier 2)
│   ├── desktop/     ← wolffish-app       · the Electron desktop agent (Tier 1)
│   ├── mobile/      ← wolffish-mobile    · the Expo/React Native remote
│   └── site/
│       ├── landing/ ← wolffish-landing   · marketing site (Next.js)
│       └── docs/    ← wolffish-docs      · documentation (Mintlify, EN + AR)
└── packages/
    └── extension/   ← wolffish-extension · browser capability, bundled into desktop
```

Except `apps/api` — the first genuinely new code — each folder is a clean export of the corresponding personal repo: same code, same READMEs, own lockfiles, with the per-module `LICENSE` files (all identical MIT) collapsed into one root [LICENSE](LICENSE). The carried clients have not been rewired yet.

## The modules

### `apps/desktop` — the agent (from `wolffish-app`)

A local-first, markdown-powered personal AI desktop agent built with Electron (macOS, Windows, Linux). Built around a 15-module runtime modeled after the human brain — routing, planning, memory consolidation, safety gating — with every piece of state in readable markdown and a `cortex.db` SQLite index derived from it. Skills are markdown procedures plus optional plugins under `brain/cerebellum/<name>/SKILL.md`; services connect models, MCP, Google/GitHub/Notion and channel providers.

**What it becomes:** stays local-first; gains device login (OAuth 2.0 device authorization grant), the outbox sync engine, and a router client replacing direct model calls. `~/.wolffish` becomes the cache tier — files release under an eviction policy and rehydrate from R2 on demand. This is the biggest unchanged asset: the brain, the skills system, the services and the markdown workspace carry over nearly untouched.

### `apps/mobile` — the remote (from `wolffish-mobile`)

The companion phone app (Expo/React Native, iOS + Android). Today it pairs with the desktop over an end-to-end-encrypted tunnel through the relay.

**What it becomes:** remote only — talks to the tenant's API instead of a standalone relay.

### `apps/api` — the master (new code, live)

The single choke-point Worker at `api.wolffi.sh` — every request the clients make flows through it. Auth (invite-only, temp password, forced first-login reset, 15-minute signed access tokens, rotating refresh with reuse detection, instant server-side revoke), the model router (OpenAI-compatible `/ai/v1/chat/completions` proxying DeepInfra DeepSeek models behind per-user allowlists, daily/monthly token quotas, and exact usage metering with upstream cost), sync (last-write-wins config, idempotent outbox batches, content-addressed files in R2, one-call bootstrap restore), and the full admin layer as pure API — invites, roles, policies, suspend/revoke, PIN clear, usage, audit. There is deliberately **no separate admin console**: the admin UI lives in the admin's own desktop client, and every admin endpoint re-verifies the role server-side.

Single-org by design (the fork is the tenant boundary), backed by D1 (`wfc-master`), KV (`wfc-auth`, `wfc-config`), and R2 (`wfc-blobs`). Ships with a deterministic 50-employee "Wolffish Inc" demo seed and a traffic simulator that drives the real API with no test-mode bypass. Verified by per-layer smoke suites (76 checks against local simulations) plus a 58-check live suite and the 50-employee simulator against the deployed edge.

### `apps/site` — the tenant-facing web (from `wolffish-landing` + `wolffish-docs`)

Two repos placed side by side for now: the bilingual (EN/AR) Next.js landing page published at wolffi.sh, and the bilingual Mintlify documentation published at docs.wolffi.sh.

**What it becomes:** one white-labelable marketing + docs site per tenant.

### `packages/extension` — the browser capability (from `wolffish-extension`)

The browser extension that gives the agent eyes and hands in Chrome. Internally a small pnpm/turbo workspace (`chrome-extension`, `pages`, shared packages). It lives under `packages/` rather than `apps/` because it is bundled into the desktop app, not deployed on its own.

**What it becomes:** bundled as before; its endpoint points at the tenant's API.

### Planned, not yet created

Per the engineering plan, these workspaces will be **new** code and deliberately do not exist yet:

| Planned workspace | What it will be |
| --- | --- |
| `packages/protocol` | The tunnel wire contract, today vendored in each repo, extracted to one shared source — and extended into the API contract. |
| `packages/auth` | Session client (login, token refresh, session guard) — shared by desktop/mobile. |
| `packages/sync` | The outbox engine + idempotent ingest client — shared by desktop/mobile. |
| `packages/types` | Shared TypeScript types for the master data model. |

(The formerly planned `apps/admin` web console was cut by design: the admin layer shipped as pure API inside `apps/api`, and its UI belongs to the admin's desktop client. The device relay/tunnel from `wolffish-relay` still gets re-homed into `apps/api` as Durable Objects when mobile integration lands, with the upstream repo as the reference.)

Monorepo tooling (pnpm workspaces + Turborepo, one lockfile, orchestrated builds) also comes later. Right now every app is self-contained exactly as its source repo was: `cd` into it, install with its own package manager, run it as its own README describes.

---

## How it all works together

One path, one choke point — the same Worker that authenticates the device routes the model call and ingests the sync batch. That is what makes per-user attribution, model allowlists, quotas and real-time monitoring possible without touching client config.

1. **Login** — the desktop agent logs in like a smart TV: it shows a short device code, the employee approves it in a browser through their org's SSO (Cloudflare Access), and the app receives a short-lived access token plus a rotating refresh token bound to a `device_sessions` row. Admin revoke is one call: token killed, connection dropped, kill signal pushed to the device.
2. **Provision** — the app fetches its config, skill catalog, model allowlist and file manifest lazily, on demand. Reinstall is a non-event: a fresh app is a blank workspace that streams down only what the employee actually touches.
3. **Run** — the agent does the work locally: brain, tools, files, sessions. Nothing syncs during execution.
4. **Route** — every model request hits `POST /ai/v1/chat/completions` on the org's API: verify device session → enforce model allowlist + token caps → replace identity with an anonymous UUID → forward to AI Gateway with `store:false` (ZDR) → stream back → meter tokens, latency, cost → write a usage row → emit a telemetry event to the admin stream.
5. **Sync** — on turn completion the agent writes a durable batch to a local outbox: records go to the API (idempotent — client-generated id + sequence, replays are no-ops), files go to R2 content-addressed by hash. Acknowledged entries become eligible for local eviction.
6. **Govern** — the admin console reads the same telemetry the router and sync engine emit: live stream (who, which model, tokens, latency, cost, decision — never prompt content), edit rules that push to devices live, assist with consent, revoke instantly. Every admin action lands in the audit log.

---

## Releases, deployment, and the per-tenant model

**This repository ships no production builds.** There is no desktop app distribution, no mobile store deployment, no extension store publishing, and no hosted production environment here — which is also why the personal setup's signing and certificate material (`wolffish-signing`, `wolffish-certs`) is not part of this monorepo, and never will be.

Instead, wolffish-cloud is developed as a complete **open-source enterprise platform** and versioned as tagged releases of the source. The deployment model is fork-per-tenant:

1. **Fork** this repository for each Wolffish Cloud client.
2. **Customize** it to them — branding, white-label app builds, their `api.<their>.domain` endpoint, their defaults and policies.
3. **They deploy under their own everything** — their own Cloudflare account (or their own D1 database + R2 bucket), their own BYOK model-provider keys, their own Apple/Google developer accounts and store listings, their own signing keys, their own domains and SSO.

Nothing about the agent's code changes between tenants — only the endpoint and the branding. The whole stack is per-tenant exportable by design, and a "local-only" storage policy (raw work product never leaves the device) can be enabled per org.

## Status & roadmap

**Current state:** the monorepo is carved (desktop, mobile, extension, landing and docs placed unmodified) and **the master API is built and live at `api.wolffi.sh`** — auth, roles, the DeepInfra router, sync, the admin layer, and the seeded 50-employee Wolffish Inc demo org, verified end to end on the deployed edge (58-check live suite + concurrent-employee simulator). No CI/CD or workspace tooling yet.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Carve the monorepo; place the sources | done |
| 1 | API: auth — users, roles, invites, sessions, password login, revoke | done, live |
| 2 | API: router — DeepInfra DeepSeek, allowlists, quotas, metering | done, live |
| 3 | API: sync — config, outbox ingest, R2 files, bootstrap restore | done, live |
| 4 | API: admin layer + Wolffish Inc seed + simulator | done, live |
| 5 | Desktop: strip providers/services, add login + PIN + org provider + sync client (`~/.wolffish` → `~/.wolffish-cloud` as a cache) | next |
| 6 | Mobile re-aim (sync from desktop, tunnel re-homed into the API); packages extraction; CI/CD; release tagging | later |

## Provenance

Every folder is a clean export of the corresponding personal repo (tracked files only, no history imported). The original repos remain the reference for history before the carve; the exact export commits are recorded in this repo's initial commit message.

| Folder | Source repo |
| --- | --- |
| `apps/desktop` | [wolffish-app](https://github.com/thewolffish/wolffish-app) |
| `apps/mobile` | [wolffish-mobile](https://github.com/thewolffish/wolffish-mobile) |
| `apps/site/landing` | [wolffish-landing](https://github.com/thewolffish/wolffish-landing) |
| `apps/site/docs` | [wolffish-docs](https://github.com/thewolffish/wolffish-docs) |
| `packages/extension` | [wolffish-extension](https://github.com/thewolffish/wolffish-extension) |

## License

The entire repository — every app and package — is covered by a single [MIT license](LICENSE) at the root, © 2026 Younes Alturkey. Third-party licenses bundled with assets (such as font OFL files) remain alongside those assets.
