/**
 * The landing page served at `GET /` — the human-facing face of the master
 * API, in the same visual language as the relay's page. Fully static, zero
 * JavaScript; the "Online" status needs no script because if the API were
 * down this page would not have loaded.
 */
export function landingPage(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<meta name="theme-color" content="#040a18" />
<title>Wolffish Cloud: The Enterprise Agent, Cloud-First</title>
<meta name="description" content="Fully custom-tailored AI agent infrastructure — enterprise ready. Every employee runs the complete Wolffish agent on their own machine; the company owns the master record. Complete ZDR at the model provider, full visibility for admins, complete agentic capabilities for every employee." />
<link rel="icon" type="image/png" href="https://cdn.wolffi.sh/generic/icon.png" />
<link rel="apple-touch-icon" href="https://cdn.wolffi.sh/generic/icon.png" />
<meta property="og:title" content="Wolffish Cloud: The Enterprise Agent, Cloud-First" />
<meta property="og:description" content="Fully custom-tailored AI agent infrastructure — enterprise ready. Complete ZDR, full visibility, complete agentic capabilities for every employee." />
<meta property="og:url" content="https://api.wolffi.sh" />
<meta property="og:site_name" content="Wolffish" />
<meta property="og:image" content="https://cdn.wolffi.sh/generic/banner.jpg" />
<meta property="og:image:width" content="2540" />
<meta property="og:image:height" content="1520" />
<meta property="og:image:alt" content="Wolffish" />
<meta property="og:locale" content="en_US" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Wolffish Cloud: The Enterprise Agent, Cloud-First" />
<meta name="twitter:description" content="Fully custom-tailored AI agent infrastructure — enterprise ready. Complete ZDR, full visibility, complete agentic capabilities for every employee." />
<meta name="twitter:image" content="https://cdn.wolffi.sh/generic/banner.jpg" />
<style>
  :root {
    --bg: #0a0f1b;
    --glow: rgba(59, 102, 166, 0.16);
    --fg: #e8edf5;
    --muted: #93a1b8;
    --line: rgba(147, 161, 184, 0.18);
    --card: rgba(147, 161, 184, 0.06);
    --green: #34d399;
    --green-bg: rgba(52, 211, 153, 0.12);
    --blush: #f9a8c4;
    --blush-bg: rgba(249, 168, 196, 0.12);
    --blush-line: rgba(249, 168, 196, 0.35);
    --btn-bg: #ffffff;
    --btn-fg: #0a0f1b;
    --shadow: rgba(0, 0, 0, 0.55);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f9fc;
      --glow: rgba(59, 102, 166, 0.1);
      --fg: #141b26;
      --muted: #5a6b82;
      --line: rgba(20, 27, 38, 0.12);
      --card: rgba(20, 27, 38, 0.04);
      --green: #059669;
      --green-bg: rgba(5, 150, 105, 0.1);
      --blush: #db2777;
      --blush-bg: rgba(219, 39, 119, 0.08);
      --blush-line: rgba(219, 39, 119, 0.25);
      --btn-bg: #ffffff;
      --btn-fg: #141b26;
      --shadow: rgba(20, 27, 38, 0.18);
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    min-height: 100svh;
    display: grid;
    background: var(--bg);
    background-image: radial-gradient(600px 420px at 50% 10%, var(--glow), transparent 70%);
    color: var(--fg);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 3rem 1.25rem;
  }
  main { width: 100%; max-width: 33rem; margin: auto; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .logo {
    width: 88px; height: 88px; border-radius: 50%; object-fit: cover;
    box-shadow: 0 0 0 1px var(--line), 0 18px 48px -12px var(--shadow);
  }
  h1 { margin-top: 1.35rem; font-size: 1.7rem; font-weight: 650; letter-spacing: -0.02em; display: flex; align-items: center; gap: 0.55rem; }
  .tag {
    display: inline-flex; align-items: center;
    padding: 0.14rem 0.62rem; border-radius: 999px;
    font-size: 0.78rem; font-weight: 600; letter-spacing: 0.02em;
    color: var(--blush); background: var(--blush-bg);
    border: 1px solid var(--blush-line);
    transform: translateY(1px);
  }
  .tagline { margin-top: 0.45rem; color: var(--muted); font-size: 0.98rem; line-height: 1.5; }
  .meta { display: flex; gap: 0.5rem; margin-top: 1.15rem; }
  .pill {
    display: inline-flex; align-items: center; gap: 0.45rem;
    padding: 0.32rem 0.8rem; border-radius: 999px;
    font-size: 0.82rem; font-weight: 550;
    border: 1px solid var(--line); color: var(--muted); background: var(--card);
  }
  .pill.status { color: var(--green); border-color: transparent; background: var(--green-bg); }
  .dot { position: relative; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--green); }
  .dot::after {
    content: ''; position: absolute; inset: -4px; border-radius: 50%;
    border: 2px solid var(--green); animation: ping 2.4s ease-out infinite;
  }
  @keyframes ping {
    0% { transform: scale(0.35); opacity: 0.8; }
    70%, 100% { transform: scale(1.1); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) { .dot::after { animation: none; display: none; } }
  .endpoint {
    margin-top: 1.15rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.8rem; color: var(--muted);
    background: var(--card); border: 1px solid var(--line);
    border-radius: 8px; padding: 0.45rem 0.75rem;
    max-width: 100%; overflow-x: auto; white-space: nowrap;
  }
  .how {
    margin-top: 2.1rem; width: 100%; text-align: left;
    border: 1px solid var(--line); background: var(--card);
    border-radius: 16px; padding: 1.4rem 1.5rem;
  }
  .how h2 {
    font-size: 0.76rem; font-weight: 600; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 0.85rem;
  }
  .how p { font-size: 0.94rem; color: var(--muted); }
  .how p + p { margin-top: 0.85rem; }
  .how strong { color: var(--fg); font-weight: 600; }
  .how + .how { margin-top: 1rem; }
  .facts { list-style: none; margin: 0; padding: 0; }
  .facts li {
    display: flex; gap: 0.7rem; align-items: baseline;
    font-size: 0.91rem; color: var(--muted); padding: 0.4rem 0;
    border-bottom: 1px solid var(--line);
  }
  .facts li:last-child { border-bottom: 0; padding-bottom: 0; }
  .facts li:first-child { padding-top: 0; }
  .facts b { color: var(--fg); font-weight: 600; flex: 0 0 8.5rem; }
  .facts .no { color: var(--green); font-weight: 650; }
  @media (max-width: 30rem) {
    .facts li { flex-direction: column; gap: 0.1rem; }
    .facts b { flex: none; }
  }
  .gh {
    display: inline-flex; align-items: center; gap: 0.6rem;
    margin-top: 1.9rem; padding: 0.68rem 1.15rem; border-radius: 12px;
    background: var(--btn-bg); color: var(--btn-fg);
    text-decoration: none; font-weight: 600; font-size: 0.92rem;
    border: 1px solid var(--line);
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }
  .gh:hover { transform: translateY(-1px); box-shadow: 0 10px 30px -10px var(--shadow); }
  .gh img { width: 20px; height: 20px; display: block; }
  .person { display: flex; align-items: center; gap: 0.95rem; margin-bottom: 1rem; }
  .avatar {
    width: 72px; height: 72px; border-radius: 50%; object-fit: cover; flex: none;
    box-shadow: 0 0 0 1px var(--line), 0 12px 32px -12px var(--shadow);
  }
  .person strong { display: block; color: var(--fg); font-size: 1.05rem; font-weight: 650; line-height: 1.3; }
  .person span { color: var(--muted); font-size: 0.88rem; }
  .facts a { color: var(--fg); text-decoration: none; border-bottom: 1px solid var(--line); padding-bottom: 1px; }
  .facts a:hover { border-bottom-color: currentColor; }
  .cta {
    width: 100%; justify-content: center; margin-top: 1.15rem;
  }
  footer { margin-top: 2.2rem; font-size: 0.82rem; color: var(--muted); }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <img class="logo" src="https://cdn.wolffi.sh/generic/icon.png" alt="Wolffish" width="88" height="88" />
  <h1>Wolffish <span class="tag">Cloud</span></h1>
  <p class="tagline">Every employee runs the full Wolffish agent on their own computer.<br />Their company runs the cloud behind it — the models, the record, the rules.</p>
  <div class="meta">
    <span class="pill status"><span class="dot"></span>Online</span>
    <span class="pill">api v${version}</span>
  </div>
  <code class="endpoint">https://api.wolffi.sh/ai/v1/chat/completions</code>
  <section class="how">
    <h2>How it works</h2>
    <p><strong>Contract.</strong> You engage the Wolffish team. We take the complete Wolffish agent and tailor it to your company — your internal tools, your services, your way of working.</p>
    <p><strong>Deploy.</strong> Your build ships on your own private infrastructure: your cloud account, your services, your model keys. Nothing of yours runs on ours.</p>
    <p><strong>Release.</strong> Every employee gets the agent on their own machine, and your admins get full visibility and debuggability over the whole fleet from day one.</p>
    <p><strong>Grow.</strong> We keep improving your agent platform on a retainer and grow with you — per-seat pricing, zero upfront cost.</p>
  </section>
  <section class="how">
    <h2>What it is</h2>
    <ul class="facts">
      <li><b>Custom-tailored</b><span>Every company gets its own fork — own domain, own keys, own models, own branding. Infrastructure that fits like it was written for you, because it was.</span></li>
      <li><b>Enterprise ready</b><span>Invite-only onboarding, owner/admin/support/employee roles, instant session revoke, and an audit trail under every admin action.</span></li>
      <li><b>Complete ZDR</b><span>Zero data retention on the model lane: prompts and outputs are never logged here and never retained by the provider. The org keeps its work; nobody keeps the requests.</span></li>
      <li><b>Full visibility</b><span>Who ran what model, tokens, cost, latency, allowed or denied — attributed per employee, live. Metadata always, content never.</span></li>
      <li><b>Fully agentic</b><span>Not a chat window: the complete 15-region Wolffish agent — skills, memory, files, real work on a real machine — for every employee on the payroll.</span></li>
    </ul>
  </section>
  <section class="how">
    <h2>What the master holds</h2>
    <ul class="facts">
      <li><b>The record</b><span>Configs, conversations, memory episodes, files — the org's own data, synced after execution, restored on any sign-in.</span></li>
      <li><b>The rules</b><span>Model allowlists, token budgets, roles — enforced at this door on every single request.</span></li>
      <li><b>The meter</b><span>Per-request usage with real provider cost, per employee, per model.</span></li>
      <li><b>Prompt content</b><span class="no">never</span></li>
      <li><b>Provider keys on devices</b><span class="no">never</span></li>
    </ul>
  </section>
  <section class="how">
    <h2>Contact</h2>
    <div class="person">
      <img class="avatar" src="https://cdn.wolffi.sh/generic/younes-official.jpeg" alt="Younes Alturkey" width="72" height="72" />
      <div>
        <strong>Younes Alturkey</strong>
        <span>Founder &amp; Engineer</span>
      </div>
    </div>
    <ul class="facts">
      <li><b>Email</b><a href="mailto:younes@wolffi.sh">younes@wolffi.sh</a></li>
      <li><b>Phone</b><a href="tel:+966538654514">+966&nbsp;53&nbsp;865&nbsp;4514</a></li>
    </ul>
    <a class="gh cta" href="mailto:younes@wolffi.sh?subject=Wolffish%20Cloud">Contact Younes</a>
  </section>
  <a class="gh" href="https://github.com/thewolffish/wolffish-cloud">
    <img src="https://cdn.wolffi.sh/generic/github.png" alt="" width="20" height="20" />
    <span>thewolffish/wolffish-cloud</span>
  </a>
  <footer>MIT · <a href="https://wolffi.sh">wolffi.sh</a></footer>
</main>
</body>
</html>
`
}
