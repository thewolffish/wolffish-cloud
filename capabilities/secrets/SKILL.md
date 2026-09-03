---
name: secrets
description: Save and look up the user's secrets and variables (Settings > Variables) — API keys, tokens, base URLs, and other reusable values
triggers:
  - secret
  - secrets
  - api key
  - apikey
  - token
  - password
  - credential
  - save my key
  - save this key
  - store my key
  - remember my key
  - save the token
  - variable
  - variables
  - env var
  - environment variable
  - base url
  - save this
  - remember this value
  - what secrets
  - which secrets
  - list secrets
  - list variables
  - do i have a key
  - my keys
tools:
  - name: add_secret
    description: Save a secret/variable to the user's store (Settings > Variables), the same place they add them from the UI. If a secret with the same name exists, its value is replaced. Never echo the value back in your reply.
    parameters:
      name:
        type: string
        description: Variable name the value is referenced by, e.g. "NOTION_TOKEN".
      value:
        type: string
        description: The secret/value to store.
      sensitive:
        type: boolean
        required: false
        description: Whether the value is a secret (masked in the Settings UI and in list_secrets). Defaults to true; pass false for non-secret config like a base URL.
  - name: list_secrets
    description: List the saved secrets/variables by name with masked values (first and last two characters) and a sensitive flag — enough to know what exists without putting a value into the transcript. Call before asking the user for any key/token/value. The real values are in your <variables> block; get_secret with reveal true returns one on demand.
    parameters: {}
  - name: get_secret
    description: Return ONE saved secret/variable by name. Without reveal you get the masked value. With reveal true the real value is returned — and then sits in this tool result, which is part of the conversation transcript (synced to the organization) — so reveal only when you must pass the value into another tool call and it is not already in your <variables> block. Never paste a revealed value into your reply.
    parameters:
      name:
        type: string
        description: Exact variable name, e.g. "NOTION_TOKEN".
      reveal:
        type: boolean
        required: false
        description: Pass true to receive the real value instead of the masked one. Defaults to false.
---

# Secrets & variables

Save and look up the user's named values — API keys, tokens, passwords, base
URLs — in the same store the **Settings > Variables** panel uses
(`config.json` → `variables`). A value saved here shows up in the Settings UI
and is made available to you in your `<variables>` context block, so you can
use it directly in later tool calls.

## Where a secret lives — and where it must not

- The store is the workspace `config.json`, which **syncs to the
  organization's master record** (encrypted at rest there) and to the user's
  other devices. Saving a secret means the organization's record holds it.
- Every **tool result is transcript material** and syncs the same way. That is
  why `list_secrets` masks every value and `get_secret` reveals one only when
  you say `reveal: true` — a revealed value is then part of the conversation
  record. Your `<variables>` block already carries the real values for tool
  calls; reach for `get_secret` only when a value is missing from it.

## When to use

- The user pastes an API key/token/password and asks you to save or remember it
  → `add_secret` (sensitive by default).
- The user gives you a reusable non-secret value (a base URL, an account id) and
  wants it kept → `add_secret` with `sensitive: false`.
- You're about to ask the user for a key/value — first `list_secrets` (or read
  your `<variables>` block) to check whether it already exists.
- The user asks "what keys/secrets do I have saved?" → `list_secrets`, and show
  them the names with the masked values, never the real ones.
- A tool call needs a value that is not in your `<variables>` block →
  `get_secret` with `reveal: true`, and use it in that call only.

## Tools

- `add_secret` — save (or update) a secret/variable. Same effect as adding it in
  the Variables UI. Replaces the value if the name already exists.
- `list_secrets` — names, masked values (`ab••••yz`, or `••••` for short
  values) and a sensitive flag. Never a real value.
- `get_secret` — one value by name; masked unless `reveal: true`.

## Rules

- **Don't ask the user for something you already have.** Check `list_secrets`
  or your `<variables>` block first.
- **Reveal only for a tool call, and only when needed.** If the value is in your
  `<variables>` block, use it from there; `get_secret` with `reveal: true` is
  the fallback, and it puts the value into the transcript.
- **Don't paste a sensitive value into your user-facing reply** — refer to it by
  name ("using your `NOTION_TOKEN`"). Using it in a tool call is fine.
- **Only save when the user asks.** Don't squirrel away values speculatively.
- **Default to sensitive.** A key, token, or password is sensitive. Use
  `sensitive: false` only for plainly non-secret config (a base URL, a region).
- **Updating replaces the old value.** If the name already exists, `add_secret`
  overwrites it — confirm you have the right name so you don't clobber a real key.
- This is the right tool for secrets — do **not** hand-edit `config.json` with
  the filesystem tools to add a variable.
