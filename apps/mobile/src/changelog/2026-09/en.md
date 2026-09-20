## v1.1.1 — 2026-09-20 `Latest`

### Every Automation, Project and Procedure Picks Its Own Thinking Level

Your saved automations, projects and procedures used to run at **whatever thinking level your chat happened to be set to** — so a nightly summary that needed a light pass could quietly run at maximum, and a deep analysis could run at minimum because you had turned the composer down earlier.

Each one now carries **its own thinking level** — off, normal, high or max — from a switch sitting right on its card, beside the mode pills it already had. New ones start at **the level your chat is showing right now**, so nothing changes until you decide otherwise; from then on the item decides, and its runs use it. **Anything saved before this update keeps following your chat exactly as it always did**, so nothing you already have behaves differently.

The levels on offer are **the ones your selected model actually honours**, so a card can never present a level the model would silently ignore.

### One Setting, Two Screens

The same switch on your phone reads and writes **the very same value** — change it on the desktop and your phone shows it, change it on your phone and the desktop shows it. They are not two copies taking turns; they are one setting seen from two places.

## v1.1.0 — 2026-09-03

### Your Organization, Not a Relay

Pairing used to build a private tunnel between the phone and the desktop through a relay, and every conversation, setting and file came down that tunnel — which meant a phone away from its desktop was a phone with nothing to show. The phone is now a **signed-in device of your organization**: scanning the desktop's QR or typing its code claims a session at the organization's API — no password to type — and from then on **conversations, settings, files and usage sync straight from the organization**. Everything already synced stays readable when the desktop is asleep, and the app says exactly which half is missing.

### The Desktop Runs It, the Organization Carries It

Turns still run on your desktop, where the models, capabilities and workspace live. A message you send reaches it through the organization's own bridge and streams back the same way — questions and approvals included — over one connection that comes up in well under a second when the app returns. Reconnecting is quieter (nothing to re-handshake, nothing to re-pin) and catching up is cheaper: the phone asks the organization only for what changed since it last looked, deletions included.

### Files Take the Direct Road

Photos and documents you attach upload to the organization the moment you send, under the same paths your desktop uses, and the desktop fetches them before the turn runs. Files the agent makes come from the organization's copy of the workspace — no more chunked transfers over a socket.

### Settings → Connection

The **Relay** screen is now **Connection**: the organization (your account, the API, its status), your desktop (its name, and whether it is running), the last catch-up, and sign-out — which revokes this phone's session at the organization and wipes the copy it holds. Unpairing from the desktop's Mobile panel does the same from the other side.
