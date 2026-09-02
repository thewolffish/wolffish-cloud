# Capabilities — org sources, cloud-distributed

The source trees of Wolffish Cloud's official capabilities (one folder per
capability: `SKILL.md` + optional `plugin/`, assets, `package.json`). They
are **not bundled into any client**. The org capability registry — R2
(`wfc-blobs/capabilities/…`) indexed by D1 through `api.wolffi.sh` — is
the distribution source; every desktop client mirrors it on session ready
and stays in sync from then on (`apps/desktop/src/main/cloud/capabilitySync.ts`).

## The rule: every org change lands here first

This folder is the single editing path for org capabilities. Edit (or
add, or delete) the folder, then publish; the registry mirrors git, never
the other way around. Don't `PUT /admin/capabilities/:slug` by hand — a
direct push makes the registry disagree with git, and the check below
will flag it.

```bash
# publish: version-bumps changed capabilities, skips unchanged ones
WFC_DEMO_PASSWORD=... node apps/api/scripts/seed-capabilities.mjs

# publish including removals: deletes registry entries with no folder here
WFC_DEMO_PASSWORD=... node apps/api/scripts/seed-capabilities.mjs --prune

# verify (CI-able): exit 1 if the folder and the live registry disagree
WFC_DEMO_PASSWORD=... node apps/api/scripts/seed-capabilities.mjs --check
```

Every client picks a published change up on its next sync pass — app
start, or within the half-hour interval — swapping folders only while no
runs are active. The registry keeps every uploaded version
(`capabilities/org/<slug>/v<n>.zip`), so a rollback is checking out an
old tree and re-publishing.

## Package format

A capability travels as one deterministic zip (sorted entries, STORE, fixed
timestamps — `apps/api/scripts/lib/zip.mjs` and the desktop's
`capabilityPack.ts` emit identical bytes): `SKILL.md` at the root, no
`node_modules` (clients reinstall lazily), no `.wfc-installed`/`.wfc-tested`
markers (earned per install). The API refuses packages without a root
SKILL.md, with unsafe paths, or whose sha256 doesn't match the upload.
