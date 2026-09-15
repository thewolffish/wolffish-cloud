<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="wolffish" />
</picture>

# wolffish-cloud docs

**The internal documentation a company hands to its own people.**

The documentation for [Wolffish Cloud](../../../README.md) — the enterprise edition where the agent
runs on the employee's machine and the organization's API is the master record.

These pages are written to be **deployed as-is by a customer** and branded afterwards: the product
name appears in `docs.json` and the assets, not scattered through the prose. See
[BRANDING.md](BRANDING.md) for the swap list.

Bilingual (English + Arabic, full RTL). Built with [Mintlify](https://mintlify.com); the whole site
is `docs.json` plus the `.mdx` pages beside it.

---

## What's inside

Twenty-two pages per language, in three audiences: **everyone who uses the agent**, **admins**, and
**whoever runs the deployment**. Deliberately small: this documents **this** repository and **this**
API, and nothing else.

### Start

| Page | What it covers |
| --- | --- |
| [`introduction/overview`](introduction/overview.mdx) | The inversion — agent on the device, record at the edge. Who the docs are for, the two tiers, the four surfaces, and what this edition removed. |
| [`introduction/architecture`](introduction/architecture.mdx) | The map: where every part runs, the three Durable Objects, what is in D1 / R2 / KV, and what never reaches the edge. |
| [`getting-started/setup`](getting-started/setup.mdx) | Activate an account with the emailed code, sign in, set a PIN, pair a phone, install the extension, install the terminal client. |

### Using the agent — the employee layer

| Page | What it covers |
| --- | --- |
| [`using/agent`](using/agent.mdx) | The anatomy of a turn; model, thinking, mode, plan and permissions; approvals; per-turn undo; long conversations. |
| [`using/capabilities`](using/capabilities.mdx) | The 35-capability catalog by group, the two built-ins, the four org-provided services, and how to add your own. |
| [`using/workspace`](using/workspace.mdx) | Projects, procedures, automations, the nine knowledge files, workspace files and variables. |
| [`using/surfaces`](using/surfaces.mdx) | Desktop, phone, browser extension and the `wfc` terminal — what each is for. The leaderboard. |
| [`using/privacy`](using/privacy.mdx) | What reaches the organization, who can read it, what never leaves the machine. Written to be handed to employees. |

### Sync

| Page | What it covers |
| --- | --- |
| [`sync/overview`](sync/overview.mdx) | Who writes, who reads, what syncs and what never does. |
| [`sync/desktop`](sync/desktop.mdx) | The outbox, incremental pushes, message overflow, config last-write-wins, the file sweep, restore, the catch-up pull. |
| [`sync/mobile`](sync/mobile.mdx) | Pairing, the bridge, the catch-up cursor, the dirty-key outbox, what the phone can change, notifications. |
| [`sync/browser-extension`](sync/browser-extension.mdx) | The `localhost` channel, and why it has no cloud endpoint. |
| [`sync/capabilities`](sync/capabilities.mdx) | The registry, the two scopes, grants, a sync pass, publishing, the package format. |

### Governance

| Page | What it covers |
| --- | --- |
| [`governance/roles`](governance/roles.mdx) | The four roles, the two-axis rule table, adding people, the two audited reads. |
| [`governance/quotas`](governance/quotas.mdx) | Allowlists, daily caps, token plans, how a limit resolves, and why capacity is not a quota. |
| [`governance/org-controls`](governance/org-controls.mdx) | The config overlay, capability grants, teams, and what an admin sees per person. |
| [`governance/audit`](governance/audit.mdx) | The usage ledger, the audit log, the two audited reads, what is deliberately not recorded, and retention. |

### The API

| Page | What it covers |
| --- | --- |
| [`api/overview`](api/overview.mdx) | Every endpoint, grouped: public, auth + activation, session, sync, capabilities, the lanes, admin, the publish lane. |
| [`api/auth`](api/auth.mdx) | Activation codes, passwords, the two tokens, rotation and reuse detection, revocation, the local PIN, pairing, rate limits. |
| [`api/lanes`](api/lanes.mdx) | The model lane and the search lane: `ModelGate`, `SearchGate`, streaming, cooldowns, leases, privacy. |

### Operations

| Page | What it covers |
| --- | --- |
| [`operations/rollout`](operations/rollout.mdx) | Standing a deployment up: bindings, secrets, the first owner, the org row, the publish key, inviting people, proving it works. |
| [`operations/operate`](operations/operate.mdx) | Main is the deployment; the three verification layers, the nightly run, and a troubleshooting index. |

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

Arabic pages must not use heading anchors (`](/ar/page#عنوان)`) — link to the page instead. English
anchors are fine and are checked by `mint broken-links`.

---

## House rules

- **Document what is in this repository.** If it is not in `apps/api`, `apps/desktop`,
  `apps/mobile`, `packages/extension` or `capabilities/`, it does not belong here.
- **Write for the reader, not for the repo.** Three audiences share these pages. An employee should
  never have to read an endpoint table to use the agent, and an admin should never have to infer a
  rule from a paragraph aimed at employees.
- **Name the mechanism, not the promise.** "The counters live in the gate's durable storage, so they
  are exact" beats "quotas are reliable".
- **Brand belongs in `docs.json`, not in prose.** Say "the desktop app", "the platform", "your
  organization". The product name should survive a rebrand without a find-and-replace through the
  pages — see [BRANDING.md](BRANDING.md).
- **Removed means removed.** No page may describe per-user model providers, Telegram, WhatsApp,
  Notion, GitHub, Google Workspace, video generation or episodic memory. They are gone from the
  code; the only place they may appear is the removal table in
  [`introduction/overview`](introduction/overview.mdx). (The `wfc` terminal client is **not** on
  this list — it was removed and then returned as a full client, and it is documented in
  [`using/surfaces`](using/surfaces.mdx).)
- **Keep it small.** A page that has to be skimmed to be used is too long. If a section grows past
  its page, it probably belongs in the source comments instead — the code in this repository is
  heavily commented on purpose, and these pages point at it rather than duplicating it.
- **Verify before writing.** Numbers here (TTLs, caps, ports, retention windows, capability counts)
  are read out of the source, not remembered. When the source changes, the page changes with it.

---

## License

MIT, © 2026 Younes Alturkey — covered by the [root license](../../../LICENSE).
