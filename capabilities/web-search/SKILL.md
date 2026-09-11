---
name: web-search
description: Search the web and read web pages for current information, documentation, news, and research
triggers:
  - search
  - google
  - look up
  - find online
  - web
  - browse
  - website
  - url
  - link
  - news
  - latest
  - current
  - today
  - recent
  - article
  - documentation
  - docs
  - what is
  - who is
  - how to
  - fetch
  - page
  - site
  - research
  - information
  - learn about
  - tell me about
  - explain
  - find out
  - look into
  - check online
  - weather
  - price
  - stock
  - score
  - result
  - update
  - trending
  - wiki
  - wikipedia
  - tutorial
  - guide
  - reference
  - manual
  - blog
  - forum
  - stackoverflow
  - api docs
  - reddit
  - quora
  - medium
  - github pages
  - npm package
  - pypi
  - crate
  - library
  - framework
  - changelog
  - release notes
  - announcement
  - event
  - conference
  - compare
  - versus
  - vs
  - best practices
  - alternatives
  - reviews
  - ratings
  - benchmark
  - definition
  - meaning
  - translate
  - convert
  - calculate
  - recipe
  - address
  - directions
  - map
  - location
  - what happened
  - when did
  - where is
  - why does
  - can you find
  - search for
  - google it
  - look this up
requires:
  - node
tools:
  - name: web_search
    readOnly: true
    description: Search the web through your organization's search lane. Returns titles, snippets and URLs — never a page. Fast, and each query is metered against the user's organization allowance, so use it to settle one fact or to find which URL to open. To actually read or work with a site, prefer the browser-extension capability. There is no other search provider — when the lane is unavailable the tool says so, and you relay that instead of retrying.
    parameters:
      query:
        type: string
        description: The search query
      maxResults:
        type: number
        required: false
        description: Maximum number of results to return (default 5, max 10)
  - name: web_fetch
    readOnly: true
    description: One plain HTTP GET of a URL, returned as text. Instant and free, but it sees only what the server sends — JS-rendered pages come back empty, and paywalls, logins, consent walls and bot checks defeat it. When that happens, or when the page needs a click or scroll, switch to the browser-extension capability rather than retrying.
    parameters:
      url:
        type: string
        description: The URL of the web page to fetch
      maxLength:
        type: number
        required: false
        description: Maximum characters to return (default 15000)
      timeout:
        type: number
        required: false
        description: Seconds to wait before giving up on a slow or unresponsive page. Omit to wait indefinitely (no timeout).
danger_patterns:
  - pattern: 'web_fetch.*127\.0\.0\.1'
    level: block
    reason: SSRF — localhost access blocked
  - pattern: 'web_fetch.*localhost'
    level: block
    reason: SSRF — localhost access blocked
  - pattern: 'web_fetch.*192\.168\.'
    level: block
    reason: SSRF — private network access blocked
  - pattern: 'web_fetch.*10\.0\.'
    level: block
    reason: SSRF — private network access blocked
  - pattern: 'web_fetch.*172\.(1[6-9]|2[0-9]|3[01])\.'
    level: block
    reason: SSRF — private network access blocked
  - pattern: 'web_fetch.*file://'
    level: block
    reason: SSRF — local file access blocked
  - pattern: 'web_fetch.*\.local'
    level: block
    reason: SSRF — local network access blocked
confirm_patterns:
  - pattern: 'web_fetch.*\.(exe|msi|dmg|pkg|deb|rpm|sh|bat|ps1)$'
    reason: Fetching executable/installer content
---

# Web Search

## Tools

- `web_search` — search the web, returns titles + snippets + URLs
- `web_fetch` — fetch and read full page content from a URL

Every `web_search` goes through the organization's search lane (`POST /v1/search` with this
device's session) and is metered against the user's allowance. There is no other search provider on
this device and the tool never scrapes a public search engine: when the lane is closed, the search
does not happen. `web_fetch` is different — a plain GET of a URL you already have is not a search
provider, and it stays available.

## Search is one of three routes — pick deliberately

These two tools are not the only way to reach the web, and often not the best one. The third is the **browser extension** (`tool_activate("browser-extension")`), which drives the user's real browser.

| | reaches | costs |
|---|---|---|
| `web_search` | an index — snippets, never a page | metered against the organization's allowance; very fast |
| `web_fetch` | whatever a server returns to a bare GET | free, instant; blind to JS, paywalls, logins, bot checks |
| browser extension | essentially any page the user can open, and can click/scroll/fill | more tokens, more seconds; needs a connected browser |

**Lean toward the browser** whenever the task names a specific site, needs a logged-in or paid-for page, needs interaction, spans more than a page or two, or when a fetch came back thin. Two failed fetches cost more than opening the browser would have. Nothing here is a rule — weigh it yourself; these are the trade-offs to weigh.

## When to use web_search

Use `web_search` when the user:
- Asks about current events, recent news, or anything time-sensitive
- Needs documentation or reference material
- Asks "what is X", "who is X", or "how to do X" and you aren't confident in your answer
- Wants to look something up, find a link, or research a topic
- Asks about something you don't have reliable knowledge about
- Needs live data (prices, weather, scores, stock info)

## When to use web_fetch

Use `web_fetch` after `web_search` when:
- The snippets from search results aren't enough to fully answer the question
- You need to read an article, documentation page, or reference in detail
- The user explicitly asks you to read or visit a specific URL

Fetch the most relevant 1–2 URLs, not all of them. Never fetch more than 3 pages in one conversation turn.

**Read what comes back before trusting it.** A page that returns a few hundred characters, a cookie banner, "enable JavaScript", a login form, or a subscribe wall did not actually load — it just failed quietly with a 200. Don't re-fetch it and don't answer from the fragment: that page is a job for the browser extension, which renders it as the user's own browser would. The same goes for any site you already know is JS-rendered or gated.

## When NOT to search

Do not search when the user is:
- Asking you to perform a local task (run a command, edit a file, create something)
- Having casual conversation or asking for opinions
- Asking about something you already know well and confidently
- Asking about their local files, system, or workspace

## How to search effectively

- Use specific queries: "Python asyncio tutorial" not "how to do async stuff"
- Include relevant keywords and terms
- If the first search doesn't answer the question, refine the query and search again
- Don't guess — search and verify

## How to present results

- Synthesize information into a natural answer — don't dump raw search results
- Cite sources when presenting factual claims
- If multiple sources disagree, mention the disagreement
- Include relevant URLs so the user can read more

## When the organization lane refuses or is unavailable

`web_search` never falls back to another provider. Read the error and relay it:

- **Allowance used up** (`Web search is paused: …`) — the organization's decision. Tell the user in
  one sentence which allowance is exhausted and who can raise it (the message says), then answer
  from what you know. Do not retry.
- **Lane busy** — the tool already waited and retried once; try the query once more after the delay
  it names, then stop.
- **Unavailable** (`Web search is provided by your organization and is currently unavailable:
  <code>`) — switched off, not set up, no session on this device, upstream down, or offline. Tell
  the user: "Web search is provided by your organization and is currently unavailable (<code>)";
  then answer from your existing knowledge, or read a specific page with `web_fetch` or the browser
  extension. Do not retry the same query, and never try to reach a search engine another way.
