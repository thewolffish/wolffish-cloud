# Branding this documentation

These pages are a **base**. They describe the platform without naming it, so a company can deploy
them under its own identity by changing a small, enumerated set of things — not by editing 44 pages.

As of this commit the prose contains **zero** occurrences of the product name. Verify that before
shipping a rebrand:

```bash
grep -rn -e 'Wolffish' -e 'وولفيش' --include='*.mdx' . || echo 'clean'
```

---

## 1. `docs.json` — the whole visual identity

| Key | Currently | Change it to |
| --- | --- | --- |
| `name` | `Wolffish Cloud` | The product name as the customer will know it |
| `colors.primary` · `.light` · `.dark` | `#1E40AF` · `#3B82F6` · `#1E3A8A` | The brand's primary, and its light/dark variants |
| `logo.dark` · `logo.light` | `/static/icon.png` | Replace the asset, or point at two files |
| `favicon` | `/static/favicon.png` | Replace the asset |
| `css` | `/static/custom.css` | Add fonts and overrides here; the file is intentionally tiny |
| `seo.metatags` | `og:title`, `og:description`, `og:image`, `twitter:*` | The share card. `og:image` is currently a `cdn.wolffi.sh` URL |
| `navbar.links` | A GitHub link | The customer's own link, or remove the array |
| `footer.socials` | `x`, `github` | The customer's own, or remove the object |

Nothing else in `docs.json` is brand-shaped: `navigation` is the page tree and should move only when
pages do.

## 2. `static/` — three files

| File | What it is |
| --- | --- |
| `static/icon.png` | The navbar logo (~430 KB today; a smaller SVG or PNG is fine) |
| `static/favicon.png` | The tab icon |
| `static/custom.css` | Site CSS. Deliberately minimal, so it is a good place for a font import |

## 3. The API hostname

The live host appears in **seven** places, all of them ASCII diagrams or one sentence:

```bash
grep -rn 'wolffi\.sh' --include='*.mdx' .
```

- `introduction/architecture.mdx` and `ar/introduction/architecture.mdx` — inside the system map.
  `api.wolffi.sh` is 13 characters; a replacement of the same width keeps the box borders aligned.
- `sync/overview.mdx`, `sync/mobile.mdx` and their `ar/` twins — the same, in the sync diagrams.
- `ar/introduction/overview.mdx` — one sentence naming the host.

Everywhere else the docs say "the organization's API", on purpose.

## 4. Product-shaped identifiers that are **not** branding

These are real values in the software. Change them only if the fork actually changed them, and then
change them in the code first:

| Value | Where it comes from |
| --- | --- |
| `~/.wfc` | The desktop app's data folder |
| `wfc` | The terminal client's command name |
| `wfc-api`, `wfc-master`, `wfc-blobs` | The Worker, D1 and R2 names |
| `sh.wolffi.cloud.mobile` · `wolffishcloud://` | The phone app's bundle id and URL scheme |
| `23152` | The browser extension's local port |
| `deepseek-ai/DeepSeek-V4.1-Flash` · `…V4-Pro-0813` | The model ids the router actually forwards |

Renaming any of these in the docs without renaming it in the code produces documentation that is
wrong, which is worse than documentation that is unbranded.

## 5. What to add, not change

A customer deployment usually wants two things these pages deliberately do not assume:

- **A support route.** Nothing here tells an employee who to ask. Add one line to
  `getting-started/setup.mdx` and `using/agent.mdx` — a channel name, an email, a ticket queue.
- **Local policy.** `using/privacy.mdx` states what the *platform* does. It does not state what the
  *company* has decided to do with that ability — who may read transcripts, under what process,
  with what notice. That paragraph is the customer's to write, and it belongs on that page.

## 6. After a rebrand

```bash
mint broken-links        # internal links, both languages
mint dev                 # eyeball the nav, the logo, both language tabs, RTL
```

Then re-run the parity check in [README.md](README.md#working-on-the-docs): every non-`ar/` page
needs an `ar/` twin, and both need a `docs.json` entry.
