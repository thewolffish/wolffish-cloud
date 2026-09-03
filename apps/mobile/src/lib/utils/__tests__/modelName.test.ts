import { shortModelName } from '@/lib/utils/modelName'

describe('shortModelName', () => {
  it('drops the provider prefix', () => {
    expect(shortModelName('deepseek-ai/DeepSeek-V3')).toBe('DeepSeek-V3')
    expect(shortModelName('anthropic/claude-opus-5')).toBe('claude-opus-5')
  })

  it('keeps an id that has no prefix', () => {
    expect(shortModelName('gpt-5')).toBe('gpt-5')
  })

  it('keeps only the last segment of a multi-segment id', () => {
    expect(shortModelName('openrouter/qwen/qwen3-max')).toBe('qwen3-max')
  })

  it('drops a trailing date stamp in either shape', () => {
    expect(shortModelName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(shortModelName('gpt-5.1-2026-04-11')).toBe('gpt-5.1')
  })

  it('drops a trailing latest/preview marker, case-insensitively', () => {
    expect(shortModelName('gemini-3-pro-latest')).toBe('gemini-3-pro')
    expect(shortModelName('o5-Preview')).toBe('o5')
  })

  it('leaves a version that merely looks datelike alone', () => {
    expect(shortModelName('qwen3-2507b')).toBe('qwen3-2507b')
  })

  it('survives an empty id', () => {
    expect(shortModelName('')).toBe('')
  })
})
