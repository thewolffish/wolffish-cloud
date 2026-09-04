# Wolffish — Agent Guide

The Wolffish Cloud desktop client — the employee's agent, cloud-first. Electron + React + TypeScript. The runtime is modeled as a 15-module brain — see `ARCH.md` for the full mapping.

## Stack

- Electron via `electron-vite`. Three processes: **main** (Node), **preload** (bridge), **renderer** (React).
- Tailwind v4, i18next (en / ar). Models are served and governed by the org API — no local inference, no provider keys on the device.
- IPC is the only main↔renderer channel. Never import main code from the renderer or vice versa — go through `preload`.

## Project layout

```
src/
├── main/            Electron main process (Node)
│   ├── index.ts     entry — IPC handlers live here
│   ├── cloud/       the org API — auth, sync, capability + catalog mirrors
│   ├── channels/    the surfaces a turn arrives on (electron/, mobile/, extension/)
│   ├── uploads/     attachment staging, validation, owned copies
│   ├── workspace/   ~/.wfc init, config, purge
│   ├── lockfile.ts  single-instance guard
│   ├── system.ts    OS info (platform, RAM, disk)
│   └── runtime/     the brain — one file per region
│       ├── thalamus.ts, prefrontal.ts, hippocampus.ts, ...
│       └── providers/cloud.ts  the single model lane (the org API)
├── preload/         contextBridge — types in index.d.ts
├── renderer/src/
│   ├── App.tsx, main.tsx, env.d.ts, assets/
│   ├── components/  common/ (composed) and core/ (primitives)
│   ├── pages/       one file per screen (auth/ and settings/ group their own)
│   ├── providers/   React context providers
│   ├── hooks/       custom hooks
│   └── lib/         i18n, utils
└── defaults/workspace/  bundled into the app, copied to ~/.wfc on first launch
                         (capabilities are NOT here — they live cloud-first in the
                         org registry; sources in <repo>/capabilities/, synced by
                         main/cloud/capabilitySync.ts)

resources/   fonts/, icons/, images/  (use @resources alias)
scripts/     build helpers (one folder each)
```

## Folder convention — one thing per folder

Every module lives in its own kebab-case folder, and the file inside matches the folder name:

```
components/common/reasoning-card/ReasoningCard.tsx
hooks/use-zoom-pan/useZoomPan.ts
providers/locale/LocaleProvider.tsx
```

When a file has both a component and a hook (Fast Refresh requires single-purpose files), split them:

```
providers/flow/FlowProvider.tsx   ← component only
providers/flow/useFlow.ts         ← context + hook + types
```

Same pattern for `Toast`, `Theme`, `Locale`. The hook file holds the `Context`, the `useX` hook, and any related types.

## Path aliases — always use these, never relative across folders

| Alias                                                             | Target                      |
| ----------------------------------------------------------------- | --------------------------- |
| `@main/*`                                                         | `src/main/*`                |
| `@preload/*`                                                      | `src/preload/*`             |
| `@renderer/*`                                                     | `src/renderer/src/*`        |
| `@components/*`, `@hooks/*`, `@lib/*`, `@pages/*`, `@providers/*` | matching renderer subfolder |
| `@resources/*`                                                    | `resources/*`               |

Configured in `electron.vite.config.ts`, `tsconfig.web.json`, `tsconfig.node.json`. Inside one folder, use `./` only for files in the same folder. Cross-folder = always alias.

## Data location — `~/.wfc/` is the entire footprint

Hard rule: **uninstall must be `rm -rf ~/.wfc/`**. Every byte the app writes goes there:

- `~/.wfc/workspace/` — user data (config.json + brain/ folders)
- `~/.wfc/runtime/` — Chromium state (cookies, localStorage, GPU cache, ...) via `app.setPath('userData', ...)`
- `~/.wfc/logs/` — via `app.setAppLogsPath(...)`
- `~/.wfc/bin/` — every managed binary: `ffmpeg` and the voice engines. One directory on every platform.

Do not write outside this tree. Do not introduce keytar / electron-store / safeStorage / OS keychains. The Snap target in `electron-builder.yml` is the one known exception (Snap confines writes to `~/snap/`); flag it before shipping a Snap.

**When a location is a free choice, it is `~/.wfc/`.** Convention is not a reason to leave the tree: a managed binary briefly lived in `~/.local/bin` because that is the XDG norm and "already on PATH" — but it is _not_ in macOS's default PATH (`/etc/paths` lists only `/usr/local/bin` and the system dirs), so the convenience was imaginary on one platform and the file survived `rm -rf ~/.wfc` on all of them.

The exception is a location the OS _owns_, where a file elsewhere would simply never be read. Today that is exactly one thing: the Linux autostart entry at `~/.config/autostart/`. It is written only on an explicit user action, it is removed by its own uninstall path, and `src/main/autostart/` is the only place it appears. (That module also SWEEPS the launchd/systemd/schtasks service registrations older builds wrote, which is a removal, not a new location.) Adding a new one needs the same justification: a session manager that reads nowhere else.

Workspace init runs **only when `~/.wfc/workspace/` does not exist** — see `workspace/workspace.ts:ensureWorkspace`. Never overwrite an existing workspace.

## Commands

```bash
npm run dev          # electron-vite dev (HMR for renderer, restart for main)
npm run typecheck    # node + web tsc
npm run lint         # eslint
npm run build        # typecheck + build
npm run build:mac    # produce a .dmg (similar: build:win, build:linux)
```

Always run `npm run typecheck` after structural changes — Vite's HMR can mask type errors that break a production build.

## Conventions to preserve

- **No comments unless the _why_ is non-obvious.** Don't narrate what the code does; identifiers do that.
- **No barrel `index.ts` files** unless we adopt them globally — current style is explicit file paths via aliases.
- **Default to terse responses, no scope creep.** A bug fix is a bug fix.
- **Frontend changes need a browser check**, not just typecheck — `npm run dev` and exercise the path.

## Brain mapping (cheat sheet)

Renderer triggers a turn → `agent.ts` orchestrates: `thalamus` (route to provider) → `prefrontal` (build system prompt from `brain/identity`, `brain/prefrontal`, recent episodes) → provider streams tokens → `hippocampus` archives the episode. `amygdala` gates dangerous tool calls; `basalganglia` records feedback; `brainstem` is the heartbeat. Full reasoning in `ARCH.md`.

## Known gotchas

- Page files moved one folder deeper — relative `../../resources/...` imports break. Use `@resources/*`.
- React Fast Refresh fails when a file exports a component **and** a non-component runtime value. Split them (see provider/hook pattern above).
