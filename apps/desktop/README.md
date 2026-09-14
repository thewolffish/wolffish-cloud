<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="Wolffish Cloud" />
</picture>

# wfc-desktop

**The employee's agent, cloud-first.**

The Wolffish Cloud desktop app — a fork of the personal [wolffish-app](https://github.com/thewolffish/wolffish-app) re-aimed at the enterprise platform. The full 15-region agent brain runs on the employee's machine exactly as before; everything model- and state-shaped moves to the org's API: models are served and governed by [Wolffish Cloud](https://api.wolffi.sh), configs and conversations sync to the master record, and `~/.wfc` is a cache — deletable, restorable by signing in.

**Dev-only by design.** This app runs with `npm run dev` and is never packaged, signed, or released from this repo. Each client fork ships its own build through its own deployment workflow, under its own identity and keys (see `electron-builder.yml` for the wiring guide). It runs cleanly alongside personal Wolffish: different app id (`cloud.wolffish.dev`), different data folder (`~/.wfc` vs `~/.wolffish`), zero shared state.

## Status

| Phase           | Scope                                                                                                                                                                                                                                                                                                               | State   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Prune           | Providers, Ollama/local models, signing/release/updater machinery, changelog removed; single cloud lane; bypass toggle moved into the chat composer; `.wfc` home; `wfc-desktop` identity; the CLI's provider/Ollama verbs and cards, the bundled provider config keys and the vendor code paths swept out (2026-09) | ✅ done |
| Auth            | Sign-in screen (email + password, forced first-login reset), PIN quick-lock, keychain-sealed session storage + refresh loop, admin PIN clear / revoke                                                                                                                                                               | ✅ done |
| API integration | Server-driven model catalog, streaming through `/ai/v1/chat/completions`, config LWW row, conversations + workspace files as the outbox, restore on sign-in, usage from the metering table, capabilities from the registry                                                                                          | ✅ done |

### The cloud-first contract

- **One model lane.** No provider list, no API keys on the device, no local models. `src/main/runtime/providers/cloud.ts` speaks the org router with the session token; `GET /v1/models` drives every model surface, and the org's allowlist/quota decide what runs.
- **`~/.wfc` is a cache.** `src/main/cloud/sync.ts` pushes every conversation turn (incrementally), every workspace file (content-addressed blobs) and the config row seconds after they change, tombstones deletions durably, and restores a fresh install from the org before the chat screen opens — conversation media hydrates on open. The usage ledger is rebuilt from `GET /v1/usage`. Signing out drains the outbox, revokes the session and purges the cache; the next sign-in restores it. The full per-path map is in `src/defaults/AGENTS.md` (§3, "What syncs").
- **Sync goes both ways.** Restore is the one-time event; the steady state is a catch-up pull every two minutes over `GET /v1/conversations?since=<cursor>` — the same feed the phone runs on. Conversations written on the user's OTHER machine arrive, tombstones cross, and a merge is a union by message id, so a turn run here while the other machine was writing survives it. Two desktops signed in at once converge in both directions; `__tests__/catch-up.test.ts` runs exactly that, alternating two sandboxed devices against a real Worker.
- **Proof lives in the sims.** `src/main/cloud/__tests__/purge-cycle*.test.ts` purge a lived-in workspace and restore it — against an in-process fake, the real Worker (`wrangler dev`), and at 700 conversations with per-conversation media — through the real engine and the real fresh-install boot. `catch-up.test.ts` covers the case those cannot: two devices live at the same time. Both need a worker (`cd ../api && npm run dev`) and stay a local step, like the API's own smoke suites.
- **Chat carries the knobs.** Reasoning effort, chat mode, and the ask/bypass permissions switch live as chip rows in the composer's model card.
- **The agent core is untouched.** Brain regions, skills, services, channels, workspace — carried over from upstream, minus what only made sense standalone.

## Run

```bash
npm install
npm run dev
```

`npm run typecheck` and `npm run lint` are the gates; there is no build script on purpose.

### The terminal

`wfc` is a full terminal client, built for a monitorless box as much as for a laptop next to the app. It is a Bun + OpenTUI program under `src/cli` that talks to the running desktop over the local socket, so it holds no agent state of its own: close the terminal and the turn keeps running.

```
wfc                     the session screen: streaming feed, cards, live context meter
wfc -p "…" [-f file]    one shot — print and exit (pipes: cat log | wfc -p "why?")
wfc resume [id]         continue a conversation
wfc conversations …     the app's screens as verbs, with --json for scripts
wfc settings …          every setting, and every action the app has
wfc status | usage | service | path | pair
wfc login | logout | unlock | account   the same sign-in as the window: email + password, then your PIN
wfc reset-password | activate | change-password | change-pin
```

While `npm run dev` is running, the desktop writes a `wfc` shim into `~/.wfc/bin` that runs the client straight from `src/cli` under Bun, so every launch is the code on disk — no build step. Inside the session: `ctrl+p` opens the command palette, `/` completes slash commands, `@path` attaches a file, `shift+enter` inserts a newline, `esc esc` interrupts, and the footer shows the model, mode, thinking effort, plan mode, project, elapsed time, context used and cost. Approvals, questions, todos, diffs and countdowns render as cards. Settings open as a page → card → row browser with search across every row. `npm run cli:typecheck` and `npm run cli:test` are its gates; `npm run cli:build` compiles the host binary into `build/cli/host` for a look at the artifact a client fork would ship.

## Layout

Everything lives in `~/.wfc` (workspace, runtime, logs). Delete the folder to reset — in the cloud-first end state that costs nothing, because the master record lives at the org API.

MIT · part of [thewolffish/wolffish-cloud](https://github.com/thewolffish/wolffish-cloud)
