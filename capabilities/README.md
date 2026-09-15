# Capabilities — org sources, cloud-distributed

The source trees of Wolffish Cloud's official capabilities (one folder per
capability: `SKILL.md` + optional `plugin/`, assets, `package.json`). They
are **not bundled into any client**. The org capability registry — R2
(`wfc-blobs/capabilities/…`) indexed by D1 through `api.wolffi.sh` — is
the distribution source; every desktop client mirrors it on session ready
and stays in sync from then on (`apps/desktop/src/main/cloud/capabilitySync.ts`).

## The rule: git pushes, the registry follows

This folder is the single editing path for org capabilities, and **the
push is the publish**. Edit (or add, or delete) a folder, commit, push to
`main`; `.github/workflows/ci.yml` mirrors this tree into the registry
once the gate jobs are green — changed capabilities version-bump,
unchanged ones are skipped by package hash, and a deleted folder is
retired org-wide (`--prune`). The run then re-reads the registry and
fails if it disagrees with the commit by a byte.

So there is nothing to run by hand for an ordinary change. Don't
`PUT /admin/capabilities/:slug` either: a hand push makes the registry
disagree with git, the next commit overwrites it anyway, and `--check`
flags it in between.

The same script is what runs in CI, if you need it locally — against a
`wrangler dev` (`--base http://127.0.0.1:8787`), or against the live
registry when the pipeline itself is broken:

```bash
# what CI runs: publish changes, retire folders that are gone
WFC_PUBLISH_TOKEN=... node apps/api/scripts/seed-capabilities.mjs --prune

# verify only: exit 1 if this tree and the live registry disagree
WFC_PUBLISH_TOKEN=... node apps/api/scripts/seed-capabilities.mjs --check
```

`WFC_PUBLISH_TOKEN` is the Worker's `PUBLISH_TOKEN` secret — a key that
can write org capabilities and nothing else (`apps/api/src/routes/publish.ts`).
Without it the script falls back to logging in as `--email` with
`WFC_DEMO_PASSWORD` and driving `/admin/capabilities` as a person, which
still works and is how the lane was bootstrapped.

Every client picks a published change up on its next sync pass — app
start, or within the half-hour interval — swapping folders only while no
runs are active. The registry keeps every uploaded version
(`capabilities/org/<slug>/v<n>.zip`), so a rollback is a revert commit:
push the old tree and the pipeline re-publishes it.

## Package format

A capability travels as one deterministic zip (sorted entries, STORE, fixed
timestamps — `apps/api/scripts/lib/zip.mjs` and the desktop's
`capabilityPack.ts` emit identical bytes): `SKILL.md` at the root, no
`node_modules` (clients reinstall lazily), no `.wfc-installed`/`.wfc-tested`
markers (earned per install). The API refuses packages without a root
SKILL.md, with unsafe paths, or whose sha256 doesn't match the upload.
