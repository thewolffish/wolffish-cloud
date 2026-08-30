// Structural config for the /start use-case guides. All user-facing text lives
// in messages/{en,ar}.json under the "start" namespace; this file only defines
// the 20 cases, their icons/channels, how shared setup steps compose with each
// case's own steps, and which docs page each guide deep-links to.

export type StartChannel = "telegram" | "whatsapp" | "mobile" | "cli" | "app";

export interface StartCaseConfig {
  id: string;
  icon: string;
  channel: StartChannel;
  /** Shared step keys (from messages start.shared) prepended before the case's own steps. */
  pre: string[];
  /** Shared step keys appended after the case's own steps. */
  post: string[];
  /** Docs path deep-linked from the guide footer (prefixed with /ar for Arabic). */
  docs: string;
}

// Shared step keys: install, key (DeepSeek V4 Pro), keyVision (Grok 4.6),
// brave (search key), workspace (Google), telegram, whatsapp, mobile (phone app).
export const START_CASES: StartCaseConfig[] = [
  {
    id: "morning-briefing",
    icon: "mug",
    channel: "telegram",
    pre: ["install", "key", "workspace", "brave", "telegram"],
    post: ["mobile"],
    docs: "/configuration/heartbeat",
  },
  {
    id: "email",
    icon: "envelope",
    channel: "telegram",
    pre: ["install", "key", "workspace", "telegram"],
    post: ["mobile"],
    docs: "/integrations/google-workspace",
  },
  {
    id: "calendar",
    icon: "calendar",
    channel: "whatsapp",
    pre: ["install", "key", "workspace", "whatsapp"],
    post: ["mobile"],
    docs: "/integrations/google-workspace",
  },
  {
    id: "reminders",
    icon: "bell",
    channel: "whatsapp",
    pre: ["install", "key", "whatsapp"],
    post: ["mobile"],
    docs: "/configuration/heartbeat",
  },
  {
    id: "news",
    icon: "newspaper",
    channel: "telegram",
    pre: ["install", "key", "brave", "telegram"],
    post: ["mobile"],
    docs: "/configuration/heartbeat",
  },
  {
    id: "social",
    icon: "hashtag",
    channel: "telegram",
    pre: ["install", "key", "brave", "telegram"],
    post: ["mobile"],
    docs: "/configuration/what-to-schedule",
  },
  {
    id: "research",
    icon: "search",
    channel: "telegram",
    pre: ["install", "key", "brave", "telegram"],
    post: ["mobile"],
    docs: "/capabilities/built-in-capabilities",
  },
  {
    id: "pdf",
    icon: "pdf",
    channel: "telegram",
    pre: ["install", "key", "telegram"],
    post: ["mobile"],
    docs: "/capabilities/built-in-capabilities",
  },
  {
    id: "receipts",
    icon: "chart",
    channel: "whatsapp",
    pre: ["install", "keyVision", "whatsapp"],
    post: ["mobile"],
    docs: "/configuration/xai",
  },
  {
    id: "memes",
    icon: "laugh",
    channel: "telegram",
    pre: ["install", "key", "telegram"],
    post: ["mobile"],
    docs: "/capabilities/built-in-capabilities",
  },
  {
    id: "travel",
    icon: "plane",
    channel: "telegram",
    pre: ["install", "key", "brave", "telegram"],
    post: ["mobile"],
    docs: "/configuration/heartbeat",
  },
  {
    id: "price-watch",
    icon: "tag",
    channel: "telegram",
    pre: ["install", "key", "telegram"],
    post: ["mobile"],
    docs: "/configuration/what-to-schedule",
  },
  {
    id: "meals",
    icon: "meal",
    channel: "whatsapp",
    pre: ["install", "key", "whatsapp"],
    post: ["mobile"],
    docs: "/memory/overview",
  },
  {
    id: "habits",
    icon: "dumbbell",
    channel: "whatsapp",
    pre: ["install", "key", "whatsapp"],
    post: ["mobile"],
    docs: "/configuration/heartbeat",
  },
  {
    id: "family",
    icon: "users",
    channel: "telegram",
    pre: ["install", "key", "workspace", "telegram"],
    post: ["mobile"],
    docs: "/channels/telegram",
  },
  {
    id: "vault",
    icon: "archive",
    channel: "whatsapp",
    pre: ["install", "keyVision", "whatsapp"],
    post: ["mobile"],
    docs: "/capabilities/built-in-capabilities",
  },
  {
    id: "tidy",
    icon: "mobile",
    channel: "mobile",
    pre: ["install", "key", "mobile"],
    post: [],
    docs: "/integrations/mobile-app",
  },
  {
    id: "mcp",
    icon: "plug",
    channel: "app",
    pre: ["install", "key"],
    post: ["mobile"],
    docs: "/integrations/mcp",
  },
  {
    id: "cli",
    icon: "terminal",
    channel: "cli",
    pre: ["install", "key"],
    post: ["mobile"],
    docs: "/getting-started/cli",
  },
  {
    id: "vps",
    icon: "server",
    channel: "cli",
    pre: [],
    post: [],
    docs: "/getting-started/server-deployment",
  },
];
