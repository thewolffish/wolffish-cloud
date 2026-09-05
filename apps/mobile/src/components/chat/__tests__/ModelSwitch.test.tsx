jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The model row in the cloud edition: one lane through the organization's
 * API, and this device picks which of that org's models answers. Pinned here:
 *
 * - every model the snapshot's catalog carries gets a chip, in the API's own
 *   order, with the selected one marked — the row IS the catalog;
 * - a tap writes `brainModel`, the one key the desktop accepts for this, so a
 *   pick here is the same act as a pick in the desktop's own picker;
 * - tapping the model already selected writes nothing (no pointless round trip
 *   and no snapshot churn);
 * - a selected model the catalog does not list still gets a chip — a policy
 *   change mid-session must not leave the row with nothing lit and no way to
 *   see what is answering;
 * - no catalog at all (an older desktop, a pre-catalog demo bundle, a cold
 *   cache) falls back to that single chip rather than an empty row;
 * - the cloud desktop stamps `brainProvider: 'cloud'` (or nothing at all), and
 *   both render — no "?" box, no crash on an id the vendor map lacks.
 */

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

import { ModelSwitch } from '@/components/chat/ModelSwitch'
import { setConfigValue, useDemoConfig, type ModelCatalogEntry } from '@/state/demoConfig'
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import '@/lib/i18n'

jest.mock('@/state/demoConfig', () => {
  const actual = jest.requireActual('@/state/demoConfig')
  return { ...actual, setConfigValue: jest.fn(actual.setConfigValue) }
})

const setValue = setConfigValue as jest.MockedFunction<typeof setConfigValue>

const model = (over: Partial<ModelCatalogEntry> & { id: string }): ModelCatalogEntry => ({
  name: over.id,
  reasoning: false,
  vision: false,
  contextWindow: 0,
  default: false,
  ...over
})

const CATALOG: ModelCatalogEntry[] = [
  model({
    id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    name: 'DeepSeek V4 Flash',
    reasoning: true,
    contextWindow: 1_048_576,
    default: true
  }),
  model({ id: 'deepseek-ai/DeepSeek-V4-Pro-0813', name: 'DeepSeek V4 Pro', reasoning: true }),
  model({
    id: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
    name: 'DeepSeek V4 Flash Vision',
    reasoning: true,
    vision: true
  })
]

afterEach(() => {
  cleanup()
  setValue.mockClear()
})

describe('ModelSwitch (org lane)', () => {
  it('gives every catalog model a chip, with the selected one marked', async () => {
    useDemoConfig.setState({
      brainProvider: 'cloud',
      brainModel: 'deepseek-ai/DeepSeek-V4-Pro-0813',
      modelCatalog: CATALOG
    })
    await render(<ModelSwitch />)

    const chips = screen.getAllByRole('tab')
    expect(chips).toHaveLength(3)
    expect(chips.map((chip) => chip.props.accessibilityLabel)).toEqual([
      'DeepSeek V4 Flash',
      'DeepSeek V4 Pro',
      'DeepSeek V4 Flash Vision'
    ])
    expect(chips[1].props.accessibilityState.selected).toBe(true)
    expect(chips[0].props.accessibilityState.selected).toBe(false)
  })

  it('writes brainModel when another model is picked', async () => {
    useDemoConfig.setState({
      brainProvider: 'cloud',
      brainModel: 'deepseek-ai/DeepSeek-V4-Pro-0813',
      modelCatalog: CATALOG
    })
    await render(<ModelSwitch />)

    fireEvent.press(screen.getByLabelText('DeepSeek V4 Flash Vision'))
    expect(setValue).toHaveBeenCalledWith('brainModel', 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp')
  })

  it('writes nothing when the selected model is tapped again', async () => {
    useDemoConfig.setState({
      brainProvider: 'cloud',
      brainModel: 'deepseek-ai/DeepSeek-V4-Pro-0813',
      modelCatalog: CATALOG
    })
    await render(<ModelSwitch />)

    fireEvent.press(screen.getByLabelText('DeepSeek V4 Pro'))
    expect(setValue).not.toHaveBeenCalled()
  })

  it('shows the specs of the selected model', async () => {
    useDemoConfig.setState({
      brainProvider: 'cloud',
      brainModel: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      modelCatalog: CATALOG
    })
    await render(<ModelSwitch />)

    expect(screen.getByText('deepseek-ai/DeepSeek-V4-Flash-0731 · 1m ctx · reasoning')).toBeTruthy()
  })

  it('keeps a chip for a selected model the catalog no longer lists', async () => {
    useDemoConfig.setState({
      brainProvider: 'cloud',
      brainModel: 'deepseek-ai/DeepSeek-V4-Withdrawn',
      modelCatalog: CATALOG
    })
    await render(<ModelSwitch />)

    const chips = screen.getAllByRole('tab')
    expect(chips).toHaveLength(4)
    expect(chips[3].props.accessibilityState.selected).toBe(true)
    expect(screen.getByLabelText('DeepSeek-V4-Withdrawn')).toBeTruthy()
  })

  it('falls back to the current model when no catalog has arrived', async () => {
    useDemoConfig.setState({ brainProvider: 'cloud', brainModel: 'qwen3-235b', modelCatalog: [] })
    await render(<ModelSwitch />)

    const chips = screen.getAllByRole('tab')
    expect(chips).toHaveLength(1)
    expect(screen.getByLabelText('qwen3-235b')).toBeTruthy()
  })

  it('says "No model" when the store holds none and the catalog is empty', async () => {
    useDemoConfig.setState({ brainProvider: '', brainModel: '', modelCatalog: [] })
    await render(<ModelSwitch />)

    expect(screen.getByText('No model')).toBeTruthy()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })
})
