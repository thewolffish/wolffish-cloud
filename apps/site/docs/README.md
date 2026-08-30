<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="wolffish" />
</picture>

# wolffish-docs

**The complete guide to owning your brain.**

Official documentation for [Wolffish](https://github.com/thewolffish) — the local-first, markdown-powered personal AI desktop agent. Published at [docs.wolffi.sh](https://docs.wolffi.sh/).

Fully bilingual (English + Arabic). Covers everything from first launch to writing custom brain modules.

---

## Get the mobile app

Wolffish Mobile is the companion phone app — pair it to your desktop once by scanning a QR code, then reach your agent from anywhere over an end-to-end encrypted tunnel.

<table>
  <tr>
    <td align="center">
      <a href="https://apps.apple.com/us/app/wolffish/id6792797989"><img src="https://cdn.wolffi.sh/generic/app-store.svg" width="168" height="56" alt="Download on the App Store" /></a>
    </td>
    <td align="center">
      <a href="https://play.google.com/store/apps/details?id=sh.wolffi.mobile"><img src="https://cdn.wolffi.sh/generic/google-play.svg" width="189" height="56" alt="Get it on Google Play" /></a>
    </td>
  </tr>
</table>

Source: [thewolffish/wolffish-mobile](https://github.com/thewolffish/wolffish-mobile)

---

## Watch

<table>
  <tr>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=oog1q7T8H-s"><img src="https://cdn.wolffi.sh/generic/demo_walkthrough.jpg" width="360" alt="Demo walkthrough" /></a>
      <br /><b>Demo walkthrough</b>
    </td>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=XZdBttn-99E"><img src="https://cdn.wolffi.sh/generic/cinematic_launch.jpg" width="360" alt="Cinematic launch" /></a>
      <br /><b>Cinematic launch</b>
    </td>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=TKdTWd6BXR8"><img src="https://cdn.wolffi.sh/generic/cinematic_reveal.jpg" width="360" alt="Cinematic reveal" /></a>
      <br /><b>Cinematic reveal</b>
    </td>
  </tr>
</table>

---

## What's Inside

### Get Started

| Page                                             | What You'll Learn                                            |
| ------------------------------------------------ | ------------------------------------------------------------ |
| [Overview](introduction/overview.mdx)            | What wolffish is and how it works at a glance                |
| [Philosophy](introduction/philosophy.mdx)        | The 8 design principles that guide every decision            |
| [Installation](getting-started/installation.mdx) | Download, prerequisites, build from source                   |
| [First Launch](getting-started/first-launch.mdx) | What happens when you run wolffish for the first time        |
| [Quickstart](getting-started/quickstart.mdx)     | 5 steps to send your first message and inspect the internals |

### Core Concepts

| Page                                               | What You'll Learn                                      |
| -------------------------------------------------- | ------------------------------------------------------ |
| [God's Creation](architecture/gods-creation.mdx)   | How 14 human brain regions map to software modules     |
| [Architecture Overview](architecture/overview.mdx) | 15-module runtime, event bus, deterministic pipeline   |
| [Pipeline](architecture/pipeline.mdx)              | Step-by-step message flow with token budget allocation |
| [Brain Modules](architecture/brain-modules.mdx)    | Complete reference for all 15 modules                  |
| [Workspace](architecture/workspace.mdx)            | The `~/.wolffish/` directory structure                 |
| [Event Bus](architecture/event-bus.mdx)            | 30+ typed events, logging, cleanup                     |

### Capabilities

| Page                                                            | What You'll Learn                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| [Overview](capabilities/overview.mdx)                           | Pure skills vs plugins, discovery, relevance scoring       |
| [SKILL.md Reference](capabilities/skill-md-reference.mdx)       | Complete frontmatter format, tool schemas, safety patterns |
| [Writing Plugins](capabilities/writing-plugins.mdx)             | Build capabilities with executable code                    |
| [Built-in Capabilities](capabilities/built-in-capabilities.mdx) | The 20+ capabilities that ship with wolffish               |

### Channels

| Page                              | What You'll Learn                                  |
| --------------------------------- | -------------------------------------------------- |
| [Overview](channels/overview.mdx) | Multi-channel architecture, TurnRunner, TurnRouter |
| [Telegram](channels/telegram.mdx) | Bot setup, inline buttons, HTML formatting         |
| [WhatsApp](channels/whatsapp.mdx) | Baileys integration, QR login, voice transcription |

### Integrations

| Page                                                  | What You'll Learn                           |
| ----------------------------------------------------- | ------------------------------------------- |
| [Overview](integrations/overview.mdx)                           | Stateless architecture, credential handling            |
| [Browser Extension](integrations/browser-extension.mdx)         | Control Chrome/Brave with 44 tools via WebSocket       |
| [Google Workspace](integrations/google-workspace.mdx)           | Gmail, Drive, Calendar, Sheets (OAuth)                 |
| [GitHub](integrations/github.mdx)                     | Repos, issues, PRs, workflows (PAT)         |
| [Notion](integrations/notion.mdx)                     | Pages, databases, search (API token)        |

### Memory & Learning

| Page                                      | What You'll Learn                                 |
| ----------------------------------------- | ------------------------------------------------- |
| [Overview](memory/overview.mdx)           | Three-tier memory system and context budget       |
| [Episodes](memory/episodes.mdx)           | Daily logs — instant, no-LLM append               |
| [Consolidation](memory/consolidation.mdx) | Nightly compaction into weekly summaries          |
| [Knowledge](memory/knowledge.mdx)         | Long-term facts and manual curation               |
| [Feedback Loop](memory/feedback-loop.mdx) | How wolffish learns from approvals and rejections |

### Configuration

| Page                                         | What You'll Learn                                  |
| -------------------------------------------- | -------------------------------------------------- |
| [soul.md](configuration/soul-md.mdx)         | Agent personality — tone, verbosity, guidelines    |
| [user.md](configuration/user-md.mdx)         | Your profile — name, role, stack, preferences      |
| [agents.md](configuration/agents-md.mdx)     | Operational procedures and tool rules              |
| [config.json](configuration/config-json.mdx) | App settings and provider configuration            |
| [Providers](configuration/providers.mdx)     | DeepSeek, Claude, OpenAI, Ollama setup and selection |
| [Variables](configuration/variables.mdx)     | Secrets and environment-style values               |
| [Heartbeat](configuration/heartbeat.mdx)     | Cron-like scheduling for autonomous jobs           |

### Debugging

| Page                                             | What You'll Learn                                       |
| ------------------------------------------------ | ------------------------------------------------------- |
| [Overview](debugging/overview.mdx)               | "If you can't debug it by reading markdown, it's a bug" |
| [Debug Snapshots](debugging/debug-snapshots.mdx) | Exact context sent to the LLM                           |
| [Event Logs](debugging/event-logs.mdx)           | Chronological system events                             |
| [Task Files](debugging/task-files.mdx)           | Tool execution with args, output, duration              |
| [Troubleshooting](debugging/troubleshooting.mdx) | Common issues and fixes                                 |

### Extending Wolffish

| Page                                                           | What You'll Learn                          |
| -------------------------------------------------------------- | ------------------------------------------ |
| [Creating Capabilities](extending/creating-capabilities.mdx)   | Step-by-step guide to building a new skill |
| [Advanced Plugins](extending/advanced-plugins.mdx)             | Complex logic, API calls, stateful plugins |
| [Adding Channels](extending/adding-channels.mdx)               | Build a new communication channel          |
| [Community Capabilities](extending/community-capabilities.mdx) | Share and discover community skills        |
| [Safety Patterns](extending/safety-patterns.mdx)               | Amygdala classification, confirm vs block  |

### Development

| Page                                                         | What You'll Learn                       |
| ------------------------------------------------------------ | --------------------------------------- |
| [Setup](development/setup.mdx)                               | Dev environment, commands, path aliases |
| [Project Structure](development/project-structure.mdx)       | Codebase layout and conventions         |
| [Contributing](development/contributing.mdx)                 | How to contribute to wolffish           |
| [Adding Brain Modules](development/adding-brain-modules.mdx) | Create new runtime modules              |

---

## Key Concepts

### Markdown Is Truth

Every piece of agent state — personality, memory, capabilities, configuration, debug output — lives in readable, editable markdown files. The TypeScript code is pure plumbing: it reads markdown, calls LLMs, executes tools, and writes markdown back. To change what the agent does, you edit markdown.

### The Brain Architecture

Wolffish maps human brain regions to 15 specialized software modules. Each handles exactly one function and communicates through a typed event bus (the corpus). The pipeline is deterministic — the LLM adds creativity at exactly one point. Everything else is predictable code.

### Three-Tier Memory

| Tier         | Speed                 | Source                   | Lifespan  |
| ------------ | --------------------- | ------------------------ | --------- |
| Episodes     | Instant (no LLM)      | Appended every turn      | Days      |
| Consolidated | Nightly (LLM-powered) | Compressed from episodes | Weeks     |
| Knowledge    | Manual or promoted    | Curated facts            | Permanent |

### Safety by Design

The amygdala module gates every tool call against patterns defined in SKILL.md frontmatter. No hard-coded guardrails — the safety system is as transparent and editable as everything else. Destructive operations require explicit approval; outcomes feed back into the learning system.

### Local-First, Cloud-Enhanced

Can work 100% offline with Ollama, or cloud-only with no local models — your choice. All providers (DeepSeek, Xiaomi MiMo, Kimi, MiniMax, Anthropic, OpenAI, Ollama) are optional; configure any combination. You explicitly select one **Brain** model — the one you choose is the one that runs. There's no automatic cascade or fallback between providers; to run offline, pick Ollama as your Brain. We recommend starting with DeepSeek or MiMo — they handle complex agentic tasks well at a fraction of the cost. Upgrade to Anthropic or OpenAI only if execution isn't reliable enough for a specific workflow.

---

## Structure

```
wolffish-docs/
├── introduction/          What wolffish is and why
├── getting-started/       Install, first launch, quickstart
├── architecture/          Brain modules, pipeline, event bus, workspace
├── capabilities/          Skills, plugins, built-in capabilities
├── channels/              Electron, Telegram, WhatsApp
├── integrations/          Google, GitHub, Notion, Brave
├── memory/                Episodes, consolidation, knowledge, feedback
├── configuration/         soul.md, user.md, agents.md, config.json, heartbeat
├── debugging/             Snapshots, event logs, task files
├── extending/             Create capabilities, plugins, channels, safety
├── development/           Setup, structure, contributing
├── ar/                    Full Arabic translation (parallel structure)
├── static/                Icons, favicon, CSS
└── docs.json              Navigation structure and site config
```

---

## Built With

- **[Fumadocs](https://fumadocs.vercel.app/)** — Next.js documentation framework
- **MDX** — Markdown with JSX components (CardGroup, Accordion, Tabs)
- **Bilingual** — Full English + Arabic with RTL support

---

## Contributing

Documentation improvements are always welcome. Each `.mdx` file is self-contained — edit it directly and submit a PR.

To add a new page:

1. Create the `.mdx` file in the appropriate section folder
2. Add an entry to `docs.json` under the correct tab and section
3. If bilingual, create the parallel page in `ar/`

---

## Releases

Every push to `main` cuts a versioned release automatically — see [`.github/workflows/release.yml`](.github/workflows/release.yml). The version lives in git tags only; nothing is ever committed back to `main`.

Write a short topic in the commit message, and add a marker when the change is bigger than a patch:

| Commit message                       | Result                          |
| ------------------------------------ | ------------------------------- |
| `update: fix broken install link`    | patch — `v1.0.3` → `v1.0.4`     |
| `add: skills page [minor]`           | minor — `v1.0.4` → `v1.1.0`     |
| `remove: use-cases section [major]`  | major — `v1.1.0` → `v2.0.0`     |
| `update: typo [skip release]`        | no release                      |

Each release publishes two archives:

- **`wolffish-docs-vX.Y.Z.zip`** — the docs bundle: every `.mdx` page, `docs.json`, `static/`, English + Arabic
- **Source code** (zip / tar.gz) — the full repository at that tag, attached by GitHub automatically

The commit subject becomes the release title (`v1.1.0 — add: skills page`), and the notes list every commit since the previous tag.

The first run seeds `v1.0.0`. Re-running the workflow on a commit that already carries a tag is a no-op, and you can cut a release by hand from the **Actions** tab with an explicit bump.

---

## Links

- **Live docs** — [docs.wolffi.sh](https://docs.wolffi.sh/)
- **App Store** — [Wolffish for iOS](https://apps.apple.com/us/app/wolffish/id6792797989)
- **Google Play** — [Wolffish for Android](https://play.google.com/store/apps/details?id=sh.wolffi.mobile)
- **App repo** — [wolffish-app](https://github.com/thewolffish)
- **Website** — [wolffi.sh](https://wolffi.sh)
- **Discord** — [Join](https://discord.gg/zWJpD3SgTt)
- **X** — [@younesbites](https://x.com/younesbites)
- **Reddit** — [u/younesbites](https://www.reddit.com/user/younesbites)

---

## License

MIT License — Copyright (c) 2026 [Younes Alturkey](mailto:younes@wolffi.sh)
