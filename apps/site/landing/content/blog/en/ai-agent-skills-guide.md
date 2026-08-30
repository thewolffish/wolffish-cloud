---
title: "Why AI Agents Skills Stop Working (and How to Write Better)"
description: "New research shows agent skills can actively hurt: as your skill pool grows, precision collapses. Here's how to write skills that actually help."
date: 2026-08-24
categories: [guides]
keywords: [AI agent skills, agent skills guide, why agent skills fail, how to write AI agent skills, prompt skills, agent skill pool, AI agent memory file, skills vs instructions, self-evolving agents]
image: https://cdn.wolffi.sh/blog/ai-agent-skills-guide/og.png
---

Your agent's skills stop working the moment you have too many — and a new research paper now quantifies exactly how badly it breaks. Across 8,135 normalized trials, precision fell from 29.6% to 3.3% as the skill pool grew from 5 to 100. The skills that seemed like magic at five turned into noise at a hundred. Here's what's actually happening and how to write skills that keep helping.

## What a skill is (and what it's not)

A skill is a compact description of *what to do, what to check, and what to avoid* — the procedural knowledge an agent reuses rather than rediscovering each run. It compresses messy experience into a short, stable format.

But the paper, [Demystifying Agent Skills](https://arxiv.org/abs/2608.14036), found the intuition most people have is backwards. You'd expect a skill to inject knowledge the model lacks. It turns out that's almost never what happens. Across the studied cases, skills worked by **procedural anchoring 65.7% of the time** — they stabilized the *steps*, the tool sequences, the setup routines, the verification checks — versus only **4.5% by explicit knowledge injection**. A skill rarely teaches the model a fact. It mostly keeps it from fumbling the familiar sequence.

That distinction matters: if you've been writing skills as little fact sheets, you're writing the wrong thing. Write the procedure.

### Skills vs. plain instructions

A skill beats a raw "workflow memory" (just dumping a past execution trace) by 6.06 points in matched comparisons. Why? A raw trace carries the noise — the failed branches, the dead ends, the verbose process. A skill distills it down to the part that works. When you drop a raw log into your agent's context, you hand it a pile of exploration; when you drop in a skill, you hand it the routine.

## Why skills degrade as the pool grows

The headline stat — 29.6% to 3.3% precision from 5 to 100 skills — is a *retrieval* problem, not a skill-quality problem. As more skills pile up, they start to look alike. The agent can't reliably pick the right one.

The counterintuitive part: **downstream task success stays fairly stable even as retrieval precision craters.** Picking slightly the wrong skill isn't fatal, because nearby skills often carry compatible procedural support. And picking the exactly-correct skill isn't a guarantee, either — a skill can be retrieved perfectly and still be insufficient to clear a task-level bottleneck like a timeout, a missing dependency, or numeric precision.

So the failure isn't "the model got dumber." It's that a large, confusable pool makes the retrieval step unreliable, and the payoff of getting it exactly right is smaller than you'd think.

![Agent skill retrieval precision by pool size — interactive chart](https://cdn.wolffi.sh/blog/ai-agent-skills-guide/skills-chart.html)

The paper identifies three failure boundaries overall: **brittle assumptions** (a skill written for one environment breaks in another), **incompatible contexts** (a skill applied where it doesn't fit), and **insufficient adaptation** (a skill that doesn't adapt when the situation shifts).

## How to write skills that keep working

- **Write the procedure, not the fact.** Lead with the ordered steps, the tool sequence, what to verify at the end. That's the 65.7% that works; knowledge injection is the 4.5%.
- **Keep the pool small.** Fewer, broader skills beat many near-duplicates. If you have skills that differ by one word, you've built your own confusable pool.
- **Name them for retrieval, not for humans.** A skill's title is what the agent searches against. Distinct, unambiguous names scale; clever names don't.
- **Specify the done-condition.** The failure mode that eats creative agents — "redesign the logo again forever" — comes from a missing stopping rule. State what "done" looks like in the skill.
- **Make context explicit.** State the environment and assumptions the skill was built for, so the agent doesn't apply it somewhere it doesn't fit.
- **Review what gets written to memory.** Agents that silently commit beliefs to a memory file accumulate noise nobody approved. Treat memory writes like reviewed commits, not autosaves.

The same discipline applies to how you extend any personal agent. If you're building one that reads and writes markdown skills, the practical version of this is: keep a small, well-named library, write procedures not fact-sheets, and never let the pool grow past what you can eyeball.

## The evergreen takeaway

Skills work until they don't — and "don't" arrives faster than most people expect. The single most useful habit is the same one the research keeps pointing at: **keep the skill pool small, write procedures, and state the done-condition.** That turns skills from a liability into a reliable lever.

If you're just starting out, the [what to automate first](https://wolffi.sh/blog/what-to-automate-first-ai-agent) guide helps you pick the first routine to encode, and the [what is MCP](https://wolffi.sh/blog/what-is-mcp-ai-agents) primer covers the tool layer your skills will call.
