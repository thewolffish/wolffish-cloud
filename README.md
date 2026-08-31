# wolffish-cloud

> **This repository is a fork of the personal [Wolffish](https://github.com/thewolffish) setup.** It carves the existing local-first personal-agent repos into one monorepo and re-aims them at a multi-tenant B2B platform. The personal repos remain the upstream and keep their own history; every folder here was carried over from a pinned commit, unmodified (see [Provenance](#provenance)).

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
│   ├── desktop/     ← wolffish-app       · the Electron desktop agent (Tier 1)
│   ├── mobile/      ← wolffish-mobile    · the Expo/React Native remote
│   └── site/
│       ├── landing/ ← wolffish-landing   · marketing site (Next.js)
│       └── docs/    ← wolffish-docs      · documentation (Mintlify, EN + AR)
└── packages/
    └── extension/   ← wolffish-extension · browser capability, bundled into desktop
```

Each folder is the corresponding personal repo at a pinned commit, **byte-for-byte unmodified** — same code, same READMEs, same licenses, own lockfiles. Nothing has been rewired yet.

## The modules

### `apps/desktop` — the agent (from `wolffish-app`)

A local-first, markdown-powered personal AI desktop agent built with Electron (macOS, Windows, Linux). Built around a 15-module runtime modeled after the human brain — routing, planning, memory consolidation, safety gating — with every piece of state in readable markdown and a `cortex.db` SQLite index derived from it. Skills are markdown procedures plus optional plugins under `brain/cerebellum/<name>/SKILL.md`; services connect models, MCP, Google/GitHub/Notion and channel providers.

**What it becomes:** stays local-first; gains device login (OAuth 2.0 device authorization grant), the outbox sync engine, and a router client replacing direct model calls. `~/.wolffish` becomes the cache tier — files release under an eviction policy and rehydrate from R2 on demand. This is the biggest unchanged asset: the brain, the skills system, the services and the markdown workspace carry over nearly untouched.

### `apps/mobile` — the remote (from `wolffish-mobile`)

The companion phone app (Expo/React Native, iOS + Android). Today it pairs with the desktop over an end-to-end-encrypted tunnel through the relay.

**What it becomes:** remote only — talks to the tenant's API instead of a standalone relay.

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
| `apps/api` | The master — one choke-point Worker at `api.<tenant-domain>`: auth and sessions, the ZDR model router, sync ingest, admin backend, device relay, cron and queues. Built fresh on Cloudflare (Workers + Hono), backed by D1 (relational master), R2 (content-addressed blobs), KV (tokens, allowlists, quota counters), Durable Objects (per-device/per-conversation state), Queues + Cron (async work), and AI Gateway (ZDR routing, failover, unified billing, BYOK). The personal `wolffish-relay` is not carried over; its tunnel protocol and push control plane get reimplemented as Durable Objects inside this Worker, with the upstream repo as the reference. |
| `apps/admin` | The web admin console (React/Vite behind Cloudflare Access) — dashboard, live telemetry stream, people & devices, models & budgets, skills & config, audit log. Monitor, help, edit, revoke. |
| `packages/protocol` | The tunnel wire contract, today vendored in each repo, extracted to one shared source — and extended into the API contract. |
| `packages/auth` | Device-flow client, token refresh, session guard — shared by desktop/mobile. |
| `packages/sync` | The outbox engine + idempotent ingest client — shared by desktop/mobile. |
| `packages/types` | Shared TypeScript types for the master data model. |

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

**Phase 0 (this repo, current state):** monorepo carved; the desktop, mobile, extension, landing and docs repos placed in their target locations, unmodified. The personal relay is deliberately not carried over — `apps/api` will be built fresh on Cloudflare. No new code, no CI/CD, no workspace tooling yet.

| Phase | Scope |
| --- | --- |
| 0 | Carve the monorepo · *sources placed — done* · extraction of `packages/*`, workspace tooling and CI/CD to follow |
| 1 | Auth — orgs, users, roles; device-flow login; session management; Access SSO |
| 2 | Sync engine — outbox, idempotent ingest, D1 master, R2 blobs, restore-on-reinstall |
| 3 | ZDR router — model allowlist, quota ledger, AI Gateway, BYOK vault, attribution |
| 4 | Admin console — live stream, edit rules, help users, revoke; roles + audit |
| 5 | Seed a 50-employee demo org; docs; open-source packaging; white-label fork harness |

## Provenance

Every folder was exported from the corresponding personal repo at the commit below (`git archive` of a clean HEAD — tracked files only, no history imported). The original repos remain the reference for history before the carve.

| Folder | Source repo | Version | Commit |
| --- | --- | --- | --- |
| `apps/desktop` | [wolffish-app](https://github.com/thewolffish/wolffish-app) | 1.0.274 | `718725a3a35baa7e9360993d0da2808753e9e63b` |
| `apps/mobile` | [wolffish-mobile](https://github.com/thewolffish/wolffish-mobile) | 1.0.48 (build 36) | `c753044c8fe6697a13d1003b84d491eab78e63cb` |
| `apps/site/landing` | [wolffish-landing](https://github.com/thewolffish/wolffish-landing) | 1.0.0 | `2aaf88279fe7934a9ee464a6b00af459afaccb62` |
| `apps/site/docs` | [wolffish-docs](https://github.com/thewolffish/wolffish-docs) | — | `8276738bd11e261bfdd1c76c8cea12824127972c` |
| `packages/extension` | [wolffish-extension](https://github.com/thewolffish/wolffish-extension) | 0.1.58 | `bb2b0344ee8a7a08abfa2af73114a08844778cc1` |

## License

Every module carries the MIT license of its source repo (a `LICENSE` file in each folder).
