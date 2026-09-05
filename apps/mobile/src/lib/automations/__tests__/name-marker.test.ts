import { parseAutomations, writeDraft } from '@/lib/automations/heartbeat'

describe('automation name marker', () => {
  it('writes a name and reads it back, with the heading still the identity', () => {
    const { markdown } = writeDraft('', null, {
      schedule: 'Daily (07:00)',
      name: 'Morning digest',
      prompt: 'Summarise my inbox.',
      icon: '⏰',
      projectId: ''
    })
    const [block] = parseAutomations(markdown)
    expect(block.label).toBe('Daily (07:00)')
    expect(block.name).toBe('Morning digest')
    expect(block.icon).toBe('⏰')
    expect(block.body).toBe('Summarise my inbox.')
  })

  it('survives repeated saves without duplicating the marker', () => {
    let markdown = ''
    let bound: { label: string; active: boolean } | null = null
    for (let i = 0; i < 3; i++) {
      const r = writeDraft(markdown, bound, {
        schedule: 'Daily (07:00)',
        name: 'Morning digest',
        prompt: 'Summarise my inbox.',
        icon: '⏰',
        projectId: ''
      })
      markdown = r.markdown
      bound = r.bound
    }
    expect(markdown.match(/^name: /gm)).toHaveLength(1)
    expect(parseAutomations(markdown)[0].name).toBe('Morning digest')
  })

  it('leaves a block written before names existed alone', () => {
    const legacy = '## Weekly (Monday 09:30)\n\nicon: 🧭\n\nOld job.\n'
    const [block] = parseAutomations(legacy)
    expect(block.name).toBeNull()
    expect(block.body).toBe('Old job.')
  })
})
