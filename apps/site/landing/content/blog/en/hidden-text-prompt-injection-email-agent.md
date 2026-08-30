---
title: "Hidden Text Can Hijack Your AI Email Agent"
description: "Forcepoint showed a hidden HTML payload can silently hijack an AI email summarizer. Here's how the attack works and how to protect your agent."
date: 2026-08-29
categories: [news]
keywords: [prompt injection AI email, hidden text prompt injection, AI email agent security, indirect prompt injection email, Forcepoint AI email attack, AI agent hijack email, email summarizer attack, AI email security]
image: https://cdn.wolffi.sh/blog/hidden-text-prompt-injection-email-agent/og.png
---

A single invisible piece of text in an email can silently rewrite what your AI agent reports back to you. Researchers at Forcepoint X-Labs demonstrated exactly this: they sent an email to a mailbox with an indirect prompt-injection payload hidden by an HTML tag, invisible to the reader in Outlook but fully present in the HTML that went to a vulnerable AI email summarizer. The summarizer swallowed the hidden instructions, and its output was hijacked without the reader noticing anything wrong.

## The attack, step by step

The core problem is that a model reads an email the same way a program would, not the way a human does. The human sees a clean message; the agent sees the underlying HTML with instructions buried in it. Here's the shape of the attack:

1. **The payload hides in HTML.** Attackers use common HTML concealment techniques — a tag styled to be invisible, text shrunken to a pixel, drained to near-transparency, or marked display:none. The reader's mail client renders it invisible.
2. **The agent reads the raw HTML.** Because the summarizer processes the email's full markup, the hidden text enters the model's context window. The model can't tell it apart from the message body.
3. **The hidden text carries instructions.** The payload tells the model to behave a certain way — summarize this differently, follow this sequence, or drop a detail. The model obeys because it looks like legitimate content.
4. **The output is subtly wrong — and nobody sees tampering.** The summarizer returns a confident, plausible result that no longer matches the actual email. The reader has no reason to suspect the text they're reading is false.

Forcepoint classified what they found in the wild as content suppression and denial-of-service combined with persona hijacking — a payload that can silence some content and make the model act as if it were someone else. The same researchers had earlier found ten indirect prompt-injection payloads on real websites, some tucked into a site footer with a simple display:none.

## Why an AI email agent is so exposed

This is the exact use case that's booming — you hand your inbox to an agent to summarize it, draft replies, and flag the important stuff. That's precisely the setup that's hard to secure, because the agent's whole job is to ingest untrusted external content (incoming email) and then act on it. The threat model isn't a person tricking you; it's any message from anyone, read by a machine, that carries hidden instructions.

A few concrete ways to lower the risk:

1. **Understand that the content is untrusted.** Treat every email the agent reads as potentially containing instructions, not just data.
2. **Scope what it can do.** Give the agent the minimum — read and summarize, draft a reply, flag a thread — but not the right to send, delete, or take irreversible actions without your sign-off.
3. **Make it state its confidence, not just its answer.** Summary tools that say "here's what I saw" rather than "here's what happened" invite you to spot-check the source, which is where tampering gets caught.
4. **Watch for a summary that feels "off."** If an agent says an email asked for something you don't recognize, that's the moment to open the raw message — the evidence is usually visible once you look at the HTML.
5. **Keep a human in the loop on the actions that matter.** The summarizer is a draft; the send and the delete should still be you. That's the line in [AI agent security](/blog/ai-agent-security) that keeps an untrusted message from becoming an unauthorized action.

## The takeaway

![The prompt-injection one-pager: how hidden text hijacks an email agent and how to stop it](https://cdn.wolffi.sh/blog/hidden-text-prompt-injection-email-agent/takeaway.pdf)

This isn't a theoretical flaw — it's a demonstrated attack on the exact task people automate first. Invisible text is the weapon, and the email your agent reads is the delivery mechanism. The best defense isn't a smarter model; it's assuming incoming content can carry instructions, then giving your agent only enough power to be useful without being able to act on its own. If you're going to let an agent into your inbox, [the email automation guide](/blog/automate-email-with-ai-agent) walks through doing it safely — and [wolffi.sh/start](/start) is where you'd set the access boundaries to begin with.
