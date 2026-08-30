# Sample files to publish

New entries for the published sample set at https://cdn.wolffi.sh/samples/ —
the per-type stand-in bytes demo mode serves for workspace paths (see
src/lib/files/sampleFiles.ts). Upload each file here as-is, then make sure it
is listed in src/lib/files/publishedSamples.json (the manifest is the single
source of truth for what is published; the app and the demo build scripts
both read it).

Note this is a different target from demo/bundle/, which uploads to
cdn.wolffi.sh/demo.

- `wolffish-sample.chart.json` — the interactive chart card spec (matches the
  dataviz manual's reference example; drawn by the app's chart renderer).
