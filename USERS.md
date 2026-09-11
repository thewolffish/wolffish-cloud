# USERS.md — the Wolffish Inc roster

The 51 seeded people of **Wolffish Inc**, the org living in the production-like
deployment at [api.wolffi.sh](https://api.wolffi.sh). These are real, fully
functional accounts — nothing in the schema or API marks them as demo — minted
deterministically by [`apps/api/scripts/seed-demo.mjs`](apps/api/scripts/seed-demo.mjs).
Sign in as any active one from the desktop app (`apps/desktop`, `npm run dev`)
to experience that role.

Everyone is a named person at a company address: a written-down cast of Saudi
names, each at `first.last@wolffi.sh`, with nothing in the address marking the
row as a fixture. What marks it is the id — every seeded account is
`usr_demo_NNN`, which is what `--wipe` and the sweeps below match on, and the
only thing that should ever have carried that job.

## Passwords

Every seeded account shares one fixed password: **`wolffish123`** — all 51 of
them, the human owner (000) included, so the demo password is one string with
no footnote. The release gate authenticates as the dedicated service owner
(050) — a named person like everyone here, but nobody's working account, so
a gate run never revokes the sessions of someone mid-demo. This is committed on purpose — the repo is a POC
master and the desktop sign-in form prefills it, so a demo needs only an
email. Client forks rotate it (set `WFC_DEMO_PASSWORD` when seeding, or
replace seeding entirely) and drop the prefill. Any single account can still
be rotated live from an admin session (`POST /admin/users/:id/reset-password`
returns a one-time temp password and forces a personal password on next
sign-in) — until the next reseed writes the shared one back. The 4-digit PIN
each device asks for is local-only and never reaches the server.

## The cast

Phone numbers are deterministic fakes minted by the seed — only the owner's
(000) is real.

| # | Email | Name | Position | Phone | Role | Status | Model policy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 000 | `younes@wolffi.sh` | Younes Alturkey | Founder & Engineer | +966 53 865 4514 | owner | active | full catalog |
| 001 | `shahad.alotaibi@wolffi.sh` | Shahad Alotaibi | IT Administrator | +966 51 800 1239 | admin | active | full catalog |
| 002 | `abdulaziz.alqahtani@wolffi.sh` | Abdulaziz Alqahtani | IT Administrator | +966 58 364 0099 | admin | active | full catalog |
| 003 | `saad.alharbi@wolffi.sh` | Saad Alharbi | IT Support Specialist | +966 57 764 5888 | support | active | org defaults |
| 004 | `alia.alghamdi@wolffi.sh` | Alia Alghamdi | IT Support Specialist | +966 57 304 9856 | support | active | org defaults |
| 005 | `hamad.alshehri@wolffi.sh` | Hamad Alshehri | Solutions Consultant | +966 55 775 5725 | employee | active | models: DeepSeek-V4.1-Flash |
| 006 | `amal.alzahrani@wolffi.sh` | Amal Alzahrani | Customer Support Specialist | +966 56 746 6609 | employee | active | models: DeepSeek-V4.1-Flash |
| 007 | `sara.almutairi@wolffi.sh` | Sara Almutairi | Marketing Manager | +966 53 757 3467 | employee | active | models: DeepSeek-V4.1-Flash |
| 008 | `faisal.aldossari@wolffi.sh` | Faisal Aldossari | Senior Software Engineer | +966 54 312 0425 | employee | active | models: DeepSeek-V4.1-Flash |
| 009 | `lina.alsubaie@wolffi.sh` | Lina Alsubaie | Backend Engineer | +966 53 853 6554 | employee | active | models: DeepSeek-V4.1-Flash |
| 010 | `khalid.aljuhani@wolffi.sh` | Khalid Aljuhani | Content Marketer | +966 52 558 9223 | employee | active | models: DeepSeek-V4.1-Flash |
| 011 | `bandar.alanazi@wolffi.sh` | Bandar Alanazi | Technical Support Engineer | +966 50 588 7058 | employee | active | models: DeepSeek-V4.1-Flash |
| 012 | `yousef.alshammari@wolffi.sh` | Yousef Alshammari | Technical Support Engineer | +966 55 528 9200 | employee | active | models: DeepSeek-V4.1-Flash |
| 013 | `lubna.alrashidi@wolffi.sh` | Lubna Alrashidi | Content Marketer | +966 56 037 1756 | employee | active | models: DeepSeek-V4.1-Flash |
| 014 | `waleed.albalawi@wolffi.sh` | Waleed Albalawi | Senior Software Engineer | +966 56 536 2823 | employee | active | models: DeepSeek-V4.1-Flash |
| 015 | `noura.alamri@wolffi.sh` | Noura Alamri | Software Engineer | +966 57 941 8789 | employee | active | org defaults |
| 016 | `turki.almalki@wolffi.sh` | Turki Almalki | Sales Development Rep | +966 54 555 5082 | employee | active | org defaults |
| 017 | `reem.alyami@wolffi.sh` | Reem Alyami | Account Executive | +966 52 529 4971 | employee | active | org defaults |
| 018 | `saad.alharthi@wolffi.sh` | Saad Alharthi | Customer Support Specialist | +966 53 511 5418 | employee | active | org defaults |
| 019 | `sultan.alqurashi@wolffi.sh` | Sultan Alqurashi | Marketing Manager | +966 52 513 6811 | employee | active | org defaults |
| 020 | `ziyad.alhazmi@wolffi.sh` | Ziyad Alhazmi | Marketing Manager | +966 56 191 6928 | employee | active | org defaults |
| 021 | `maha.alruwaili@wolffi.sh` | Maha Alruwaili | Marketing Manager | +966 57 698 3590 | employee | active | org defaults |
| 022 | `anas.alenezi@wolffi.sh` | Anas Alenezi | Technical Support Engineer | +966 59 063 4736 | employee | active | org defaults |
| 023 | `dana.alturki@wolffi.sh` | Dana Alturki | Customer Support Specialist | +966 51 747 5595 | employee | active | org defaults |
| 024 | `meshal.altamimi@wolffi.sh` | Meshal Altamimi | Solutions Consultant | +966 57 040 4318 | employee | active | org defaults |
| 025 | `shahad.alharbi@wolffi.sh` | Shahad Alharbi | Senior Software Engineer | +966 56 065 4212 | employee | active | org defaults |
| 026 | `salman.alrajhi@wolffi.sh` | Salman Alrajhi | Customer Support Specialist | +966 55 224 8022 | employee | active | org defaults |
| 027 | `osama.alqahtani@wolffi.sh` | Osama Alqahtani | Sales Development Rep | +966 54 316 2156 | employee | active | org defaults |
| 028 | `nawaf.alotaibi@wolffi.sh` | Nawaf Alotaibi | Solutions Consultant | +966 54 082 1577 | employee | active | org defaults |
| 029 | `jana.alnasser@wolffi.sh` | Jana Alnasser | Senior Software Engineer | +966 50 682 9298 | employee | active | org defaults |
| 030 | `norah.alghamdi@wolffi.sh` | Norah Alghamdi | Customer Support Specialist | +966 58 581 2510 | employee | active | org defaults |
| 031 | `rakan.alrasheed@wolffi.sh` | Rakan Alrasheed | Marketing Manager | +966 59 016 6415 | employee | active | org defaults |
| 032 | `joud.aldakhil@wolffi.sh` | Joud Aldakhil | Account Executive | +966 59 280 3665 | employee | active | org defaults |
| 033 | `ghada.alzamil@wolffi.sh` | Ghada Alzamil | Solutions Consultant | +966 58 848 7875 | employee | active | org defaults |
| 034 | `abdullah.alolayan@wolffi.sh` | Abdullah Alolayan | Backend Engineer | +966 51 493 0859 | employee | active | org defaults |
| 035 | `layla.alsuwailem@wolffi.sh` | Layla Alsuwailem | Software Engineer | +966 50 587 8813 | employee | active | org defaults |
| 036 | `fahad.almutairi@wolffi.sh` | Fahad Almutairi | Data Engineer | +966 54 558 8399 | employee | active | org defaults |
| 037 | `wafa.alhamdan@wolffi.sh` | Wafa Alhamdan | Site Reliability Engineer | +966 54 966 4932 | employee | active | org defaults |
| 038 | `majed.alsudairi@wolffi.sh` | Majed Alsudairi | Frontend Engineer | +966 55 850 9342 | employee | active | org defaults |
| 039 | `rania.albishi@wolffi.sh` | Rania Albishi | Software Engineer | +966 56 938 7034 | employee | active | org defaults |
| 040 | `yazeed.aloraini@wolffi.sh` | Yazeed Aloraini | DevOps Engineer | +966 55 104 8578 | employee | active | org defaults |
| 041 | `farah.alhussain@wolffi.sh` | Farah Alhussain | Marketing Manager | +966 59 031 9433 | employee | active | org defaults |
| 042 | `tariq.alsahli@wolffi.sh` | Tariq Alsahli | Technical Support Engineer | +966 51 545 7832 | employee | active | org defaults |
| 043 | `hana.alfaraj@wolffi.sh` | Hana Alfaraj | Solutions Consultant | +966 58 113 9109 | employee | active | org defaults |
| 044 | `badr.aldawood@wolffi.sh` | Badr Aldawood | Senior Software Engineer | +966 54 533 6172 | employee | active | org defaults |
| 045 | `latifa.alshaya@wolffi.sh` | Latifa Alshaya | Senior Software Engineer | +966 50 137 9906 | employee | active | org defaults |
| 046 | `mohammed.alharbi@wolffi.sh` | Mohammed Alharbi | Backend Engineer | +966 56 929 6141 | employee | active | org defaults |
| 047 | `abrar.almogbel@wolffi.sh` | Abrar Almogbel | QA Engineer | +966 52 071 4016 | employee | active | org defaults |
| 048 | `talal.alkhathlan@wolffi.sh` | Talal Alkhathlan | Sales Development Rep | +966 56 526 7535 | employee | suspended (demo of suspension) | org defaults |
| 049 | `ruba.alsanea@wolffi.sh` | Ruba Alsanea | Software Engineer | +966 57 050 0197 | employee | invited — first login forces a password change | org defaults |
| 050 | `nasser.alowais@wolffi.sh` | Nasser Alowais | Release Gate | +966 56 544 8741 | owner | active | full catalog |

Positions and bios paint Wolffish Inc as a tech company — engineering, DevOps,
support, marketing and sales — all minted deterministically by the seed.

Policy variety is deliberate, so every admin surface has something true to show
and no two model pickers are guaranteed to match:

- **Both owners (000, 050) and both admins (001, 002)** hold the full catalog.
  An owner locked out of a model the org runs could not administer it.
- **005–014** are locked to the default model alone — the narrowing case.
- **Everyone else** runs on org defaults: Flash and Pro, no per-user caps.
  (021–030 were a vision pilot on the experimental `Flash-Vision-Exp` until
  2026-09-11, when V4.1 Flash — which sees — became the org's Flash and the
  grant had nothing left to grant.)

Caps are unset across the baseline (0/NULL = unlimited); a fork switches them
on through the admin API. The seeded week of usage only ever names a model its
own account is allowed, so the dashboards never have to explain a charge that
policy would have refused.

## Phones

No seeded account ships with a phone paired. Pairing is two taps, and a demo
that arrives already attached to a handset nobody owns hides the one control
worth trying — so every seed run sweeps the mobile device rows off the cast,
keeping only the ones that hold a live session. That is the whole rule: a
device row nobody is signed in on is not a phone, it is a ghost of one. The
owner's real handset (000) has a live session and survives; a row still marked
active whose sessions expired weeks ago does not, which is what used to make
the owner's account show two iPhones in the admin device list.

**One phone at a time.** The backend will hold several, but the desktop's
Mobile panel withdraws the pairing control the moment a phone is listed
(`SINGLE_PHONE`, `MobilePanel.tsx`), so a seeded or gate-run account must
never end up with two — `smoke-bridge.mjs` unpairs its first phone before
claiming the second with a QR, and leaves none behind.

## Housekeeping accounts

The live database also accumulates throwaway users minted by the release-gate
and auth-check scripts. They carry real names too, and their addresses are
Resend's own safe test inbox (`delivered+wfc-*@resend.dev`) so an invite or a
reset really sends mail without bouncing a message off the org's live domain
every run. Each run leaves its user suspended. They are working artifacts, not
part of the cast.

Regenerating: the roster (ids, emails, names, roles, positions, bios, policies)
is a pure function of the seed script — reseeding reproduces this table byte
for byte, passwords excepted. The table above was generated from the rows a
seed run actually wrote, not from a reading of the script.

The release gate signs in as **050, `nasser.alowais@wolffi.sh`** — the service
owner every script defaults to (`WFC_OWNER_EMAIL` / `--email` override it).
Its `position` is what says "Release Gate"; its address is a person's, like
everyone else's here.
