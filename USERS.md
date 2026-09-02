# USERS.md — the Wolffish Inc roster

The 50 seeded people of **Wolffish Inc**, the org living in the production-like
deployment at [api.wolffi.sh](https://api.wolffi.sh). These are real, fully
functional accounts — nothing in the schema or API marks them as demo — minted
deterministically by [`apps/api/scripts/seed-demo.mjs`](apps/api/scripts/seed-demo.mjs).
Sign in as any active one from the desktop app (`apps/desktop`, `npm run dev`)
to experience that role.

## Passwords

Every seeded account shares one fixed password: **`wolffish`** — except the
human owner (000), whose password survives reseeds untouched once rotated
through the in-app reset flow. The release gate authenticates as the
dedicated service owner (050), never as a person. This is
committed on purpose — the repo is a POC master and the desktop sign-in form
prefills it, so a demo needs only an email. Client forks rotate it (set
`WFC_DEMO_PASSWORD` when seeding, or replace seeding entirely) and drop the
prefill. Any single account can still be rotated live from an admin session
(`POST /admin/users/:id/reset-password` returns a one-time temp password and
forces a personal password on next sign-in). The 4-digit PIN each device asks
for is local-only and never reaches the server.

## The cast

Phone numbers are deterministic fakes minted by the seed — only the owner's
(000) is real.

| # | Email | Name | Position | Phone | Role | Status | Model policy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 000 | `younes@wolffi.sh` | Younes Alturkey | Founder & Engineer | +966 53 865 4514 | owner | active | org defaults |
| 001 | `shahad.alotaibi.01@demo.wolffi.sh` | Shahad Alotaibi | IT Administrator | +966 51 800 1239 | admin | active | org defaults |
| 002 | `abrar.okafor.02@demo.wolffi.sh` | Abrar Okafor | IT Administrator | +966 58 364 0099 | admin | active | org defaults |
| 003 | `saad.alotaibi.03@demo.wolffi.sh` | Saad Alotaibi | IT Support Specialist | +966 57 764 5888 | support | active | org defaults |
| 004 | `alia.okafor.04@demo.wolffi.sh` | Alia Okafor | IT Support Specialist | +966 57 304 9856 | support | active | org defaults |
| 005 | `hamad.okafor.05@demo.wolffi.sh` | Hamad Okafor | Solutions Consultant | +966 55 775 5725 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 006 | `amal.okafor.06@demo.wolffi.sh` | Amal Okafor | Customer Support Specialist | +966 56 746 6609 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 007 | `sara.okafor.07@demo.wolffi.sh` | Sara Okafor | Marketing Manager | +966 53 757 3467 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 008 | `alia.petrov.08@demo.wolffi.sh` | Alia Petrov | Senior Software Engineer | +966 54 312 0425 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 009 | `hamad.aldossari.09@demo.wolffi.sh` | Hamad Aldossari | Backend Engineer | +966 53 853 6554 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 010 | `khalid.almutairi.10@demo.wolffi.sh` | Khalid Almutairi | Content Marketer | +966 52 558 9223 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 011 | `bandar.rossi.11@demo.wolffi.sh` | Bandar Rossi | Technical Support Engineer | +966 50 588 7058 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 012 | `yousef.alghamdi.12@demo.wolffi.sh` | Yousef Alghamdi | Technical Support Engineer | +966 55 528 9200 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 013 | `lubna.almutairi.13@demo.wolffi.sh` | Lubna Almutairi | Content Marketer | +966 56 037 1756 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 014 | `waleed.almutairi.14@demo.wolffi.sh` | Waleed Almutairi | Senior Software Engineer | +966 56 536 2823 | employee | active | models: DeepSeek-V4-Flash-0731 |
| 015 | `alia.aljuhani.15@demo.wolffi.sh` | Alia Aljuhani | Software Engineer | +966 57 941 8789 | employee | active | daily cap: 50,000 tokens |
| 016 | `amal.almutairi.16@demo.wolffi.sh` | Amal Almutairi | Sales Development Rep | +966 54 555 5082 | employee | active | daily cap: 100,000 tokens |
| 017 | `yousef.kim.17@demo.wolffi.sh` | Yousef Kim | Account Executive | +966 52 529 4971 | employee | active | daily cap: 150,000 tokens |
| 018 | `saad.almutairi.18@demo.wolffi.sh` | Saad Almutairi | Customer Support Specialist | +966 53 511 5418 | employee | active | daily cap: 200,000 tokens |
| 019 | `sultan.alzahrani.19@demo.wolffi.sh` | Sultan Alzahrani | Marketing Manager | +966 52 513 6811 | employee | active | daily cap: 250,000 tokens |
| 020 | `ziyad.demir.20@demo.wolffi.sh` | Ziyad Demir | Marketing Manager | +966 56 191 6928 | employee | active | models: DeepSeek-V4-Flash-0731; daily cap: 1,000 tokens |
| 021 | `maha.alsubaie.21@demo.wolffi.sh` | Maha Alsubaie | Marketing Manager | +966 57 698 3590 | employee | active | org defaults |
| 022 | `amal.rossi.22@demo.wolffi.sh` | Amal Rossi | Technical Support Engineer | +966 59 063 4736 | employee | active | org defaults |
| 023 | `alia.alzahrani.23@demo.wolffi.sh` | Alia Alzahrani | Customer Support Specialist | +966 51 747 5595 | employee | active | org defaults |
| 024 | `meshal.petrov.24@demo.wolffi.sh` | Meshal Petrov | Solutions Consultant | +966 57 040 4318 | employee | active | org defaults |
| 025 | `shahad.alharbi.25@demo.wolffi.sh` | Shahad Alharbi | Senior Software Engineer | +966 56 065 4212 | employee | active | org defaults |
| 026 | `salman.haddad.26@demo.wolffi.sh` | Salman Haddad | Customer Support Specialist | +966 55 224 8022 | employee | active | org defaults |
| 027 | `osama.demir.27@demo.wolffi.sh` | Osama Demir | Sales Development Rep | +966 54 316 2156 | employee | active | org defaults |
| 028 | `nawaf.alotaibi.28@demo.wolffi.sh` | Nawaf Alotaibi | Solutions Consultant | +966 54 082 1577 | employee | active | org defaults |
| 029 | `maha.iyer.29@demo.wolffi.sh` | Maha Iyer | Senior Software Engineer | +966 50 682 9298 | employee | active | org defaults |
| 030 | `nora.alzahrani.30@demo.wolffi.sh` | Nora Alzahrani | Customer Support Specialist | +966 58 581 2510 | employee | active | org defaults |
| 031 | `sultan.okafor.31@demo.wolffi.sh` | Sultan Okafor | Marketing Manager | +966 59 016 6415 | employee | active | org defaults |
| 032 | `joud.aldossari.32@demo.wolffi.sh` | Joud Aldossari | Account Executive | +966 59 280 3665 | employee | active | org defaults |
| 033 | `dana.aldossari.33@demo.wolffi.sh` | Dana Aldossari | Solutions Consultant | +966 58 848 7875 | employee | active | org defaults |
| 034 | `anas.alotaibi.34@demo.wolffi.sh` | Anas Alotaibi | Backend Engineer | +966 51 493 0859 | employee | active | org defaults |
| 035 | `saad.aldossari.35@demo.wolffi.sh` | Saad Aldossari | Software Engineer | +966 50 587 8813 | employee | active | org defaults |
| 036 | `yousef.almutairi.36@demo.wolffi.sh` | Yousef Almutairi | Data Engineer | +966 54 558 8399 | employee | active | org defaults |
| 037 | `lubna.haddad.37@demo.wolffi.sh` | Lubna Haddad | Site Reliability Engineer | +966 54 966 4932 | employee | active | org defaults |
| 038 | `maha.alzahrani.38@demo.wolffi.sh` | Maha Alzahrani | Frontend Engineer | +966 55 850 9342 | employee | active | org defaults |
| 039 | `salman.demir.39@demo.wolffi.sh` | Salman Demir | Software Engineer | +966 56 938 7034 | employee | active | org defaults |
| 040 | `lubna.demir.40@demo.wolffi.sh` | Lubna Demir | DevOps Engineer | +966 55 104 8578 | employee | active | org defaults |
| 041 | `shahad.haddad.41@demo.wolffi.sh` | Shahad Haddad | Marketing Manager | +966 59 031 9433 | employee | active | org defaults |
| 042 | `rakan.nakamura.42@demo.wolffi.sh` | Rakan Nakamura | Technical Support Engineer | +966 51 545 7832 | employee | active | org defaults |
| 043 | `hana.alqahtani.43@demo.wolffi.sh` | Hana Alqahtani | Solutions Consultant | +966 58 113 9109 | employee | active | org defaults |
| 044 | `dana.novak.44@demo.wolffi.sh` | Dana Novak | Senior Software Engineer | +966 54 533 6172 | employee | active | org defaults |
| 045 | `faisal.almutairi.45@demo.wolffi.sh` | Faisal Almutairi | Senior Software Engineer | +966 50 137 9906 | employee | active | org defaults |
| 046 | `yousef.demir.46@demo.wolffi.sh` | Yousef Demir | Backend Engineer | +966 56 929 6141 | employee | active | org defaults |
| 047 | `salman.aljuhani.47@demo.wolffi.sh` | Salman Aljuhani | QA Engineer | +966 52 071 4016 | employee | active | org defaults |
| 048 | `layla.petrov.48@demo.wolffi.sh` | Layla Petrov | Sales Development Rep | +966 56 526 7535 | employee | suspended (demo of suspension) | org defaults |
| 049 | `rania.alotaibi.49@demo.wolffi.sh` | Rania Alotaibi | Software Engineer | +966 57 050 0197 | employee | invited — first login forces a password change | org defaults |
| 050 | `gate.keeper.50@demo.wolffi.sh` | Gate Keeper | Release Gate | +966 56 544 8741 | owner | active | org defaults |

Positions and bios paint Wolffish Inc as a tech company — engineering, DevOps,
support, marketing and sales — all minted deterministically by the seed.
Policy variety is deliberate so every admin surface has something true to show:
a block locked to the default model, a ladder of tightening daily caps, and one
account (20) capped so low the router refuses it almost immediately.

## Housekeeping accounts

The live database also accumulates throwaway `verify-*` / `authcheck-*` users
created by the release-gate and auth-check scripts; each run leaves its user
suspended. They are working artifacts, not part of the cast.

Regenerating: the roster (ids, emails, names, roles, positions, bios, policies)
is a pure function of the seed script — reseeding reproduces this table byte
for byte, passwords excepted.
