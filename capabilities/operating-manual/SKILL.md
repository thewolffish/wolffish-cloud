---
name: operating-manual
description: Your full working discipline for any real task. The operating_manual tool loads it — call that FIRST on anything complex, high-stakes, multi-step, or ambiguous, before any other tool.
triggers:
  - operating manual
  - working discipline
  - how to approach this
  - hard task
  - complex task
tools:
  - name: operating_manual
    description: Load your full working discipline (the operating manual) into context. Call this FIRST on any non-trivial task — debugging, analysis, research, writing/reviewing code, migrations, decisions, anything the user will act on — before memory_search or any other tool. Returns the discipline to work by. Skip only for genuinely trivial turns (greetings, one-line lookups, simple recall).
    parameters:
      task:
        type: string
        required: false
        description: One line naming the task you're about to do — stating it commits you to reading the manual before acting.
---

# Operating Manual

A core capability. Its one tool, `operating_manual`, returns your full working discipline: read the real request (goal vs. the literal ask), cut the problem into independently checkable pieces, spend effort where being wrong is silent and expensive, verify by re-deriving, label known vs. guessed, attack your own conclusion, lead with the answer — then run the five-question self-test before sending.

The discipline itself lives in `manual.md` beside this file; the plugin reads and returns it. The core contract (`agents.core.md`) tells you to call `operating_manual` before real work — this capability is what delivers it.
