// PDF Design — a core capability whose single tool loads the document design
// manual into context. Model-led: the core contract instructs the agent to
// call `pdf_design` BEFORE authoring any PDF/report/styled document; this
// returns it. Mirrors the operating-manual body-load pattern.
//
// The manual text lives in ../manual.md (single source of truth, also
// readable via skill_read_source). We read it relative to this module's own
// URL so it resolves whether the skill runs from the repo default or the
// dot-prefixed runtime folder (~/.wolffish/.../.pdf-design/).

import { readFile } from 'node:fs/promises'

const MANUAL_URL = new URL('../manual.md', import.meta.url)

const toolDefinitions = [
  {
    name: 'pdf_design',
    description:
      'Load the full document design manual into context. Call this BEFORE writing the HTML for any PDF or styled document a person will read. Returns the complete design system to author by.',
    parameters: {
      type: 'object',
      properties: {
        document: {
          type: 'string',
          description: 'One line naming the document you are about to design.'
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
      error: `pdf_design: could not read manual.md (${err instanceof Error ? err.message : String(err)})`
    }
  }
}

const plugin = {
  name: 'pdf-design',
  tools: toolDefinitions,
  async execute(toolName) {
    if (toolName === 'pdf_design') return loadManual()
    return { success: false, error: `pdf-design: unknown tool ${toolName}` }
  }
}

export default plugin
