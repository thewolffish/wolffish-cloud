---
title: "Who Pays When Your AI Agent Acts Without Permission?"
description: "AI agents can now spend money and send messages for you. When one crosses a line, who is liable? Here's what the new protocols and rules mean for you."
date: 2026-08-25
categories: [news]
keywords: [AI agent liability, who is liable for AI agent, AI agent accountability, agent payments protocol, AP2 protocol, AI AGENT Act, can AI agents buy things, AI agent mistakes, AI agent authorization]
image: https://cdn.wolffi.sh/blog/ai-agent-liability/og.png
---

If your AI agent fires off a purchase you never approved, who pays? That question went from hypothetical to urgent this week, as Google's new Agent Payments Protocol (AP2) and a Senate bill both wrestle with the same blank spot in current law: an agent can act on your behalf, but the rules for when *you* are responsible for its actions aren't written yet.

## The accountability gap, explained

The problem isn't that agents are reckless — it's that the entire payments and contract system was built around a person clicking "confirm." AP2's own specification states that current payment protocols "lack the mechanisms to securely validate an agent's authenticity and authority to transact," which "creates ambiguity around transaction liability." In plain terms: when a human pays, there's a signature. When an agent pays, there's... a prompt you may not have read.

This is the same gap every agent touchpoint hits, not just payments. An agent that deletes a file, books a non-refundable trip, or sends an email from your account inherits the same ambiguity. The tech moved faster than the rulebook.

## What's being built to close it

Three things are converging right now:

1. **Google's Agent Payments Protocol (AP2).** [Announced in 2026](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol), AP2 builds on the A2A agent protocol to let an agent request a payment, and lets *you* sign an authorization — a "Cart Mandate" for the merchant and a "Payment Mandate" for the network — on your device, not in the agent's blind spot. The point is that each transaction now carries a record you approved.

2. **NIST's work on agent identity and permission.** Regulators are converging on verifiable, task-bounded authorization: who this agent is, what it's allowed to do, and for how long.

3. **The AI AGENT Act (S.5051).** [Introduced by Sen. Mark Warner on July 21, 2026](https://fortune.com/2026/08/24/google-ai-agent-payment-protocol-gap/), the bill pushes toward signed task authorizations and auditable trails for agents that take consequential actions — so a dispute can be settled without a forensic audit across disconnected systems.

None of these are law yet, but the direction is clear: an agent's authority should be scoped, signed, and short-lived — not an open-ended pass to your accounts.

## What it means for you, today

You don't need to wait for regulation to protect yourself. The practical rules are the same ones security teams already use:

- **Give an agent a budget limit, not a blank check.** If an agent can pay, cap the amount and make any larger purchase require your confirm.
- **Require approval for irreversible moves.** Bookings, sends, deletes — make the agent stop and ask.
- **Prefer agents you can audit.** A [local-first agent](https://wolffi.sh/blog/local-first-vs-cloud-ai-assistant) keeps every action on your own machine, so there's no mystery about what it did or why.
- **Keep the human in the loop where it matters.** The best agents are great at the repetitive 90% and [step aside for judgment calls](https://wolffi.sh/blog/what-is-a-personal-ai-agent).

![AI Agent Accountability — the one-page takeaway](https://cdn.wolffi.sh/blog/ai-agent-liability/liability-takeaway.pdf)

## The takeaway

The "who pays" question has a clear answer for now: **you do** — because you're the account holder, and no protocol changes that until an agent's authority is signed and scoped. The good news is that AP2 and the AI AGENT Act are building exactly that. Until they land, treat every agent action like a transaction you'd have to explain — because you might.

That's not a reason to avoid agents; it's a reason to choose one that asks permission, keeps a record, and puts your data where you can see it.
