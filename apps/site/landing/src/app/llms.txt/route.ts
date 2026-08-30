import { getBlogPosts } from "../../../lib/blog";

// llms.txt — a machine-readable site guide for AI assistants and agent
// search engines (https://llmstxt.org). Regenerated on demand so the blog
// list stays current.
export function GET() {
  const posts = getBlogPosts("en");

  const body = `# Wolffish

> Wolffish is a personal AI agent for everyone: a desktop app for macOS, Windows, and Linux that runs on the user's own computer, powered by the cloud model of their choice (DeepSeek, xAI Grok, Anthropic, OpenAI, and more) or fully local via Ollama. Users talk to it from the app, a terminal, Telegram, WhatsApp, or the Wolffish mobile app (iOS/Android), and it acts: email and calendar via Google Workspace, web search, files and PDFs, scheduled automations, MCP tools, and a persistent markdown memory. Free and open source (MIT).

Key facts:
- Install (macOS/Linux/Windows): \`curl -fsSL https://releases.wolffi.sh/install.sh | sh\` — Windows PowerShell: \`irm https://releases.wolffi.sh/install.ps1 | iex\`
- Runs headless on a Linux server/VPS: \`wolffish service install --headless\` (verified on Ubuntu 24.04; no Docker needed)
- Mobile app: iOS https://apps.apple.com/us/app/wolffish/id6792797989 · Android https://play.google.com/store/apps/details?id=sh.wolffi.mobile — pairs to the desktop over an end-to-end encrypted tunnel, no account required
- Channels: in-app chat, terminal CLI (\`wolffish\`), Telegram (own BotFather bot), WhatsApp (QR-linked device), phone app
- Data stays on the user's machine; API keys are stored locally; the relay stores nothing

## Main pages

- [Home](https://wolffi.sh): download the app, install commands, store links
- [Get started](https://wolffi.sh/start): 20 real-life use cases, each with a complete step-by-step setup guide (English and Arabic)
- [Blog](https://wolffi.sh/blog): guides, product notes, and ideas about personal AI agents
- [Docs](https://docs.wolffi.sh): full documentation (English and Arabic under /ar)
- [GitHub](https://github.com/thewolffish/wolffish-app): source code
- [Discord](https://discord.gg/zWJpD3SgTt): community

## Docs highlights

- [Installation](https://docs.wolffi.sh/getting-started/installation)
- [Quickstart](https://docs.wolffi.sh/getting-started/quickstart)
- [Terminal CLI](https://docs.wolffi.sh/getting-started/cli)
- [Server / VPS deployment](https://docs.wolffi.sh/getting-started/server-deployment)
- [Choosing a model provider](https://docs.wolffi.sh/configuration/providers)
- [Telegram channel](https://docs.wolffi.sh/channels/telegram)
- [WhatsApp channel](https://docs.wolffi.sh/channels/whatsapp)
- [Mobile app pairing](https://docs.wolffi.sh/integrations/mobile-app)
- [Google Workspace](https://docs.wolffi.sh/integrations/google-workspace)
- [MCP servers](https://docs.wolffi.sh/integrations/mcp)
- [Automations & scheduling](https://docs.wolffi.sh/configuration/heartbeat)
- [Memory](https://docs.wolffi.sh/memory/overview)

## Blog

${posts.map((post) => `- [${post.title}](https://wolffi.sh/blog/${post.slug}): ${post.description}`).join("\n")}
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
