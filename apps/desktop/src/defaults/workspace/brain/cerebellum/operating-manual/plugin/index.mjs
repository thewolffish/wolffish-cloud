// Operating Manual — a core capability whose single tool loads the full
// working discipline into context. Model-led: the core contract instructs the
// agent to call `operating_manual` FIRST on any real task; this returns it.
//
// The discipline text lives in ../manual.md (single source of truth, also
// readable via skill_read_source). We read it relative to this module's own
// URL so it resolves whether the skill runs from the repo default or the
// dot-prefixed runtime folder (~/.wolffish/.../.operating-manual/).

import { readFile } from 'node:fs/promises'

const MANUAL_URL = new URL('../manual.md', import.meta.url)

const toolDefinitions = [
  {
    name: 'operating_manual',
    description:
      'Load your full working discipline (the operating manual) into context. Call this FIRST on any non-trivial task before any other tool. Returns the discipline to work by.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'One line naming the task you are about to do.'
        }
      }
    }
  }
]

async function loadManual() {
  try {
    const text = await readFile(MANUAL_URL, 'utf8')
    return { success: true, output: text }
  } catch (err) {
    return {
      success: false,
      error: `operating_manual: could not read manual.md (${err instanceof Error ? err.message : String(err)})`
    }
  }
}

const plugin = {
  name: 'operating-manual',
  tools: toolDefinitions,
  async execute(toolName) {
    if (toolName === 'operating_manual') return loadManual()
    return { success: false, error: `operating-manual: unknown tool ${toolName}` }
  }
}

export default plugin
