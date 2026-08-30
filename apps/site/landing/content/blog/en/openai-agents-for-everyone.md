---
title: "OpenAI's Agent for Everyone: ChatGPT Work Explained"
description: "OpenAI wants one agent for everyone: ChatGPT Work at $20/month turns goals into finished work. Here's the harness behind it and why adoption is still tiny."
date: 2026-08-26
categories: [news, market]
keywords: [OpenAI agent, ChatGPT Work, OpenAI agent for everyone, ChatGPT Work harness, OpenAI agent adoption, AI agent harness, OpenAI agent 2026, ChatGPT Work pricing, does ChatGPT Work work]
image: https://cdn.wolffi.sh/blog/openai-agents-for-everyone/og.png
---

OpenAI is betting that one agent can work for everyone, and its newest product is the clearest version of that bet yet. ChatGPT Work, launched on July 9 on GPT-5.6 and included in the $20 Plus tier, takes a goal and turns it into finished sheets, slides, docs, and sites. But the more interesting story isn't the product — it's the gap between how much OpenAI uses agents internally and how few paying customers actually do. That gap is the whole reason agents haven't gone mainstream yet.

## What ChatGPT Work actually is

ChatGPT Work is OpenAI's agent for the office, not for the terminal. It's a modified version of its Codex coding tool, reworked so someone who has never written a line of code can say "make this spreadsheet into a planning tool" and get a finished product back. It's meant for the accountants, investors, doctors, and operations teams whose day is spent in front of a computer but not in a text editor.

The key design idea inside it is what OpenAI engineers call the **harness** — the software wrapped around a model that decides what information it sees, which tools it can use, and how it presents its answers. A raw model, on its own, just generates text. Wrapped in a harness with inbox access, a calendar, and a browser, it becomes an agent that finishes a task. OpenAI's claim is that the harness is a temporary crutch: improve the model enough and most of that scaffolding stops mattering.

## The adoption gap is the real story

Tim Fernholz's inside look, published August 24, 2026, surfaced a number that explains everything about the agent market. An OpenAI-backed study found that in June, **98% of OpenAI employees were using Codex**. Outside the company, the numbers fell off a cliff: **17% of organizational subscribers** and **less than 1% of individual subscribers** were using the agentic coding tool.

That's not a bug in the product — it's the shape of the problem. Inside OpenAI, people are surrounded by engineers, templates, and a culture that already works this way. Everyone else gets a tool that shows them an "empty diff" and speaks in software terms. The engineers admit the product was "actively hostile" to non-engineers until they reworked it between February and now.

This is the tension OpenAI is trying to solve. Coding is a proven, measurable market for agents, but it's a tiny slice of professional work. To justify the massive investment in training and compute, the labs need agents to spread into law, finance, sales, and medicine — where the work is messy, the tools were built in 1995, and success is much harder to evaluate than a passing test.

| Metric | OpenAI employees | Organizational subscribers | Individual subscribers |
| --- | --- | --- | --- |
| Using Codex (June) | 98% | 17% | under 1% |

## Why it works for some, not yet for others

When the harness is matched to the task, ChatGPT Work can be genuinely impressive. A TechCrunch reporter asked it to pull a preschool calendar out of an email and drop it into Google Calendar; it did, saving a pile of manual entry. It built an auto-updating metrics dashboard, made a queryable database of space launches, and sends a weekly email on new AI research. Sam Altman uses it to plan vacations.

But it also has real limits right now. Setting up permissions was confusing and circular — the reporter tried several times to grant read-only access to a cloud drive and got errors, only to be told complete access was the only option. Some settings live only on the web app, forcing a juggle between desktop and browser. Link it to a calendar and it can create events but not new calendars. And the "effort level" toggle — the thing that decides how hard the agent tries — is not intuitive, which the engineering lead freely admits matters for a tool aimed at newcomers.

The bigger structural problem: most office work isn't measurable. Code either compiles or it doesn't. A good presentation or sales pitch is much harder to score. OpenAI says it uses a benchmark called GDPval, drawn from 44 occupations and hundreds of knowledge-work tests, plus user feedback, to decide what to build. That's an honest answer, and it's also why the product's shape is still shifting.

## The rivalry underneath it all

You can't read about ChatGPT Work without hitting the comparison to Anthropic's Claude Cowork, and the product designers really don't want to talk about it. "I don't look at the harnesses that they're building," one engineer said, quoting the *Mad Men* meme — right before admitting the first thing ChatGPT Work did was offer to import the reporter's Claude Cowork data.

The origin story explains the sensitivity. OpenAI built Codex first, betting the model was smart enough to run a task with minimal user input — something one engineer now calls "a bit more AGI-pilled." Anthropic's Claude Code, built shortly after, took the opposite approach: give the user three or four options, let them choose, then check back constantly. That conversational loop won. Codex eventually adopted more user interaction, and by April it had retaken a slight lead in downloads.

The lesson for anyone building or choosing an agent is that the harness and the feedback loop matter as much as the model. The engineers' own conclusion is blunt: "the next model is going to come out in a couple of months and make [all these extras] obsolete." Maybe. But for the user of an agent today, the loop you get — how much it checks in, how much it lets you steer, how it says no — is what makes it usable or a burden.

## What it means for a personal agent

The same harness philosophy applies whether you rent one from OpenAI or run a local-first agent like Wolffish. A model is not an agent; the wrapper that gives it your tools, your context, and a feedback loop is what turns it into one. The internal 98% versus the external 1% is the cleanest proof that the constraint isn't model quality — it's the harness and the trust you're willing to grant.

If you're just getting started, the practical frame is this: pick a task you do repeatedly and that has a clear "done" state, give the agent only the access that task needs, and lean on the check-back loop rather than letting it run unattended. That's the whole game — and it's why the [personal agent fundamentals](https://wolffi.sh/blog/what-is-a-personal-ai-agent) and the [agent security guide](https://wolffi.sh/blog/ai-agent-security) are worth reading before you hand over your inbox.

![AI agent adoption gap — who actually uses agents](https://cdn.wolffi.sh/blog/openai-agents-for-everyone/adoption-gap.html)

**Takeaway.** ChatGPT Work is OpenAI's most honest attempt yet to make an agent that ordinary white-collar workers will actually use, and the adoption numbers show how far there is to go. The harness — and the trust around it — is the real frontier, not the model.
