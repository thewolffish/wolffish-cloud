---
title: "Claude Cowork Guide: Anthropic's Desktop Agent"
description: "Claude Cowork turns Claude into a coworker that finishes files, slides, and research while you step away. How it works, what it costs, and when to use it."
date: 2026-08-21
categories: [guides, product]
keywords: [Claude Cowork, Claude Cowork guide, Anthropic desktop agent, Claude Cowork tutorial, Claude Cowork vs ChatGPT, how to use Claude Cowork, Claude agent 2026]
image: https://cdn.wolffi.sh/blog/claude-cowork-guide/og.png
---

Claude Cowork is Anthropic's agent mode: you describe an outcome, and Claude plans, uses tools, and comes back with finished files instead of another chat reply. It runs on desktop, web, and mobile for paid Claude plans, and it keeps working in the cloud after you close the laptop.

## What Cowork is (and is not)

Cowork uses the same agentic loop as Claude Code — plan, act, check — without a terminal. [Anthropic's product page](https://claude.com/product/cowork) puts it simply: hand Claude real work, pick the files and tools it may touch, and get a deck, document, or spreadsheet back for review.

It is not Chat. Chat answers one message at a time. Cowork takes a job that would take you an afternoon — "turn these twelve PDFs into a comparison spreadsheet with a one-page brief" — and runs it as a session you can leave.

It is also not a fully local agent. [Anthropic's help center](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) is clear: sessions run remotely in the cloud (in beta). Claude's work happens on Anthropic's servers, in an isolated environment. Your sessions and files are saved to your Claude account and follow you across devices.

## Where you can use it

Paid plans only: Pro, Max, Team, and Enterprise.

| Surface | Who gets it |
| --- | --- |
| Claude Desktop (macOS and Windows) | All paid plans |
| claude.ai on the web | Pro, Max, Team; Enterprise if an admin enables it |
| Claude iOS and Android | Pro, Max, Team; Enterprise if enabled |
| Claude in Chrome side panel | Max and Team first; rolling out to Pro |

On desktop, web, and mobile, Chat and Cowork share one home. Open the message box, select **Cowork**, describe the task. In Chrome, opening the side panel starts a Cowork session directly.

Local files, your browser, and "computer use" still need the desktop app open and connected. Cloud work continues if the laptop sleeps; anything that has to touch a folder on disk does not.

## What it is good at

Anthropic lists the jobs that match Cowork's shape:

- **Direct local file access** on desktop — read and write folders you authorize, without uploading by hand.
- **Professional outputs** — Excel with working formulas, PowerPoint, formatted documents.
- **Sub-agent coordination** — split a big job into parallel workstreams.
- **Scheduled tasks** — daily, weekly, or monthly runs in the cloud, no device online.
- **Projects** — persistent workspaces with their own files, links, instructions, and memory.
- **Browser actions** — click, type, and fill forms in Chrome when the task needs a website.
- **Long-running work** — no conversation timeout cutting the job off mid-way.

Deletion is gated: Claude must ask before permanently deleting files, and you have to hit Allow.

## How a session actually runs

When you start a task, Claude:

1. Analyzes the request and writes a plan you can see.
2. Breaks complex work into subtasks.
3. Runs code and shell commands in an isolated cloud environment.
4. Coordinates parallel workstreams if that helps.
5. Delivers outputs in the session for preview and download.

You can steer mid-flight, jump in from your phone, or let it run. Three permission modes control how often it asks before using connectors: always allow, needs approval, or blocked. Default to **needs approval** until you trust a recurring job.

## What it costs

Cowork is bundled into paid Claude, not sold separately. [Claude's pricing page](https://claude.com/pricing) puts Cowork on Pro, Max, Team, and Enterprise. Independent roundups in 2026 put Pro around $20/month (less on annual billing) and Max at roughly $100 or $200/month for 5× or 20× Pro usage. Treat those dollar figures as the widely reported list prices, not a quote — Anthropic can change them.

Usage is shared across chat, desktop, mobile, and Claude Code. Heavy Cowork sessions burn that pool faster than short chats. Upgrade when you hit the limit, not before.

## The risks Anthropic flags itself

Cowork has internet access and can act. That is the point, and the hazard. Anthropic's own warnings:

- Agentic behavior plus the web means prompt injection is in play — a page Claude reads can try to instruct it. The same class of attack we covered in [AI agent security](https://wolffi.sh/blog/ai-agent-security).
- Network egress rules do **not** apply to web fetch, web search, or MCP, including Claude in Chrome.
- Team and Enterprise admins can turn web search off in organization settings.

Give it the smallest folder that does the job. Do not point it at your whole home directory on day one.

## Cowork vs a chat tab vs a local agent

Use **Chat** when you want a conversation. Use **Cowork** when you want a deliverable and can describe "done" in one sentence. Use a [local-first agent](https://wolffi.sh/blog/local-first-vs-cloud-ai-assistant) when the files should never leave your machine.

A practical split: Cowork for polished slides and spreadsheet grunt work you are fine uploading; a machine-local agent for mail, calendars, and anything covered by a client NDA.

## Takeaway

Cowork is the most complete "hand it a job and walk away" product Anthropic ships for non-coders. Start on Pro, keep approval on, authorize one folder, and pick tasks with a clear finish line. If the work has to stay on your disk, Cowork is the wrong tool — and that is a feature, not a bug.

![Claude Cowork — One-Page Takeaway](https://cdn.wolffi.sh/blog/claude-cowork-guide/takeaway.pdf)
