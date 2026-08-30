---
title: "How to Make an AI Agent Work While You Sleep"
description: "The difference between a chatbot and an agent is running on a schedule. Here's a plain-English guide to setting up a personal agent that works unattended."
date: 2026-08-24
categories: [guides]
keywords: [AI agent schedule, run AI agent while you sleep, scheduled AI agent, unattended AI agent, AI agent automation, cron job AI agent, personal AI agent setup, recurring AI tasks, AI agent that works overnight]
image: https://cdn.wolffi.sh/blog/schedule-ai-agent-automations/og.png
---

The difference between a chatbot and an agent isn't the model — it's the schedule. A chatbot answers when you type; an agent runs on a timer, watches triggers, and gets work done even when you're asleep. This is the single biggest shift between "AI as a tool" and "AI as a teammate," and it's the part you can actually set up today.

## The shift this week: scheduled, unattended agents go mainstream

Scheduled agents moved firmly from hobby project to product feature this week. On August 21, Snowflake pushed CoCo Automations into public preview — letting users set up recurring, unattended agent runs in a managed sandbox, with each run creating a thread you can inspect and continue afterward. It's the same pattern showing up across the stack: agents that fire on a timer, not on a prompt.

If you've been treating AI as "open a chat, ask a question, close the tab," this is the unlock worth caring about. A scheduled agent stops being something you use and starts being something that works *for* you.

## What it actually means to run an agent on a schedule

Three behaviors separate a scheduled agent from a chat:

- **Triggers, not prompts.** Instead of you typing a question, the agent reacts to an event — a new email, a calendar entry, a data change, or a clock time.
- **Background execution.** It runs as a process, not as one turn in a chat window. It can do 50 steps while you're in a meeting.
- **An unattended deliverable.** It produces output you check later — a summary, a file, a spreadsheet, a message in your phone — rather than a reply you have to wait for.

## The exact setup, step by step

You don't need to be an engineer. The recipe is the same no matter which agent you use:

1. **Pick one task you dread.** Email triage, a weekly report, invoice tracking, a morning briefing — the habit forms around one repetitive chore, not twenty.
2. **Write down what "done" looks like.** A bot with a fuzzy goal loops forever; a bot with a defined deliverable (a two-paragraph summary, a CSV, an inbox at zero) stops when it's finished. This is the single most important step.
3. **Give the agent the inputs it needs.** Point it at the email, the calendar, the folder, the API. Read-only access first — an agent that can only read and summarize is far harder to get wrong than one that can also write.
4. **Set the schedule.** A cron-style expression (every morning at 7, every Friday at 5, every hour during working hours). The timezone matters; get that right or "morning briefing" fires at 2 AM.
5. **Choose where results land.** A notification on your phone, a file in a folder, a message in a chat you actually read. If the output goes somewhere you never look, you'll think it's broken when it isn't.
6. **Watch the first few runs, then let go.** Check the first two or three deliveries yourself. Once they're correct, step away — that's the whole point.

## What scheduled agents are genuinely good at

- **Morning briefings** — pull your calendar, unread email, and top tasks into one summary before you wake up. There's a full [morning briefing recipe](https://wolffi.sh/start#morning-briefing) in the setup guide.
- **Email triage** — sort, draft replies, and flag what's urgent overnight.
- **Weekly reports** — compile the week's numbers into a deliverable on Friday before you leave.
- **Recurring research** — track a topic, a competitor, or a price and report the deltas, not the whole firehose.

## The honest limits

Scheduled agents aren't a magic employee. Three real constraints: **cost** — an agent working around the clock burns tokens; pick one task with a clear deliverable so you're paying for outcomes, not idle poking. **Reliability** — unattended runs fail silently; you need a notification when something errors, not just when it succeeds. **Scope** — the failure mode that gets scary is an agent with write access and a fuzzy goal. Give it read access and a defined "done" for the first month.

The philosophy that keeps it manageable: start with one task, read-only, with a hard stopping rule. Expand only after the first few runs come back correct.

![Unattended agent setup checklist — one-page takeaway](https://cdn.wolffi.sh/blog/schedule-ai-agent-automations/takeaway.pdf)

## The takeaway

A scheduled personal agent is the difference between asking AI something and delegating to it. Pick one chore, define the deliverable, set the timer, and verify the first few runs. Frameworks like CoCo Automations and internal schedulers make it turnkey, but the discipline is yours: a small scope and a hard "done" condition are what keep it reliable.

If you're deciding what to hand off first, the [what to automate first](https://wolffi.sh/blog/what-to-automate-first-ai-agent) guide walks the choice, and for the always-on version of this idea there's a [local vs cloud assistant](https://wolffi.sh/blog/local-first-vs-cloud-ai-assistant) comparison that affects whether it can run independently.
