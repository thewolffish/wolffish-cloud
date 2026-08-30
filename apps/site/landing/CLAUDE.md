@AGENTS.md

# Development rules

- Run `npm run dev` to start the dev server. Always verify UI changes in the browser before reporting done.
- Keep translations in sync — any text change must update both `messages/en.json` and `messages/ar.json`.
- Test both LTR (English) and RTL (Arabic) layouts when changing UI.
- Assets in `public/` should only be files actively used by the app. Remove unused resources.
- Do not import `OceanScene.tsx` directly in server components — use the `OceanSceneClient.tsx` wrapper.
