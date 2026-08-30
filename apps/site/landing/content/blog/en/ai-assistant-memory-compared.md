---
title: "ChatGPT vs Claude vs Gemini Memory, Compared"
description: "ChatGPT synthesizes you in the background, Claude shows every memory entry, Gemini ties memory to your Google account. Here's which design to trust."
date: 2026-08-21
categories: [guides, community]
keywords: [ChatGPT vs Claude vs Gemini memory, AI assistant memory, ChatGPT Dreaming memory, Claude memory, Gemini Personal Intelligence, which AI remembers you]
image: https://cdn.wolffi.sh/blog/ai-assistant-memory-compared/og.png
---

No assistant has a clearly "best" memory in 2026 — ChatGPT builds a rolling picture of you automatically, Claude shows every stored entry so you can edit it, and Gemini folds memory into your Google account. The right pick is the design you are willing to live with, not the one that sounds smartest in a screenshot.

## Why memory is now the product

A chatbot without memory makes you re-explain your job, your kids' names, and the fact you hate bullet-heavy emails, every Monday. A personal [AI agent](https://wolffi.sh/blog/what-is-a-personal-ai-agent) is only personal if it keeps that context. All three labs now ship memory by default. They just mean three different things by it.

## ChatGPT: Dreaming, the automatic biography

[OpenAI's Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq) describes the current system: when memory is on, ChatGPT remembers useful context from chats, files, and connected apps so you repeat yourself less. Controls live under **Settings → Personalization → Memory**.

The 2026 layer is a background synthesis — often called Dreaming in coverage — that rewrites facts as they go stale. OpenAI's own example: tell it you are going to Singapore in July, and later it may rewrite that to "you went to Singapore in July 2026." You never asked. The system decided the old version was wrong.

What you can see is a **memory summary**, last-updated timestamp and all. OpenAI is explicit that the summary is *not* the whole memory. Some details stay out of that view. To fully delete a fact you have to chase it through chats, archived chats, files, the summary, and any connected apps.

A legacy "saved memories" list still exists if you want every item visible and editable. Temporary Chat skips reads and writes. Deleting a conversation does **not** delete the memories it produced.

Free and Plus content, including memories, may be used to improve models unless you opt out under Data Controls. Business and Enterprise are excluded by default.

## Claude: individual entries you can see

Anthropic took the opposite bet: memory should be a list you can audit. Claude writes categorized entries in real time as you chat. Every entry is visible, editable, and deletable under Settings → Memory (or Capabilities → Memory, depending on the surface).

Two independent toggles:

- **Search and reference chats** — look up past conversations on demand
- **Generate memory from chats** — build the persistent entries

You can run either, both, or neither. Incognito skips both. Every Project gets its own memory space automatically — nicer isolation than ChatGPT's optional per-project switch.

Claude can import a memory snapshot from ChatGPT, Gemini, Copilot, or Grok. Export is still manual: copy the panel, ask Claude to dump it, or use the account data export. Team admins should know Incognito chats can still appear in org exports.

## Gemini: Personal Intelligence, tied to Google

Google's memory is not a separate product. It is **Personal Intelligence**, sitting on your Google account. [Google's help page](https://support.google.com/gemini/answer/16598469?hl=en) and the [Personal Intelligence overview](https://gemini.google/overview/personal-intelligence/) describe two layers:

- Memory of past Gemini chats (requires Keep Activity on)
- Connected apps — currently Gmail, Google Photos, Search, and YouTube, with more coming if you allow them

You must be 18+, on a personal Google account (not work, school, or supervised). The feature is rolling out globally as a beta, and Google states it is **not** available in the EEA, Switzerland, the UK, or Nigeria. Toggle it under Settings & help → Personal Intelligence.

Delete a chat and there can be a delay before Gemini stops using it. To erase a fact that also lives in a connected app you must delete the chats *and* disconnect the app — either step alone is not enough. Temporary Chat skips history, Keep Activity, personalization, and training, and is retained up to 72 hours.

You cannot see the automatic Personal Intelligence layer the way you see Claude's entries. Saved instructions ("Saved info") are visible. The inferred layer is not.

## The differences that actually matter

| | ChatGPT | Claude | Gemini |
| --- | --- | --- | --- |
| Official name | Memory (Dreaming) | Memory | Personal Intelligence |
| How it saves | Background synthesis across chats | Individual entries, live | Account + connected Google apps |
| Can you see everything? | Summary; full list only in legacy mode | Yes — every entry | Instructions yes; inferred layer no |
| Project isolation | Optional when you create a Project | Automatic per Project | Account-wide; notebooks on paid tiers |
| Import from others | No | ChatGPT, Gemini, Copilot, Grok | ChatGPT or Claude (plus chat-history ZIP) |
| Export | Not a dedicated memory export | Manual / account export | Google Takeout |
| Off switch | Temporary Chat; disable Memory | Incognito; two toggles | Temporary Chat; Memory toggle |

![How the Three Memory Designs Differ](https://cdn.wolffi.sh/blog/ai-assistant-memory-compared/memory-designs.html)

## Which design to trust

- **You never want to think about it** → ChatGPT. Accept that the summary is incomplete.
- **You want to see and delete every stored fact** → Claude.
- **Your life already lives in Gmail, Photos, and YouTube** → Gemini, if you are outside the excluded regions and okay with Google-account gravity.
- **You use more than one assistant** → Claude is the only one that imports widely; ChatGPT imports nothing. Plan on periodic copy-paste, or keep a local memory the assistants do not own.

None of the three sync with each other after the import snapshot. The coding assistant knows your stack, the writing one knows your voice, the inbox one knows your week. A [local-first agent](https://wolffi.sh/blog/local-first-vs-cloud-ai-assistant) that keeps memory in a folder on your machine is the way to have one biography instead of three.

## Takeaway

Memory is no longer a beta toggle — it is how these products lock in. ChatGPT automates, Claude discloses, Gemini attaches to Google. Turn it on where the design matches your tolerance for opacity, use Temporary/Incognito for anything you would not want in a biography, and do not assume deleting a chat deletes the memory.

![AI Memory Compared — One-Page Takeaway](https://cdn.wolffi.sh/blog/ai-assistant-memory-compared/takeaway.pdf)
