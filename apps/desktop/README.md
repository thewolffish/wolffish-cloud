<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="Wolffish Cloud" />
</picture>

# wfc-desktop

**The employee's agent, cloud-first.**

The Wolffish Cloud desktop app — a fork of the personal [wolffish-app](https://github.com/thewolffish/wolffish-app) re-aimed at the enterprise platform. The full 15-region agent brain runs on the employee's machine exactly as before; everything model- and state-shaped moves to the org's API: models are served and governed by [Wolffish Cloud](https://api.wolffi.sh), configs and conversations sync to the master record, and `~/.wfc` is a cache — deletable, restorable by signing in.

**Dev-only by design.** This app runs with `npm run dev` and is never packaged, signed, or released from this repo. Each client fork ships its own build through its own deployment workflow, under its own identity and keys (see `electron-builder.yml` for the wiring guide). It runs cleanly alongside personal Wolffish: different app id (`cloud.wolffish.dev`), different data folder (`~/.wfc` vs `~/.wolffish`), zero shared state.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| Prune | Providers, Ollama/local models, signing/release/updater machinery, changelog removed; single cloud lane; bypass toggle moved into the chat composer; `.wfc` home; `wfc-desktop` identity | ✅ done |
| Auth | Sign-in screen (email + password, forced first-login reset), PIN quick-lock, keychain-sealed session storage + refresh loop, admin PIN clear / revoke | ✅ done |
| API integration | Server-driven model catalog, streaming through `/ai/v1/chat/completions`, config LWW row, conversations + workspace files as the outbox, restore on sign-in, usage from the metering table, capabilities from the registry | ✅ done |

### The cloud-first contract

- **One model lane.** No provider list, no API keys on the device, no local models. `src/main/runtime/providers/cloud.ts` speaks the org router with the session token; `GET /v1/models` drives every model surface, and the org's allowlist/quota decide what runs.
- **`~/.wfc` is a cache.** `src/main/cloud/sync.ts` pushes every conversation turn (incrementally), every workspace file (content-addressed blobs) and the config row seconds after they change, tombstones deletions durably, and restores a fresh install from the org before the chat screen opens — conversation media hydrates on open. The usage ledger is rebuilt from `GET /v1/usage`. The full per-path map is in `src/defaults/AGENTS.md` (§3, "What syncs").
- **Proof lives in the sims.** `src/main/cloud/__tests__/purge-cycle*.test.ts` purge a lived-in workspace and restore it — against an in-process fake, the real Worker (`wrangler dev`), and at 700 conversations with per-conversation media — through the real engine and the real fresh-install boot.
- **Chat carries the knobs.** Reasoning effort, chat mode, and the ask/bypass permissions switch live as chip rows in the composer's model card.
- **The agent core is untouched.** Brain regions, skills, services, channels, workspace — carried over from upstream, minus what only made sense standalone.

## Run

```bash
npm install
npm run dev
```

`npm run typecheck` and `npm run lint` are the gates; there is no build script on purpose.

## Layout

Everything lives in `~/.wfc` (workspace, runtime, logs). Delete the folder to reset — in the cloud-first end state that costs nothing, because the master record lives at the org API.

MIT · part of [thewolffish/wolffish-cloud](https://github.com/thewolffish/wolffish-cloud)
