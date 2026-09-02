# The Document Design Manual

You are about to produce a document a person will read and judge. This manual is the
difference between a designed document and a rendered webpage. Follow it whenever you
author a PDF, report, brief, proposal, guide, summary, one-pager, or any styled
document — unless the user or an automation prompt already specifies the design. A
live page meant to be read in a browser rather than printed — an info site, a
scrollable handbook — is `web_design`'s job; this manual governs paged output.

**Precedence — read this first.**
1. **Explicit instructions win.** If the user or the automation/procedure prompt
   specifies a layout, palette, structure, or look ("minimal", "one page, just the
   list", "match our brand", a template they described), follow it exactly. Instructed
   formats that already work must keep working — do not "upgrade" them.
2. **Everything unspecified falls to this manual.** When the request is open ("make me
   a PDF about X", "put this in a report"), this system is the default, every time.
3. This is a system, not a template. Section 10 tells you what to vary per document so
   outputs don't all look identical — and what must never vary.

---

## 1. The pipeline — exact steps, in order

1. **Plan the document** (section 2): content inventory → page map. Do this before any HTML.
2. **Author one self-contained HTML file** in the workspace (e.g. `files/report.html`).
   System fonts only, no external URLs, no `<script>`. Charts are inline SVG (call
   `dataviz` for the chart kit before authoring any data display).
3. **Render:** `browser_launch` (headless) → `browser_navigate` to the absolute
   `file:///…/report.html` → `browser_pdf` with `output_path` and `format: "A4"`
   (or `"Letter"`). The renderer prints **full bleed — zero page margin**; your CSS
   controls every millimeter. `print_background` stays on (default).
4. **Verify — mandatory for anything over 2 pages** (section 9): render sample pages to
   images with `pdf_render_pages` and LOOK at them with `image_view`. Fix, re-render.
   Never deliver a multi-page document you have not seen.
5. **Deliver:** `send_file` the `.pdf`. `browser_pdf` does not auto-deliver.

## 2. Plan before HTML — the page map

Blank space and cramming both come from skipping this step. Before writing markup:

- **Inventory the content:** every section, table, figure, number, list you will include.
- **Assign pages:** write a one-line job for each page ("p1 cover · p2 TOC · p3 verdict +
  stat row · p4 pricing table + callout…"). Every page must have a job.
- **Budget honestly.** A page holds roughly: 550–650 words of body text, or a
  full-width table of 8–12 rows plus a paragraph and a callout, or two chart cards
  plus a stat row, or one section opener (headline + lead + one major component).
  If a page's assigned content is under ~60% of that, merge it into a neighbor or
  enrich it. If it's over, split it.
- **Calibrate length to the ask.** A quick summary: 1–2 pages, no cover. A standard
  report: cover + 4–10 content pages. A deep guide: cover + TOC + 12–30 pages +
  sources. Never pad to look thorough; never cram to fit a guess.

## 3. Page architecture — sheets, not flow

Designed documents use **fixed sheets**: each page is an explicitly composed box. This
is what gives you page numbers, footers, zero dead space, and total placement control.

```css
@page { margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { margin: 0; padding: 0; background: #ffffff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet {
  width: 210mm; height: 297mm;           /* Letter: width 8.5in; height 11in — match the format arg exactly */
  overflow: hidden; position: relative;
  break-after: page;
  background: var(--paper);
  padding: 14mm 16mm 20mm;               /* bottom reserves the footer zone */
}
.sheet:last-child { break-after: auto; }
```

- **One `.sheet` div per page.** Compose each page's content to fit its box. `overflow:
  hidden` means overflow is silently clipped — which is why the verify pass (section 9)
  is mandatory, and why you budget content per page in section 2.
- **A stray blank page between sheets** means something pushed a sheet past 297mm:
  an outer margin on `.sheet`, a border adding height without `border-box`, or a
  `<br>` after the last sheet. Sheets never carry outer margins.
- **Every content sheet carries the running footer** (section 5.4). The cover and an
  optional dark back page are the only exceptions.
- **Flow mode — the fallback, not the default.** For a long, uniform, text-dominant
  document (an essay, a transcript, a legal text) a single flowing container with
  `break-inside: avoid` blocks and `break-before: page` on top-level sections is
  acceptable. Even then: paint `html, body` background, keep every block's vertical
  margin, and keep headings glued to their content (`h1,h2,h3 { break-after: avoid; }`).
  If the document has stat rows, figures, or varied components — use sheets.

## 4. Foundations

### 4.1 Type scale (A4; values in px — do not improvise sizes)

| Role | Spec |
|---|---|
| Display (cover title) | 40–44px / 1.08 / weight 800 / letter-spacing -0.02em / max 3 lines |
| Page headline (H1) | 26–28px / 1.15 / 760 / -0.015em — one per section opener |
| Section head (H2) | 16.5px / 1.3 / 700 |
| Sub-head (H3) | 13px / 1.35 / 700 |
| Body | 13.5px / 1.6 / 400 — text columns max-width 620px, never full sheet width |
| Lead paragraph | 15px / 1.55 / 430 — first paragraph under a page headline only |
| Small / table text | 12.5px / 1.5 |
| Caption / footnote | 10.5px / 1.45, muted |
| Eyebrow / label | 10px / 700 / UPPERCASE / letter-spacing 0.14em |
| Running footer | 8.5px / 600 / UPPERCASE / letter-spacing 0.12em, muted |
| Stat value | 30–34px / 1 / 800 — unit rides in a 55%-size span, not full size |

Font stacks — system only, never a webfont URL:

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-arabic: "SF Arabic", "Geeza Pro", "IBM Plex Sans Arabic", "Segoe UI", Tahoma, sans-serif;
```

Numbers that sit in columns (tables, TOC page numbers) get
`font-variant-numeric: tabular-nums`. Large standalone numbers (stat values) do NOT —
proportional figures look right at display sizes.

### 4.2 Color system

Define once, use everywhere. The Wolffish steel-blue family below is always a safe
default — it is the house color and reads well on every document. Reach for a
different accent when the subject clearly suggests its own (a brand the user named →
that brand's hue; health → teal; energy → amber-on-ink), not out of obligation.

```css
:root {
  --paper:   #ffffff;
  --ink:     #16202e;   /* near-black, hue-shifted toward the accent — never pure #000 */
  --ink-2:   #3d4a5c;   /* secondary text */
  --muted:   #64748b;   /* captions, labels, footers */
  --hairline:#e2e6eb;   /* every rule and border */
  --accent:  #1d4ed8;   /* the ONE accent — subject-appropriate, swap per document */
  --accent-deep: #16307a;  /* dark variant: cover grounds, emphasis text */
  --wash:    #eef2fb;   /* accent tinted to ~5% — callout and tile grounds */
  --good:    #166534;  --warn: #b45309;  --bad: #b91c1c;   /* semantic ONLY */
}
```

**Binding rules:**
- **Body pages are light. Always.** Dark grounds are allowed on the cover, optional
  section-divider pages, and an optional back page — never on content pages. A dark
  content page is a rendering liability and reads as a slide, not a document.
- **One accent.** Tints and the deep variant of the same hue are free; a second hue is
  not. The semantic trio (`--good/--warn/--bad`) appears only where meaning demands it
  — a verdict, a delta, a risk level — never as decoration and never as "the color of
  tile #3". If a number is not good or bad, it is ink.
- **No gradient text, ever.** `background-clip: text` prints as a solid block.
  Gradients are legal only as large, quiet surface treatments (a cover ground, a hero
  band) — subtle, two close shades, never neon.
- **No emoji anywhere** — not in headings, not as icons, not as bullets. Rendered
  emoji glyphs in a document read as chat, not print. Structure carries the hierarchy.
- Hairlines everywhere borders are needed: 1px `--hairline`. Heavy borders and drop
  shadows don't print well and look dated; use space and rules instead.

### 4.3 Spacing

4px base grid. Between components: 18–24px. Section opener block (eyebrow + headline +
lead) to first component: 20px. Inside components: 12–16px padding. When a page has
air left over, distribute it between components — never leave it all pooled at the
bottom (that is the dead-space failure).

## 5. The component kit — exact recipes

Build pages from these. Each is print-safe and matches the type scale above.

### 5.1 Cover (the first impression — spend effort here)

Structure top-to-bottom: brand mark → (space) → eyebrow → display title →
standfirst → (space) → meta row → fine print. Two variants:

**Dark cover** (reports, strategy docs, anything with weight): ground in
`--accent-deep` to near-ink gradient (`linear-gradient(155deg, #0f1b33, #16307a)` style
— two close dark shades), white text, one large quiet geometric element at low opacity
(a 40vw circle outline, a diagonal band) for depth. Never busy art, never stock-photo
feel, never a wall of icons.

**Light cover** (briefs, summaries, friendly docs): `--paper` ground, ink title,
a single accent rule or block, generous white space.

```html
<div class="sheet cover">
  <div class="brand"><span class="brand-chip">W</span> WOLFFISH <span class="brand-light">RESEARCH</span></div>
  <div class="cover-body">
    <div class="eyebrow">MARKET BRIEF · JULY 2026</div>
    <h1 class="display">The title, stated like a finding, not a topic.</h1>
    <p class="standfirst">Two lines that tell the reader what this document will do
    for them — the scope, the stakes, and the payoff of reading it.</p>
  </div>
  <div class="cover-meta">
    <div><div class="meta-label">PREPARED FOR</div><div class="meta-value">Name</div></div>
    <div><div class="meta-label">DATE</div><div class="meta-value">July 31, 2026</div></div>
    <div><div class="meta-label">SCOPE</div><div class="meta-value">Three · Word · Scope</div></div>
  </div>
  <p class="fineprint">Sources and provenance note. Estimates labeled as such.</p>
</div>
```

```css
.cover { display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 800;
  letter-spacing: 0.18em; font-size: 13px; }
.brand-chip { display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 8px; background: var(--accent);
  color: #fff; font-size: 15px; letter-spacing: 0; }
.brand-light { font-weight: 400; opacity: 0.75; }
.cover-body { margin-top: auto; margin-bottom: auto; max-width: 150mm; }
.display { font-size: 42px; line-height: 1.08; font-weight: 800; letter-spacing: -0.02em; }
.standfirst { font-size: 15.5px; line-height: 1.55; margin-top: 16px; opacity: 0.92; }
.cover-meta { display: flex; gap: 40px; border-top: 1px solid var(--hairline);
  padding-top: 14px; }
.meta-label { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; opacity: 0.65; }
.meta-value { font-size: 12.5px; font-weight: 650; margin-top: 3px; }
.fineprint { font-size: 9px; line-height: 1.5; opacity: 0.55; margin-top: 12px; }
```

On the dark variant the hairline becomes `rgba(255,255,255,0.18)` and text is white.
The title states a **finding or promise**, not a topic label ("A $50B market forming at
46% a year", not "Market Analysis").

### 5.2 Table of contents (documents ≥ 8 pages)

A numbered table, not a bullet list. Two columns when more than ~7 entries.

```css
.toc { width: 100%; border-collapse: collapse; }
.toc td { padding: 7px 0; border-bottom: 1px solid var(--hairline);
  font-size: 12.5px; vertical-align: top; }
.toc .n { color: var(--accent); font-weight: 700; width: 28px;
  font-variant-numeric: tabular-nums; }
.toc .p { text-align: right; color: var(--muted); width: 30px;
  font-variant-numeric: tabular-nums; }
```

Page numbers in the TOC must match reality — fill them in AFTER the verify pass.

### 5.3 Section opener (every major section)

Numbered chip + eyebrow, then the headline, then a 1–3 sentence lead. The number is
justified only when sections form a real sequence; otherwise use the eyebrow alone.

```css
.sec-tag { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.sec-num { background: var(--accent-deep); color: #fff; font-size: 10px;
  font-weight: 700; padding: 3px 8px; letter-spacing: 0.1em; }
.sec-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 0.14em;
  color: var(--muted); text-transform: uppercase; }
.headline { font-size: 27px; line-height: 1.15; font-weight: 760;
  letter-spacing: -0.015em; max-width: 130mm; }
.lead { font-size: 15px; line-height: 1.55; margin-top: 12px; max-width: 620px; }
.lead strong { font-weight: 700; }
```

### 5.4 Running footer (every content sheet)

```css
.footer { position: absolute; left: 16mm; right: 16mm; bottom: 8mm;
  display: flex; justify-content: space-between; align-items: baseline;
  border-top: 1px solid var(--hairline); padding-top: 6px;
  font-size: 8.5px; font-weight: 600; letter-spacing: 0.12em;
  color: var(--muted); text-transform: uppercase; }
```

Left: document title. Right: the page number (plain, sequential, matching the sheet
order). No footer on the cover.

### 5.5 Stat tiles (the number row)

Top-border tiles on a wash ground — never centered rounded cards, never a different
random color per tile.

```html
<div class="stat-row">
  <div class="stat"><div class="stat-v">$52.6<span class="u">B</span><sup>16</sup></div>
    <div class="stat-c">AI-agents market by 2030, from $7.8B in 2025 — about 46% CAGR</div></div>
  …3–4 tiles per row…
</div>
```

```css
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.stat { border-top: 3px solid var(--accent-deep); background: var(--wash);
  padding: 12px 14px 13px; }
.stat-v { font-size: 30px; font-weight: 800; line-height: 1; color: var(--ink); }
.stat-v .u { font-size: 55%; font-weight: 750; margin-left: 1px; }
.stat-v sup { font-size: 9px; color: var(--muted); font-weight: 600; }
.stat-c { font-size: 10.5px; line-height: 1.45; color: var(--ink-2); margin-top: 7px; }
```

The caption explains what the number IS and why it matters — never a bare label. A
delta or verdict inside a tile may use `--good`/`--bad`; the value itself stays ink.

### 5.6 Tables (the workhorse — get these perfect)

Hairline system: uppercase letter-spaced column heads, a stronger rule under the
header, 1px rules between rows, no vertical rules, no zebra stripes, no fills.

```css
table.data { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.data th { text-align: left; font-size: 9.5px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted);
  padding: 0 10px 7px 0; border-bottom: 1.5px solid var(--ink); }
.data td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--hairline);
  vertical-align: top; line-height: 1.45; }
.data td.num { text-align: right; font-variant-numeric: tabular-nums; }
.data td strong { font-weight: 700; }
```

- First column: the entity (bold when it's the anchor). Numeric columns right-aligned.
- Keep cell text tight; move explanation into a "what it tells you" column rather than
  bloating every cell.
- A table that would exceed its sheet splits at a row boundary and repeats its header
  on the next sheet. Never let `overflow: hidden` eat rows — budget rows per page
  (roughly 10–14 data rows per full-width table page).

### 5.7 Callouts (insight, warning, verdict)

Left-border + wash. The label states the KIND of note; the color follows meaning.

```css
.callout { border-left: 3px solid var(--accent); background: var(--wash);
  padding: 12px 16px; max-width: 100%; }
.callout .label { font-size: 9.5px; font-weight: 700; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--accent-deep); margin-bottom: 6px; }
.callout p { font-size: 12.5px; line-height: 1.55; }
.callout.warn { border-color: var(--warn); background: #fdf6ec; }
.callout.warn .label { color: var(--warn); }
.callout.good { border-color: var(--good); background: #eef7f0; }
.callout.good .label { color: var(--good); }
```

Two callouts side-by-side in a 2-column grid is a strong page-bottom move. Never stack
three callouts of the same kind — merge them.

### 5.8 Provenance pills (label estimates and claims)

When a document carries researched or modeled numbers, mark provenance at the claim:

```css
.pill { display: inline-block; border: 1px solid currentColor; border-radius: 999px;
  font-size: 8.5px; font-weight: 700; letter-spacing: 0.08em; padding: 1.5px 8px;
  vertical-align: 1px; }
.pill.estimate { color: var(--warn); }  .pill.reported { color: var(--muted); }
```

Use sparingly — superscript source numbers (`<sup>21</sup>`) pointing to a sources page
are the default for cited figures; pills are for ESTIMATE / REPORTED / OPINION class
labels. A document whose numbers came from research includes a sources page. Weight
the provenance effort by how far a number will travel: figures a reader is likely to
quote onward — prices, market sizes, benchmarks, anything decision-bearing — earn a
marker at the claim and a home in the sources block; incidental numbers don't need
the ceremony. Your judgment on where that line falls.

### 5.9 Numbered steps / ranked lists

```css
.step { display: flex; gap: 12px; padding: 10px 0; }
.step-n { flex: none; width: 22px; height: 22px; border-radius: 50%;
  background: var(--accent-deep); color: #fff; font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; }
.step-body { font-size: 12.5px; line-height: 1.5; }
.step-body strong { display: block; font-size: 13px; margin-bottom: 2px; }
```

### 5.10 Two-column layouts

`display: grid; grid-template-columns: …; gap: 18px;` — for chart + stat stack,
text + callout, paired comparisons. Never more than two text columns on A4. When one
column is a chart card and the other is tiles, align their tops.

### 5.11 Quotes, timelines, comparisons

- **Pull quote:** 17px / 1.45 / 600 italic, accent left rule, attribution in caption style.
- **Timeline row:** a 4–6 column grid of eyebrow (date) + small text cells over a 1px
  hairline with accent dots — for roadmaps.
- **Comparison (A vs B):** two bordered panels, one on `--accent-deep` ground (white
  text) and one on wash — for "us vs them", "before vs after".

## 6. Charts inside documents

**Before authoring any data display — a chart, a big-number row, a comparison — call
`dataviz` and follow its manual.** Binding rules that apply in every document:

- Charts in print are **inline SVG, hand-authored** — never `<canvas>`, never a JS
  library, never an external image for a chart you can draw.
- Every chart lives in a **chart card**: 1px hairline border, 6px radius, 16px padding,
  title (12.5px / 700), unit subtitle (10.5px muted), the SVG, and a source/method
  footnote (9.5px muted, hairline-separated). No naked SVGs floating in text.
- The form follows the data's job (the dataviz manual's first table). If the story is
  a single number, that's a stat tile, not a chart. If it's more than ~7 series,
  that's a table.
- Series colors come from the dataviz palette slots in order — never invented per
  chart. Axis text and labels wear text colors, never series colors. Gridlines are
  solid 1px hairlines, 3–5 of them, never dashed.
- Direct-label the marks when there are few (≤ 8 labeled points); use the axis when
  there are many. Every chart names its unit somewhere ("$ billions", "% of pilots").

## 7. Right-to-left and Arabic documents

When the document language is Arabic (or the user's automation is Arabic-first):

- `<html dir="rtl" lang="ar">`, `--font-arabic` stack on `body`.
- **Zero letter-spacing on Arabic text** — tracking breaks the connected script.
  Eyebrows and footers drop `letter-spacing` and carry hierarchy with size + weight +
  color instead.
- Mirror directional components: `border-left` → `border-inline-start` (write it that
  way from the start), numbered chips and meta rows flow right-to-left automatically
  under the grid — verify alignment in the render pass.
- Keep digits Latin (`1,234`) unless the user asks for Eastern Arabic numerals; keep
  tabular alignment.
- Type sizes: Arabic needs +0.5–1px on body sizes for equal optical weight (body 14px,
  table 13px).

## 8. Length, density, and the minimal document

- **A one-pager is a real format.** Single sheet, no cover, brand line at top, tight
  stat row, one table or chart, footer. Density high, margins honest.
- **A 2–4 page brief:** light cover treatment on page 1 (brand + title + standfirst in
  the top third, content starts same page) — a full cover page would be padding.
- **Cover + TOC earn their pages at ≥ 8 content pages.**
- Prose-only pages are a smell in reports: most pages should carry at least one
  structural component (tiles, table, chart, callout, steps). In essays and narrative
  documents, prose pages are fine — use pull quotes and section openers for rhythm.

## 9. Verify before delivering — mandatory

`overflow: hidden` sheets clip silently; Chromium pagination rounds; charts have
geometry bugs. You never deliver unseen:

1. After `browser_pdf`, check the page count is what the page map planned. A count
   mismatch (extra blank pages) = sheet overflow (section 3).
2. `pdf_render_pages` on the cover, one dense mid-document page, any page with a
   chart, and the last page. `image_view` each.
3. Checklist — fix and re-render if ANY fails:
   - Nothing clipped at a sheet edge; nothing overlapping the footer zone.
   - No page under ~50% full except the cover/back (dead space = recompose).
   - Footers present and sequential; TOC page numbers match reality.
   - Charts: bars/lines inside the plot area, labels not colliding, palette correct.
   - Contrast: no light-gray-on-white body text; captions legible.
   - Arabic/RTL: alignment mirrored, nothing letter-spaced.
4. Only then `send_file`.

One render-verify-fix cycle is expected; two is fine; if a third is needed, simplify
the failing page rather than iterating forever.

## 10. Vary the treatment — never the standards

So documents don't come out identical, choose per document (from the subject, the
audience, and anything the user has shown you):

- **Accent hue + cover ground** (dark vs light cover, the geometric motif — the
  Wolffish blue default is always acceptable; vary when the subject invites it).
- **Component mix** (stat-heavy dashboard-brief vs table-heavy comparison vs
  narrative-with-pull-quotes).
- **Density** (dense consultant's deck vs airy executive brief).
- **Structural devices** (numbered sections for sequences; plain eyebrows otherwise).

What never varies: light body pages, the type scale, hairline discipline, footers with
page numbers, one accent + semantic-only status colors, labeled provenance on
researched numbers, charts from the dataviz kit, the verify pass, no emoji, no
gradient text, no dead half-pages.

## 11. Failure catalog — if your draft matches one of these, fix it before rendering

1. **The markdown dump:** default `<h1>`/`<table>` styling, no cover, no footer, no
   components — a webpage printed. Apply the kit.
2. **The slide deck:** dark body pages, giant rounded cards, 3 sentences per page.
3. **The dead page:** a page under half full, or a trailing near-empty page. Recompose.
4. **Random rainbow:** each tile/heading its own color; red/green used decoratively.
   One accent; semantic colors only where meaning demands.
5. **The emoji document:** emoji as icons/bullets/heading prefixes.
6. **Gradient-text title:** prints as a colored block. Solid ink or white, always.
7. **The unlabeled number:** stats with no caption, charts with no unit, researched
   figures with no source. Label at the claim.
8. **The 100-character line:** body text spanning the full sheet width. Cap measure
   at ~620px.
9. **The centered document:** everything center-aligned. Documents are left-aligned
   (right-aligned for RTL); centering is for covers and tiles only, sparingly.
10. **The clipped sheet:** content silently eaten by `overflow: hidden` — caught only
    by the verify pass you were about to skip.
