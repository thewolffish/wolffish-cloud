<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="wolffish" />
</picture>

# wolffish-cloud docs

**Where the agents run, how syncing works, and how spend is capped and logged.**

The documentation for [Wolffish Cloud](../../../README.md) — the enterprise edition where the agent
runs on the employee's machine and the organization's API at `api.wolffi.sh` is the master record.

Bilingual (English + Arabic, full RTL). Built with [Mintlify](https://mintlify.com); the whole site
is `docs.json` plus the `.mdx` pages beside it.

---

## What's inside

Sixteen pages per language. Deliberately small: this documents **this** repository and **this** API,
and nothing else.

### Start

| Page | What it covers |
| --- | --- |
| [`introduction/overview`](introduction/overview.mdx) | The inversion — agent on the device, record at the edge. The two tiers, the three surfaces, and the full list of what this edition removed. |
| [`introduction/architecture`](introduction/architecture.mdx) | The map: where every part runs, the three Durable Objects, what is in D1 / R2 / KV, and what never reaches the edge. |
| [`getting-started/setup`](getting-started/setup.mdx) | Sign in on the desktop, set a PIN, first restore. Pair a phone. Install the extension. |

### The API

| Page | What it covers |
| --- | --- |
| [`api/overview`](api/overview.mdx) | Every endpoint, grouped: public, auth + pairing, session, sync, capabilities, the lanes, admin. |
| [`api/auth`](api/auth.mdx) | Passwords, the two tokens, rotation and reuse detection, revocation, the local PIN, pairing. |
| [`api/lanes`](api/lanes.mdx) | The model lane and the search lane: `ModelGate`, `SearchGate`, streaming, cooldowns, leases, privacy. |

### Sync

| Page | What it covers |
| --- | --- |
| [`sync/overview`](sync/overview.mdx) | Who writes, who reads, what syncs and what never does. |
| [`sync/desktop`](sync/desktop.mdx) | The outbox, incremental pushes, config last-write-wins, the file sweep, restore, media hydration. |
| [`sync/mobile`](sync/mobile.mdx) | Pairing, the bridge, the catch-up cursor, the dirty-key outbox, notifications. |
| [`sync/browser-extension`](sync/browser-extension.mdx) | The `localhost` channel, and why it has no cloud endpoint. |
| [`sync/capabilities`](sync/capabilities.mdx) | The registry, the two scopes, a sync pass, publishing, the package format. |

### Governance

| Page | What it covers |
| --- | --- |
| [`governance/roles`](governance/roles.mdx) | The four roles, managing people, repairing a user's settings, the org row. |
| [`governance/quotas`](governance/quotas.mdx) | Allowlists, daily caps, token plans, how a limit resolves, and why capacity is not a quota. |
| [`governance/audit`](governance/audit.mdx) | The usage ledger, the audit log, what is deliberately not recorded, and retention. |

### Operations

| Page | What it covers |
| --- | --- |
| [`operations/operate`](operations/operate.mdx) | The three verification layers, the nightly run, and a troubleshooting index. |

Arabic mirrors every page under [`ar/`](ar/) with the same paths.

---

## Working on the docs

```bash
npm i -g mint     # the Mintlify CLI
mint dev          # serve this folder at localhost:3000
mint broken-links # check internal links
```

Both languages must move together: `docs.json` lists every page twice, once per language tab, and a
page that exists in one tree and not the other is a broken nav entry. Adding a page means adding
both files **and** both `docs.json` entries.

Check the two stay aligned:

```bash
find . -name '*.mdx' | sed 's|^\./||;s|\.mdx$||' | sort
```

Everything on that list should appear in `docs.json`, and every non-`ar/` page should have an `ar/`
twin.

---

## House rules

- **Document what is in this repository.** If it is not in `apps/api`, `apps/desktop`,
  `apps/mobile`, `packages/extension` or `capabilities/`, it does not belong here.
- **Name the mechanism, not the promise.** "The counters live in the gate's durable storage, so they
  are exact" beats "quotas are reliable".
- **Removed means removed.** No page may describe per-user model providers, Telegram, WhatsApp,
  Notion, GitHub, Google Workspace, video generation, episodic memory or the `wfc` CLI. They are
  gone from the code; the only place they may appear is the removal table in
  [`introduction/overview`](introduction/overview.mdx).
- **Keep it small.** A page that has to be skimmed to be used is too long. If a section grows past
  its page, it probably belongs in the source comments instead — the code in this repository is
  heavily commented on purpose, and these pages point at it rather than duplicating it.
- **Verify before writing.** Numbers here (TTLs, caps, ports, retention windows) are read out of the
  source, not remembered. When the source changes, the page changes with it.

---

## License

MIT, © 2026 Younes Alturkey — covered by the [root license](../../../LICENSE).
