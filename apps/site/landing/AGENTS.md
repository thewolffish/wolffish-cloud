<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Wolffish Landing Page

Single-page landing site for the Wolffish desktop agent, published at [wolffi.sh](https://wolffi.sh).

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript 5**
- **Tailwind CSS 4** with glassmorphic UI
- **Three.js** with custom GLSL shaders for the 3D ocean background
- **next-intl** for bilingual support (English + Arabic with full RTL)
- **IBM Plex Sans Arabic** (local font, 5 weights)

## Project layout

```
src/app/layout.tsx          Root layout, metadata, fonts, i18n provider
src/app/page.tsx            Home — server-side release fetching from releases.wolffi.sh
src/app/globals.css         Global styles
src/components/
  LandingOverlay.tsx        UI layer: nav, hero (logo + title), features, downloads, footer
  OceanScene.tsx            Three.js 3D ocean (full shader pipeline, 256x256 mesh)
  OceanSceneClient.tsx      Dynamic import wrapper (ssr: false)
src/i18n/request.ts         next-intl locale config
messages/en.json            English translations
messages/ar.json            Arabic translations
public/icon_transparent.png Wolffish logo
public/fonts/               IBM Plex Sans Arabic .ttf files
```

## Key conventions

- All user-facing text goes through `next-intl` — update both `messages/en.json` and `messages/ar.json` for any copy change.
- Locale is stored in a cookie (`locale`). The root `<html>` tag sets `dir="rtl"` for Arabic.
- Release metadata (version, download URLs) is fetched server-side in `page.tsx` from `https://releases.wolffi.sh`. The UI degrades gracefully if the server is unreachable.
- The 3D ocean scene is client-only (`next/dynamic` with `ssr: false`). Never import `OceanScene.tsx` directly — use `OceanSceneClient.tsx`.
- The logo (`icon_transparent.png`) is displayed next to the title via `next/image` in `LandingOverlay.tsx`.
- Deployed on Vercel — pushes to `main` trigger production builds.
