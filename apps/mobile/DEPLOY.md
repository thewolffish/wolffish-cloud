# DEPLOY.md — Wolffish Mobile Deployment Procedure

Instructions for an agent **deploying the next version** of `wolffish-mobile`: check the work, write the app's own release notes, commit it, then decide which of the two ship paths this batch belongs on and run **exactly one** of them.

There are two, and the whole procedure exists to pick correctly between them:

| | **`npm run ota`** | **`npm run provision`** |
|---|---|---|
| Carries | JS, assets, locales | Everything, including native |
| Publishes | **Yes** — every installed phone, in minutes | **No** — a version in git and nowhere else |
| Bumps | `APP_VERSION` | `APP_VERSION` **and** `CODE_VERSION` |
| Tags | `vX.Y.Z` — fires the Release workflow | Nothing |
| Undo | `npm run rollback` (the user's lever) | Nothing to undo |
| Notes you author | In-app changelog only | In-app changelog **+ store notes** (App Store “What's New” · Play release notes) |
| Left for the user | Nothing | EAS build → submit → `npm run release` |

**`ota` is a publish.** It reaches users before anyone can look at it again. `provision` reaches no one. That asymmetry drives every rule below.

Follow the steps **in order**. If anything looks wrong, **stop and report** (see [If issues are found](#if-issues-are-found--stop)).

---

## Non-negotiables (read before doing anything)

- **You run exactly one ship command, once, at the end: `ota` or `provision`.** Never both, never one after the other. Step 4 decides which; everything before it is preparation.
- **When the two paths disagree, or you are unsure, or the evidence is stale — `provision`.** Provisioning a batch that could have gone over the air costs one build number and a store round trip. Sending a batch over the air that needed a store build is an incident on every installed phone. The costs are not symmetric, so the burden of proof is not either: **OTA needs positive evidence; `provision` is the default.**
- **Never set `OTA_SKIP_RUNTIME_CHECK=1`.** It disables the one guard that makes an agent-run OTA safe. There is no situation in this procedure that calls for it.
- **Never run `npm run release` or `npm run rollback`.** `release` asserts a store build passed review — you cannot know that. `rollback` is the emergency lever for an OTA that went wrong, and the user pulls it.
- **Never run `eas` yourself** beyond the read-only `eas build:list` in step 4, and **never create or push a tag by hand.** `ota` publishes and tags on its own; hand-driving either is how a tag ends up pointing at a tree that was never built.
- **Never edit the version by hand.** `APP_VERSION`, `CODE_VERSION` and `UPDATE_DATE` in `app.config.ts`, `version` in `package.json` / `package-lock.json`, and the **README version badge** are all written by whichever script you run. You write no version anywhere.
- **The release notes are the one thing you author** — the changelog on both paths, plus the store notes on `provision` — and the changelog is **this app's own** changelog — `src/changelog/<YYYY-MM>/en.md` and `ar.md`, bundled into the binary and read by the Changelog screen. It is not the paired desktop's notes, which the app fetches separately over the tunnel and which are none of this repo's business.
- **Nothing is committed until the changelog entries exist.** A user-facing batch that reaches `main` without them ships a version the app cannot describe — and on the OTA path that version is already on phones by the time anyone notices.
- **Both changelog languages, always.** AR is a full translation, not a stub.
- **A `provision` also needs store notes; an `ota` never does.** A provisioned version is going through App Store review and a Play rollout, and both submission forms have a notes field the user fills in by hand — so `store/v<X.Y.Z>/` gets two plain-text files (step 5). An OTA is submitted to no one: writing store notes on that path invents a submission that will never happen. This is the only asymmetry in what you author between the two paths.
- **A new month needs a code change too.** `src/lib/changelog/index.ts` holds a `PAGES` registry of **static** imports — Metro cannot glob a folder, so a new `src/changelog/<YYYY-MM>/` directory that isn't registered there ships as a month the app cannot read.
- **Commit everything before you ship.** Both scripts refuse a dirty working tree, and their own commit deliberately carries nothing but the bump — so your work has to already be a commit of its own.
- **Stay on `main`.** No branches.
- **When in doubt, stop.** A halted deploy costs nothing. Stopping before step 7 costs nothing at all.

---

## Procedure

### 1. Analyze all changes

- Run `git status` and `git diff` (and `git diff --staged`) to see everything pending.
- Review commits since the last tag if work was already committed: `git log $(git describe --tags --abbrev=0)..HEAD --stat`.
- Build a short list of **what actually changed from the user's point of view** — features, fixes, behavior changes. You need it for the changelog anyway.
- **Note every native-surface touch:** a dependency added, removed or bumped; an `app.config.ts` change; anything under `plugins/`; an Expo SDK bump; a change to `eas.json`, `.gitignore`, or an asset named in the config (`assets/images/icon.png`, `assets/images/splash.png`, the fonts). Step 4 turns this list into the decision — one of these means a store build no matter how small it looks.
- If there is **nothing user-facing**, say so — commit and push the work, but add no changelog section.

### 2. Code checks

Run the same three gates the ship script will re-run, so a problem surfaces here rather than halfway through a version bump:

```bash
npx prettier --check "**/*.{js,jsx,ts,tsx}" --ignore-path .gitignore
npx tsc --noEmit
npx jest --silent
```

- **Formatting problems: fix them yourself — don't halt.** Run `npm run format` (or fix by hand), then re-run all three until clean; the fixes ride the deploy commit. Pre-existing formatting noise in files this batch never touched is left alone (just note it).
- **Code problems: STOP and await instructions.** A failing `tsc --noEmit`, a failing test, obvious breakage, half-finished work, a clear regression, committed secrets — never self-fixed. Go to [If issues are found](#if-issues-are-found--stop).
- There is **no ESLint in this repo.** Prettier plus `tsc` plus jest are the mechanical guards; don't add one as part of a deploy.
- Do **one** independent review pass over the diff (a reviewer subagent, or `/code-review` at low effort). Look only for: obvious breakage, something half-finished, a clear regression, secrets committed by accident. Smell test, not a full review — don't rabbit-hole.
- **A UI change needs a device check**, not just a green typecheck. Say in your report what you actually exercised. On the OTA path this is not optional — see step 4.

### 3. The sync gate

The phone is a mirror of a desktop it reaches over an end-to-end encrypted tunnel, and **the connection is the product**. If the diff touches `src/lib/tunnel/`, `src/lib/sync/`, or `src/state/demoConfig.ts`, these checks run before anything else happens. A deploy that splits the protocol from the desktop is the one failure this app cannot recover from on its own: paired phones stop syncing, and the fix has to travel through the same broken channel.

1. **Wire files are shared with `wolffish-app`.** `noise.ts` is **byte-identical** with `wolffish-app/src/main/tunnel/`; `protocol.ts` is **code-identical** — its doc comments are allowed to differ, because each repo's copy narrates the contract from its own seat (a mobile-only relay frame reads "the desktop never sends or receives it" over there); `pairing.ts` and `tunnel.ts` are identical **except for import specifiers** (`@/lib/tunnel/…` here, `./` there) plus two handler generics in `tunnel.ts`. Verify with:
   ```bash
   diff -r src/lib/tunnel ../wolffish-app/src/main/tunnel
   ```
   Beyond those known deltas, any diff line outside a `/** … */` comment is a protocol split. **Stop and report it.**
2. **A new `Rpc` method or `Event` topic is a two-repo change.** The mobile half alone compiles fine and does nothing — the desktop must serve the method or emit the topic, and a `configSet` key must be on the desktop's whitelist. If the desktop half isn't in place, the batch is half-finished: stop.
3. **Both directions still work.** Confirm against a real paired desktop, not by typecheck: pair, background and foreground the app (the socket dies on suspend by design and must re-handshake), and check that an edit made on the phone lands on the desktop and an edit made on the desktop lands on the phone.
4. **Reconnect is idempotent.** `attachLiveUpdates` / `attachTurnStream` re-run on every connection and must replace handlers, not stack them. New push-only state also needs a seed on connect — see `seedOverlays`.

If any of these can't be confirmed, the deploy isn't ready. Report and stop.

### 4. The ship gate — OTA or store build

**This is the step that must not be wrong.** Two gates. **Both** must pass for `ota`. Either one fails, or leaves you unsure, and the answer is `provision`.

#### Gate A — the machine gate: can the shipped binaries even receive this?

An update only reaches a binary whose build-time fingerprint equals the publish-time fingerprint. Compare the working tree against the latest shipped store build on **both** platforms — this is read-only and takes about a minute:

```bash
npm run fix:fingerprint   # undo any node_modules drift first — see below
for p in ios android; do
  npx expo-updates fingerprint:generate --platform $p \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('$p local   ',JSON.parse(s).hash))"
  eas build:list --json --non-interactive --platform $p --limit 10 \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s).find(x=>x.status==='FINISHED'&&x.buildProfile==='production'&&x.distribution==='STORE'&&x.fingerprint);console.log('$p shipped ',b?b.fingerprint.hash+' (build '+b.appBuildVersion+')':'none')})"
done
```

- **Every platform's pair matches** → gate A passes. Record the hashes; they go in the report.
- **Any pair differs** → **store build.** Something moved the native surface. Do not argue with it, do not look for a way around it: `provision`.
- **A platform reports `none`** → no shipped store build there yet, so nothing on that platform can receive an update. If *no* platform has one, OTA is impossible: `provision`.

What the fingerprint covers, and therefore what silently forks the runtime: autolinked native modules (so any dependency change), config plugins including `plugins/withQuietIosBuild.js`, the evaluated `app.config.ts`, `eas.json`, `.gitignore`, and the config's external assets — **the app icon, the splash image and the bundled fonts are in the fingerprint**, which is the one people get wrong. What it does *not* cover: everything under `src/`. Pure JS and TS never move the hash. That is the point, and it is also why gate A alone is not enough.

The `fix:fingerprint` line is not ceremony, and it is the one false mismatch this gate can produce. `@react-native-masked-view/masked-view` rewrites its own `AndroidManifest.xml` **inside `node_modules`** from its `build.gradle`, at Gradle configuration time — so any local `npm run android` strips an attribute from an installed dependency, and that directory is hashed as an autolinked native source on **both** platforms. EAS installs fresh and fingerprints before Gradle runs, so it never sees the edit: local and EAS then disagree, `eas build` fails with *"Runtime version calculated on local machine not equal to runtime version calculated during build"*, and this gate reports a mismatch for a batch that never touched the native surface. `scripts/fix-fingerprint-drift.js` puts the attribute back (idempotent, and inert for the build itself — Gradle re-strips it next time). `ota`, `ios:prod`, `android:prod` and `android:preview` all run it for you; the snippet above needs it because it calls `fingerprint:generate` directly. A mismatch that survives it is real: obey the bullet above.

`ota` re-runs this exact comparison itself and exits before writing, committing or publishing anything if it fails — so a wrong answer here fails safe rather than shipping. That is a backstop, **not** a substitute for deciding: "run it and see if it stops me" is not a decision, and it is not what gate B checks at all.

#### Gate B — the judgment gate: should every phone have this in ten minutes?

Gate A is blind to `src/`, and that is where the batch's actual risk lives. Any **yes** here means `provision`, regardless of how cleanly gate A passed:

- **Does it touch the tunnel, sync or protocol, without step 3's live two-way check having actually been run against a real paired desktop?** An OTA that splits the protocol lands on every phone at once and breaks the only channel the fix can travel through. A green typecheck is not evidence here.
- **Does it bump `SCHEMA_VERSION` in `src/lib/db/database.ts`, or otherwise rewrite on-device data?** Migrations are forward-only — `rollback` restores the JS, never the database. An additive column survives a rollback; a destructive migration leaves the restored JS reading a database it no longer understands.
- **Is any `EXPO_PUBLIC_*` variable set in your shell?** Check before you publish:
  ```bash
  env | grep EXPO_PUBLIC
  ```
  Expo inlines these **at bundle time**, and `ota` bundles from wherever it is run. There is no `.env` file in this repo, so a live shell is the only way one can reach a bundle — but the demo workflow sets `EXPO_PUBLIC_DEMO_BASE_URL` to a local bundle server, and a shell that has it lives as long as its terminal tab. Inlined into an OTA it points every phone's demo mode at a machine that isn't theirs, and nothing catches it: not the fingerprint, not `tsc`, not jest. Production wants them **unset** so the code takes its own defaults (`src/lib/demo/importer.ts:39`, `src/lib/api/client.ts:9`). Anything set → clear it and publish from a clean shell.
- **Is there a UI or behavior change nobody exercised on a device?** Then no one has seen this run. Go do the device check, or `provision`.
- **Is `CODE_VERSION` in `app.config.ts` ahead of the build gate A matched against?** Then a provisioned build was never shipped. Users are still on the older binary, so the update reaches them fine — but someone provisioned that build for a reason, and `ota` will label the commit `over build <CODE_VERSION>` rather than the build it actually verified against. Find out why before publishing over it.
- **Is anything half-finished, feature-flagged off, or waiting on a desktop half that isn't live yet?** Store review is a useful delay; OTA removes it.
- **Is there nothing user-facing in the batch at all?** Then there is nothing to publish. An OTA would burn a version, tag it and fire the Release workflow for a change no user can see. Commit and push the work (step 6) and ship nothing, or `provision` it to ride along with the next store build — say which in the report.
- **Did the user say this is going to the store**, or ask for a build, or mention review or TestFlight? Their intent wins over both gates.

**Intent only ever moves the answer toward `provision`.** A request for an OTA does not override gate A, does not lower gate B and never justifies `OTA_SKIP_RUNTIME_CHECK`. If the user asked for an OTA and the gate says store build, don't run either command: report which gate failed and why, and let them decide.

#### Then decide

Both gates clean → **`ota`**. Anything else → **`provision`**. Write the decision and the reason down now; step 8 has you report it, and a reason invented after the command ran is not a reason.

### 5. Write the release notes

Only reach this step if steps 2 and 3 came back clean and the batch has user-facing changes.

Two audiences, and step 4 decides how many of them you write for:

| | Who reads it | Which path |
|---|---|---|
| **In-app changelog** — `src/changelog/<YYYY-MM>/{en,ar}.md` | Someone already using the app, on the Changelog screen | **Both** |
| **Store notes** — `store/v<X.Y.Z>/*.txt` | Someone looking at the App Store or Play listing, deciding whether to update | **`provision` only** |

The changelog is the same entry on either path — step 4 chose *which* command runs, not *whether* one does, and the version is a patch bump regardless. The store notes exist only because a provisioned build gets submitted; write them second, from the changelog you just wrote.

#### 5a. The in-app changelog (EN + AR) — both paths

1. **Compute the next version:** a patch bump of `APP_VERSION` in `app.config.ts`. If it says `1.0.20`, the release is **`1.0.21`**. You are writing the notes *ahead* of a bump the script will make — that is why the version isn't in the file yet.
2. **Pick the changelog folder** by today's date: `src/changelog/<YYYY-MM>/`. New month → create `en.md` and `ar.md`, **and** add the static imports plus a `PAGES` entry in `src/lib/changelog/index.ts`.
3. **Read the last 2–3 existing entries in both files first** and match their house style exactly:
   - Version header — EN: `## v1.0.21 — <YYYY-MM-DD> \`Latest\`` · AR: `## الإصدار 1.0.21 — <YYYY-MM-DD> \`الأحدث\``
   - **Move the `` `Latest` `` / `` `الأحدث` `` marker off the previous top entry** — only the newest carries it.
   - One `### Headline` per notable change, followed by a paragraph of **flowing, benefit-first prose** (not a bullet list of commits), key phrases in **bold**. Written for a user, not a developer.
   - New entry at the **top** of each file.
   - AR is a genuine translation — same headlines, same content, natural Arabic.
4. Use today's real date, and keep EN and AR in lockstep.
5. **If an entry for this version already exists** (an earlier pass wrote one and more work has since landed), append `### Headline` sections to that same block and refresh its header date to today. Never open a second block for one version.

#### 5b. The store notes (App Store + Play) — `provision` only

**Skip this whole subsection on the OTA path.** No submission is happening, no form is waiting for text, and a `store/` folder for a version that only ever went over the air is a lie in the repo.

On the `provision` path, write two files under `store/v<X.Y.Z>/` — same version step 5a used, the one `provision` is about to bump to:

| File | Goes in | Hard limit |
|---|---|---|
| `apple-en.txt` | App Store Connect → the new version → **What's New in This Version** | 4,000 characters |
| `play-en.txt` | Play Console → the release → **Release notes**, inside the `<en-US>` tags | **500 characters** |

**English only — this is the one place the app's two languages don't both apply.** The in-app changelog is EN + AR because the app is; the store listings are English, so there is no Arabic field to fill and no `*-ar.txt` here. If a listing ever gains an Arabic localization, it takes an `apple-ar.txt` / `play-ar.txt` in the same shape, under the same limits.

`.txt`, one block per file, no front matter and no filename header inside the file — the file *is* the paste. The folder is created on the first provision that needs it; nothing in the build reads it, it is a handover artifact for the user at submission time, and it stays in git as the record of what each shipped build actually claimed.

**Rules both stores share**

- **Plain text. Neither store renders Markdown.** `**bold**` arrives as literal asterisks, `###` as literal hashes. Blank lines between paragraphs and a leading `• ` on a list line are the only formatting either field has.
- **Say only what the changelog says.** These are a compression of the step-5a entry, not a second act of authorship — no headline the changelog doesn't cover, no change the batch doesn't contain.
- **Write for someone who has not opened the app today.** No file names, no `SCHEMA_VERSION`, no repo or build vocabulary, no "OTA", no version number in the body (both stores print it above the text), no links, no ratings pleas.
- **Nothing user-facing in the batch** (a native-only provision: a dependency bump, an icon, a config plugin) is the one case a generic line is correct and honest — "Stability and performance improvements." Apple's guideline 2.3.12 allows a generic description for exactly that and nothing more.

**`apple-en.txt` — the App Store's house style**

- Lead with the single change a user would notice, in the **first sentence**: the listing truncates What's New behind a **more** link after a couple of lines, and most readers never open it.
- Then one short paragraph per further notable change, benefit first, present tense, addressed to the reader — the changelog's voice with the explanation cut out. Two to four paragraphs, roughly 400–800 characters, is the shape that reads well; 4,000 is the ceiling, not the target.
- **Guideline 2.3.12** — *"Apps must clearly describe new features and product changes in their 'What's New' text. Simple bug fixes, security updates, and performance improvements may rely on a generic description, but more significant changes must be listed in the notes."* A batch with real features that ships "Bug fixes and improvements" is not just a wasted field; it is rejectable metadata.
- **Guideline 2.3.10:** Apple metadata may not name other mobile platforms or app marketplaces. Never let a line about Android or Google Play cross over from `play-en.txt` into this one. The paired **desktop app** is not another mobile platform and is fine to name.
- Nothing about beta, TestFlight, pricing, or anything "coming soon" — the notes describe this version as submitted.

**`play-en.txt` — Play's house style**

- **500 Unicode characters, spaces and newlines counted** (the limit is per language; English is the only one). It is the binding constraint on this whole step — exceeding it fails the console's own validation — so write the Apple block first and cut it down to this one, rather than writing to 500 and finding the App Store text has nothing left to say.
- Three to five lines, each opening `• `, most important first — the listing card shows roughly the first two lines before **Read more**.
- One clause per line, no sub-bullets, no HTML, no emoji as decoration. Play's metadata policy wants release notes descriptive, not promotional: no "Download now", no comparisons, no calls to action.

**What each one looks like** — the same batch (the v1.0.37 changelog above), compressed twice. `apple-en.txt`:

```text
The floating card that appears while something runs on your desktop is now yours to switch off. Automations and procedures have a switch on Settings > Channels; compaction and reflection have one on Settings > Knowledge. All of them start off.

Switching a card off hides the card and nothing else: the run happens on the same schedule, the notifications you asked for still arrive, and the Automations and Knowledge screens still show exactly what ran and when.

Procedures now appear in the same stack as everything else, showing the prompt they are running. An automation that shared a name with a procedure no longer lights up as running when it isn't.
```

`play-en.txt` — same story, four lines, comfortably inside 500:

```text
• Live run cards now have a switch per family: automations and procedures on Settings > Channels, compaction and reflection on Settings > Knowledge. All start off.
• Switching one off hides the card only. Runs keep their schedule, notifications still arrive, and the Automations and Knowledge screens still report every run.
• Procedures now show up in the run stack with the prompt they are running.
• Fixed: an automation sharing a name with a procedure showed as running when it wasn't.
```

**Check the lengths before committing** — the stores count characters, not bytes, and the `•` alone is three bytes each time, so `wc -c` can tell you a Play block is over when it isn't:

```bash
for f in store/v1.0.38/*.txt; do
  node -e "console.log([...require('fs').readFileSync(process.argv[1],'utf8').trimEnd()].length, process.argv[1])" "$f"
done
```

**If a provisioned version never shipped** — it happens; releases are 1:N with provisions — its `store/v<X.Y.Z>/` stays where it is as history, and the notes for the version that *does* get submitted must cover that skipped build's changes too. Users never saw it, so from the store's side those changes are landing now. Say so in the report.

### 6. Commit and push the work

1. **One regular commit** with everything: source changes (including step-2 formatting fixes) + changelog EN/AR + any `PAGES` registration +, on the `provision` path, the two `store/v<X.Y.Z>/*.txt` files. Concise message summarizing the headline change (e.g. `add: turn rating, conversations sheet`). The store notes have to ride *this* commit — `provision` refuses a dirty tree, and its own commit carries nothing but the bump.
2. **Do not touch `app.config.ts` / `package.json` / `package-lock.json` / the README badge.** Step 7 writes all four.
3. Confirm the tree is clean: `git status` shows nothing to commit — both scripts refuse a dirty tree.
4. Push:
   ```bash
   git push origin main
   ```
   Plain push, **no tags**. Nothing publishes yet on either path.

### 7. Deploy — run the one command step 4 chose

#### If gate A and gate B both passed: over the air

```bash
npm run ota
```

It re-runs the three gates on the exact tree it is about to publish, re-runs the fingerprint comparison from gate A, then raises `APP_VERSION` by a patch and stamps `UPDATE_DATE`; mirrors the version into `package.json` / `package-lock.json` and the README badge; commits that as `ota: vX.Y.Z (over build N)`; publishes with `eas update` to the `production` channel; tags `vX.Y.Z`; and pushes commit and tag.

**`CODE_VERSION` is untouched** — the update rides the store build already in users' hands, and the commit message records which one. **No store notes on this path** (step 5b): nothing is being submitted, so there is no What's New field and no Play release to attach notes to.

Three things this sets off, all of them real:

- **The update is live.** Devices pick it up on their next cold start or foreground check. There is no review, no staging and no undo you are allowed to run — if it turns out to be wrong, tell the user; `npm run rollback` is theirs.
- **The `v*` tag fires `.github/workflows/release.yml`**, which creates the GitHub Release, builds a sideload APK on EAS and attaches the current store `.ipa`. Expect it; don't be surprised by CI activity you didn't start by hand.
- **A failed publish leaves a local-only bump commit.** The script prints the exact undo (`git reset --hard HEAD~1`). Report it and stop rather than retrying blind.

If `ota` refuses on the runtime check even though gate A passed, **stop — don't fall straight through to `provision`.** The two checks are identical, so disagreeing means something moved between step 4 and now, and you don't yet know what. Re-read the diff, find it, and report it; the refusal is the correct answer and `provision` is almost certainly where it lands, but a surprise you can't explain is worth the minute. Never reach for `OTA_SKIP_RUNTIME_CHECK`.

#### Otherwise: provision for a store build

```bash
npm run provision
```

It re-runs the same three gates on the exact tree it is about to bump, then raises `APP_VERSION` by a patch, `CODE_VERSION` by one, and stamps `UPDATE_DATE`; mirrors the version into `package.json` / `package-lock.json` and the README badge; commits that as `provision: vX.Y.Z (build N)`; and pushes it.

**No tag, so nothing publishes.** The release workflow fires on `v*` tags only, and `provision` creates none. The build, the submission and `npm run release` are the user's — and the store notes from step 5b are what they paste into the two submission forms, so they must already be committed by now.

A failing gate in either script is a **hard stop**, not something to work around: it means step 2 was run against a different tree than the one being shipped — re-read the diff rather than re-running the command.

To ship an explicit version rather than a patch bump: `npm run ota 1.1.0` / `npm run provision 1.1.0`.

### 8. Report

Tell the user, briefly:

- **Which command you ran, and why that one and not the other.** This is the first thing in the report, not the last. Name the deciding evidence: for `ota`, the matching fingerprints from gate A (both platforms, with build numbers) and the fact that gate B was clean; for `provision`, the specific thing that ruled OTA out — the mismatched hash, the native file, the unverified device check.
- What's in the release, and the version the script created — `vX.Y.Z (build N)` for a provision, `vX.Y.Z (over build N)` for an OTA, straight from its output.
- **If you published:** say plainly that it is live on every installed phone, and that `npm run rollback` is the user's lever if it turns out wrong.
- **If you provisioned:** what's left for them — EAS build → submit → `npm run release` — and that the store notes are written and committed at `store/v<X.Y.Z>/`, naming both files and where each one goes (App Store What's New; Play release notes). **Quote both blocks inline in the report** so they can be pasted without opening a file, and give the Play block's character count against the 500 limit. Say if a skipped, never-shipped provision's changes are folded into them.
- Anything you fixed yourself (formatting), and anything you noted but left alone.
- What you actually verified on a device.

Then stop. **Do not build, submit, tag, release or roll back, and do not offer to.**

---

## What the user does next (reference only — not yours to run)

After an **OTA**, nothing: the update is live and the tag is pushed.

After a **provision**, the version exists in git and nowhere else, and getting it to a phone is theirs:

```
npm run ios:prod / npm run android:prod  →  submit  →  App Store review  →  npm run release
```

At the submission step, the notes are already written: paste `store/v<X.Y.Z>/apple-en.txt` into **What's New in This Version** in App Store Connect, and `store/v<X.Y.Z>/play-en.txt` into the Play release's **Release notes** between the `<en-US>` tags.

Use those npm scripts rather than a bare `eas build`: they run `fix:fingerprint` first, and a bare invocation after a local `npm run android` fails EAS's own runtime-version check for the reason gate A describes.

`release` records an **empty** marker commit and tags it, so the tag points at exactly the tree that was built — which is why it changes no files and why only the provisioned build that actually shipped ever gets a tag. Releases stay 1:N with provisions.

If an OTA turns out to be bad, `npm run rollback` republishes the previous update group — or, if there was none, the bundle embedded in the store build. Devices converge on the next launch, the bad version's tag stays (it really shipped), and the fix goes out later as a normal `npm run ota`.

All four scripts refuse a dirty working tree — which is why step 6 commits before step 7 runs.

---

## If issues are found — STOP

Applies to any blocker: a failing typecheck or test, a bad or breaking change spotted in step 2, a formatting error that can't be fixed without changing behavior, a protocol split against `wolffish-app`, an unclear diff — anything that means this should not be shipped as-is. (Plain formatting failures are NOT blockers — step 2 has you fix those yourself and continue. **A failed ship gate is not a blocker either** — it is an answer: `provision`.)

1. **Stop immediately.** Do not write the changelog, do not commit, do not push, and above all do not run `npm run ota` or `npm run provision` — a version bumped over a known problem is a version someone has to unpick, and a *published* one is a version every user already has.
2. **Report the issues minimally** — just *what* they are, briefly. One line each. No fixes applied, no long analysis.
3. **Hand the decision to the user.** Wait for them to decide how to address each issue.
4. Once addressed / approved, **start over from step 1.**

Do not partially ship, do not work around a flagged issue, and do not decide on the user's behalf.

---

## Quick reference

| Thing | Where | Edit by hand? |
|---|---|---|
| App version | `app.config.ts` → `APP_VERSION` | **No** — `ota` and `provision` bump it |
| Store build counter | `app.config.ts` → `CODE_VERSION` | **No** — `npm run provision` only |
| Update date | `app.config.ts` → `UPDATE_DATE` | **No** — the scripts stamp it |
| npm version mirror | `package.json` → `"version"` | **No** — the scripts write it |
| Version badge | `README.md` badge line | **No** — the scripts write it |
| Changelog (English) | `src/changelog/<YYYY-MM>/en.md` | **Yes** — you author it, both paths |
| Changelog (Arabic) | `src/changelog/<YYYY-MM>/ar.md` | **Yes** — full translation |
| Month registry | `src/lib/changelog/index.ts` → `PAGES` | **Yes** — only for a new month |
| App Store “What's New” | `store/v<X.Y.Z>/apple-en.txt` | **Yes** — `provision` only · EN · ≤ 4,000 chars |
| Play release notes | `store/v<X.Y.Z>/play-en.txt` | **Yes** — `provision` only · EN · **≤ 500 chars** |

```bash
git status && git diff                                                   # 1. see all changes
npx prettier --check "**/*.{js,jsx,ts,tsx}" --ignore-path .gitignore     # 2. format: self-fix
npx tsc --noEmit && npx jest --silent                                    #    types/tests/code: STOP
diff -r src/lib/tunnel ../wolffish-app/src/main/tunnel                   # 3. sync gate, if relevant
npm run fix:fingerprint                                                  # 4. undo node_modules drift, then …
#    ship gate: fingerprint local vs shipped store build (both platforms) + the judgment list
#    both clean -> ota   ·   anything else, or unsure -> provision
# 5a. write src/changelog/<YYYY-MM>/{en,ar}.md  (next = patch bump of APP_VERSION) — both paths
# 5b. provision ONLY: store/v<X.Y.Z>/{apple-en,play-en}.txt   (store listings are English only)
#     plain text · apple ≤ 4000 chars · play ≤ 500 chars · never on the ota path
git add -A && git commit -m "<summary>"   # 6. one regular commit (changelog + store notes), then …
git push origin main                      #    … plain push — no tags, nothing publishes
npm run ota          # 7a. JS-only + verified: bumps, publishes to every phone, tags, pushes
npm run provision    # 7b. otherwise: bumps version + build + badge, commits, pushes. No tag.
```

**One-line summary:** analyze → run the three checks (formatting: fix yourself; types, tests, code: stop) → run the sync gate if the diff touches the tunnel → **run the ship gate: fingerprints match on every shipped platform *and* nothing in the batch is too risky to land on all phones at once → `ota`; anything else, or any doubt → `provision`** → write this app's own EN+AR changelog, plus — on the `provision` path only — the English App Store and Play store notes under `store/v<X.Y.Z>/` → commit and push the work → run the one command the gate chose → report which one and why. `ota` publishes to users and cannot be undone by you; `provision` publishes nothing. `release` and `rollback` stay the user's.
