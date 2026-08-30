---
title: "How to Prompt an AI Agent: Patterns That Actually Work"
description: "Prompting an agent isn't copywriting, it's systems design. Here are the patterns that get agents to finish the job — role, constraints, and when to stop."
date: 2026-08-28
categories: [guides]
keywords: [how to prompt AI agent, AI agent prompt, agent prompt engineering, system prompt agent, AI agent instructions, agent prompting patterns, prompt template agent, how to write agent instructions]
image: https://cdn.wolffi.sh/blog/how-to-prompt-ai-agent/og.png
---

Prompting an AI agent looks nothing like prompting a chatbot. A chatbot answers one message; an agent works toward a goal over many steps with tools — so the instructions you give it are closer to an operating manual than a personality sketch. The patterns that actually work tell the agent its role, what "done" looks like, which tools it can use, and when it should stop and ask you.

## Why agent prompts are different

When you prompt a chatbot, you're asking it to produce one good response. When you prompt an agent, you're describing a job you want it to own end to end — which means the prompt has to carry things a chat prompt doesn't: an objective you can recognize as complete, a set of tools it's allowed to reach, limits on what it may change, and a rule for when it should escalate instead of pressing on.

The framing that's stuck in 2026 is that agent prompting is less like copywriting and more like systems design. You specify the role, what success means, which tools the agent can access, and when it should stop or escalate. Get those right and the agent mostly handles itself; get them wrong and each of those gaps becomes a place it drifts.

## The six components every agent prompt needs

Whether you're typing this into a personal agent or writing a system prompt for a tool, the same six pieces do the heavy lifting.

1. **Role** — one clear line of who the agent is in this task ("You are an email triage agent").
2. **Goal** — what the finished result looks like, in terms you can check ("Sort the inbox, flag anything with a deadline, draft short replies for the routine ones").
3. **Tools** — which tools it may reach and which to keep off-limits. This is where the [permissions](/blog/ai-agent-permissions-guide) actually bite.
4. **Constraints** — hard limits and guardrails ("Never send without approval," "never invent a figure you can't verify").
5. **Output format** — the shape of the result, so you can act on it without re-parsing.
6. **Stop / escalate** — when it should pause and come back to you instead of continuing on its own.

The last one is the one people skip, and it's the one that keeps an agent useful rather than surprising. An agent that knows when it's out of its depth is an assistant; one that doesn't is a liability.

## Three patterns that work every time

- **Role + constraints.** This is the base pattern. State who the agent is, then state what it is *not* allowed to do. Positive framing wins over negative: tell it what to do, not only what to avoid.
- **Guardrails.** Explicit, defensive instructions that override everything else. The classic example is a hard rule about never touching certain files or never sending something a human hasn't approved. Put it where the agent reads it before all else.
- **Error recovery.** Tell the agent what to do when something fails — retry once and stop, or state the problem and ask rather than silently improvising. This alone cuts the most frustrating class of agent failures.

A working template looks like this:

```text
You are [role]. Your job is [goal, written so you can tell when it's done].
You may use: [tools/list]. You may NOT: [guardrails].
Produce your result as [format]. 
When [condition], stop and ask me instead of continuing.
```

## Common mistakes and what to do instead

- **Vague goals.** "Help me with email" gives the agent no way to know it's done. "Triage my inbox and draft replies for anything urgent" gives it a finish line.
- **No stop rule.** Without one, the agent keeps working past the point of usefulness. Add the escalation line and you'll thank yourself.
- **Framing as a personality instead of a job.** "Be friendly and helpful" produces chat. "You are the agent that owns my morning briefing" produces results.
- **One giant prompt.** Small, focused prompts are easier to fix when something goes wrong, and your agent's [skills](/blog/ai-agent-skills-guide) should carry the repeatable parts so you're not re-typing them.

![AI agent prompt templates — starter kit](https://cdn.wolffi.sh/blog/how-to-prompt-ai-agent/prompt-templates.zip)

## The takeaway

The difference between an agent that impresses you and one that annoys you is usually the prompt. Spell out the role, the goal, the tools, the guardrails, the output format, and — above all — when it should stop and ask. That's the whole game, and it's why a personal agent's rules are worth writing in plain text where you can edit them.

If you want to see the pattern in action, the [Wolffish start guide](https://wolffi.sh/start#morning-briefing) builds a full morning-briefing agent from exactly these pieces — role, goal, tools, approvals — and shows how the instructions live in a file you can actually open and change.
