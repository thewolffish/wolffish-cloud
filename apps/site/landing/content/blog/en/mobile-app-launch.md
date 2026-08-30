---
title: "Your Agent, in Your Pocket: the Wolffish Mobile App"
description: The Wolffish app for iPhone and Android is a remote control for the agent on your computer — chat, approvals, notifications, and settings, over an end-to-end encrypted tunnel.
date: 2026-08-17
categories: [news, product]
image: https://cdn.wolffi.sh/blog/mobile-app-launch/og.png
---

The Wolffish mobile app is out for [iPhone](https://apps.apple.com/us/app/wolffish/id6792797989) and [Android](https://play.google.com/store/apps/details?id=sh.wolffi.mobile). It's built on one clear idea: the desktop holds the models, the capabilities, the memory, and the files — and the phone is a remote for it.

## What you can do from the phone

Everything that matters day to day:

- **Chat** with your agent, with full conversation history synced from the desktop
- **Send anything** — voice notes, photos, videos, documents; get back files, charts, and PDFs with proper viewers
- **Approve or deny** sensitive actions from a native card, wherever you are
- **Get notified** when a long job finishes, fails, or needs you — with a deep link straight to the conversation
- **Manage settings** — automations, procedures, capability toggles, variables, usage stats

## Pairing without an account

There is no sign-up. On your computer, open **Settings → Channels → Mobile** and generate a pairing QR; on the phone, tap **Connect to Desktop** and scan. Prefer typing? An eight-character code does the same job.

Under the hood, phone and desktop run an end-to-end encrypted tunnel (X25519 key agreement, ChaCha20-Poly1305 encryption). They meet at a tiny relay that forwards sealed bytes and stores nothing — no database, no logs, no accounts, no message history. The relay is [open source](https://github.com/thewolffish/wolffish-relay) too, and you can point Wolffish at your own deployment if you'd rather.

## Honest limits

The phone is a view of your desktop, not a second agent. If the computer is off or asleep, past conversations stay readable, but new work waits until the link is back. For a phone that always has a live agent behind it, pair it to a small always-on server — the [cloud setup guide](https://wolffi.sh/start#vps) walks through it with every command included.

Full details in the [mobile app docs](https://docs.wolffi.sh/integrations/mobile-app).
