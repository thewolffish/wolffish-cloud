---
title: "Claude Tag in Slack: An Agent in Your Team Chat"
description: "Anthropic's Claude Tag puts a shared @Claude teammate inside your Slack channels. Here's how it works, its ambient mode, and how to set it up."
date: 2026-08-29
categories: [product, guides]
keywords: [Claude Tag, Claude in Slack, AI agent in Slack, Claude Tag setup, @Claude Slack agent, ambient AI agent, Claude Slash teammate, Anthropic Claude Slack integration]
image: https://cdn.wolffi.sh/blog/claude-tag-slack-agent-guide/og.png
---

Claude Tag is Anthropic's agent that lives inside your team's Slack channels as a shared @Claude teammate — you tag it, it does the work in the thread, and it keeps going while you do something else. It launched in beta on June 23, 2026 for Claude Team and Enterprise plans. The shift worth noticing is that an agent stopped being a chat window you open and became a colleague who sits in the room.

## What makes it different from a chatbot

A chatbot works when you open it and ask. Claude Tag works in the flow of work: it's mentioned in a channel, given access to selected channels, data, and even codebases, and it replies in the thread where the conversation is already happening.

The part that gets the attention is its **ambient mode**. It proactively jumps into a channel of its own accord — to keep the team updated, flag something from across the organization, or follow up on a thread or task that's been forgotten. Anthropic describes it as working with a real colleague: one that produces work in public view, with far more context than a one-off chatbot prompt.

## How to set it up

Anthropic positioned it as one shared identity for a whole group, so the work is billed to the organization — you're not handing a personal login around. Setup runs in four steps:

1. **Start a channel, thread, or DM with Claude** — that's the surface it works from. Mention @Claude to guarantee it picks the message up.
2. **Grant it access to the channels you trust.** You choose the channels, tools, and data it can reach. The narrower you keep this, the safer it is.
3. **Delegate a task by tagging it.** It breaks the task into stages, works through them with its connected tools, then posts the result back in the thread.
4. **Review the work in public.** Since it responds in the channel, the whole team sees what it did — which is both the appeal and the guardrail.

The most important setting is access scope, not model choice. Like any agent that can reach your team's files and tools, the value lives in what you let it touch — that's [how much you give it](/blog/ai-agent-permissions-guide), and it's the difference between a helpful teammate and an unsecured account.

## Who it's for

It's a real fit for teams that run on Slack and have recurring, well-defined work — merging product feedback, drafting one-pagers, triaging asks, and running follow-ups on threads. It is not a fit for sensitive data you haven't scoped, or for a group that wants an agent to be a free-for-all.

The agent-in-chat idea also transfers to your personal life. If a personal agent can live in the apps you already use and act in the open — drafting, filing, following up — the same principle applies: give it a tight scope, watch it work in view, and let it earn more access over time. For a picture of how that plays out outside Slack, see [what to automate first](/blog/what-to-automate-first-ai-agent).

## The practical tradeoffs

A shared agent in a team chat is a real shift, but it comes with a few things worth weighing before you turn it on for a whole workspace:

- **Public-by-default work.** Because it replies in the channel, drafts and research are visible to everyone in that channel. That's useful for transparency, less so for anything you'd want to keep private before it's ready.
- **Billing to the organization, not a person.** One identity means the cost and the permission surface aren't tied to a single login. It makes it more secure to share, but it also means the agent's access is as broad as the org grants it.
- **Context is a constraint.** An agent that lives in a channel knows the conversation, but it still only sees what it's been granted. If it can't reach a file or a tool, it can't act on it — so the access list, more than the model, determines what it's actually useful for.

The net is that the setup matters more than the prompt. A well-scoped @Claude in a channel becomes a reliable teammate; a loosely-scoped one becomes another thing for the team to babysit.

## The takeaway

![The Claude Tag setup one-pager: four steps to an agent in your team chat](https://cdn.wolffi.sh/blog/claude-tag-slack-agent-guide/takeaway.pdf)

Claude Tag is the clearest version of the "agent as a teammate" shift: it's not a tool you visit, it's a presence in the conversation, and it works in the open. The two things to get right are the scope you grant it and the visibility you keep over its output. Set both properly and a shared agent in your team chat stops being a novelty and becomes a reliable colleague. To wire up your own agent to act on that principle, [wolffi.sh/start](/start) walks through the setup.
