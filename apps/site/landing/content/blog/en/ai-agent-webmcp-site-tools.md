---
title: "AI Agents Can Now Work in Your Signed-In Browser"
description: "OpenAI's WebMCP site tools let an AI agent use the same live page and signed-in session you're browsing. Here's how it works and how to use it safely."
date: 2026-08-28
categories: [guides, product]
keywords: [WebMCP, OpenAI site tools, AI agent browser, agent signed-in session, WebMCP ChatGPT, AI agent web access, browser for AI agents, agent browser tab, WebMCP site tools]
image: https://cdn.wolffi.sh/blog/ai-agent-webmcp-site-tools/og.png
---

The big change in how AI agents use the web isn't a faster scraper — it's that an agent can now work in the same live page and signed-in session you're already using. OpenAI's WebMCP support, added to the ChatGPT desktop app's built-in browser and to ChatGPT Sites, lets a website expose small "site tools" an agent can call, so you and the agent are effectively browsing together in one real, logged-in session instead of the agent guessing its way through the interface.

## What WebMCP site tools actually are

WebMCP is a way for a website to offer actions directly to an AI agent, right alongside the interface a human uses. With it, a site can present a set of tools the agent can invoke — fill a form, check availability, book, search a catalog — without the agent having to parse the page's HTML and click around blindly.

Three things make it worth understanding:

- **It's model-agnostic.** The standard was proposed through the W3C Web Machine Learning Community Group by engineers from Microsoft and Google, so OpenAI is adopting a proposal it doesn't solely control. That's a good sign it isn't a one-brand lock-in.
- **It runs in the browser you're already in.** The agent works in the ChatGPT desktop app's built-in browser — the same one you might already use for research — and ChatGPT Work and Codex can discover and use these tools when they're available.
- **You share the session.** The point isn't that the agent opens a new tab in the background; it's that a person and an agent can act on the same live page together. You stay in control of what actually gets submitted.

## Why this changes what agents can do

This is the difference between an agent that *reads* the web and an agent that *uses* it. Until now, most so-called "web agents" had to either scrape a page or work through a tool's own browser. The result was brittle: sites with heavy JavaScript, login walls, or bot checks would break the agent, and anything requiring your actual account was effectively off-limits unless you handed over credentials.

With a shared signed-in session, the agent can operate where you're already authenticated — your bank, your subscriptions, your booking portals — without you re-entering anything or pasting keys into a prompt. That's genuinely more capable, and it's the reason the [browser-extension approach](https://wolffi.sh/start#research) is becoming the default for agent web work: some things only work with your real cookies.

It's also part of why purpose-built agent browsers like [Kitesurf](https://wolffi.sh/blog/kitesurf-browser-for-ai-agents) and shared-session tools are converging on the same idea: the agent is most useful when it's standing in the same place the human is, not on a separate scaffolding of scrapers.

## How to use it safely

More capability in your session means more power in something you're not watching. The rule that keeps an agent useful without making it dangerous is the same for any always-on assistant: shape the permission boundary *before* you let it act.

- **Start read-only.** Let the agent search, compare, and draft before you let it submit anything. Most sites have a read-only surface worth starting on.
- **Keep write actions behind a human step.** An agent that can book a flight or send an email should stop and get your confirmation on the actual action — the [agent-recommends-you-decide pattern](https://wolffi.sh/blog/ai-agent-permissions-guide) is the reliable one.
- **Limit which sessions it can touch.** Grant the agent access to the sites and accounts it actually needs, not everything in the browser. The [permissions guide](https://wolffi.sh/blog/ai-agent-permissions-guide) covers how to scope this.
- **Assume the agent is a capable but unsupervised assistant.** It's one hidden instruction away from acting. Treat it the way you'd treat an assistant you hire — not a tool you can stop paying attention to.

![WebMCP site tools — the safe-use checklist](https://cdn.wolffi.sh/blog/ai-agent-webmcp-site-tools/webmcp-checklist.pdf)

## The takeaway

WebMCP is the practical arrival of the agent that shares your browser instead of pretending to be one. It makes agents dramatically more useful for real tasks — booking, filling forms, managing accounts — precisely because they stop guessing and start using the page you're already on. Just keep the same discipline you'd apply to any powerful assistant: let it read freely, and keep the buttons that actually change things behind your own finger.

If you want to see the shared-browser model in action on your own machine, the [Wolffish start guide](https://wolffi.sh/start#research) walks through connecting an agent to your real browser and scoping exactly what it can do — the same live-session idea, but with the rules in plain text where you can audit them.
