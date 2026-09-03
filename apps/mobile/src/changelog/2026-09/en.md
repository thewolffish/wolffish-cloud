## v1.1.0 — 2026-09-03 `Latest`

### Your Organization, Not a Relay

Pairing used to build a private tunnel between the phone and the desktop through a relay, and every conversation, setting and file came down that tunnel — which meant a phone away from its desktop was a phone with nothing to show. The phone is now a **signed-in device of your organization**: scanning the desktop's QR or typing its code claims a session at the organization's API — no password to type — and from then on **conversations, settings, files and usage sync straight from the organization**. Everything already synced stays readable when the desktop is asleep, and the app says exactly which half is missing.

### The Desktop Runs It, the Organization Carries It

Turns still run on your desktop, where the models, capabilities and workspace live. A message you send reaches it through the organization's own bridge and streams back the same way — questions and approvals included — over one connection that comes up in well under a second when the app returns. Reconnecting is quieter (nothing to re-handshake, nothing to re-pin) and catching up is cheaper: the phone asks the organization only for what changed since it last looked, deletions included.

### Files Take the Direct Road

Photos and documents you attach upload to the organization the moment you send, under the same paths your desktop uses, and the desktop fetches them before the turn runs. Files the agent makes come from the organization's copy of the workspace — no more chunked transfers over a socket.

### Settings → Connection

The **Relay** screen is now **Connection**: the organization (your account, the API, its status), your desktop (its name, and whether it is running), the last catch-up, and sign-out — which revokes this phone's session at the organization and wipes the copy it holds. Unpairing from the desktop's Mobile panel does the same from the other side.
