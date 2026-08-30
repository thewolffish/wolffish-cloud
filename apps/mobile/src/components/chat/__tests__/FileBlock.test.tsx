/**
 * End-to-end render test for delivered/attached files: one case per file type
 * the desktop app supports, driven through the real FileBlock dispatch, the
 * real viewers and a faked workspace cache. A regression here means a file the
 * desktop renders would land in the mobile feed as a dead card.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

/** relPath → body. Anything absent from this map is a missing file. */
const FILES: Record<string, string> = {
  'files/shot.png': 'binary-png',
  'files/clip.mp4': 'binary-mp4',
  'voice/reply.mp3': 'binary-mp3',
  'files/report.pdf': '%PDF-1.4 binary',
  'files/page.html': '<html><body><h1>Report</h1></body></html>',
  'files/README.md': '# Title\n\nSome **bold** prose.',
  'files/notes.txt': 'plain line one\nplain line two',
  'files/app.ts': 'export const answer = 42\n',
  'files/data.csv': 'name,qty\nwidget,7\ngizmo,3',
  'files/logo.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>',
  'files/book.xlsx': 'binary-xlsx',
  'files/letter.docx': 'binary-docx',
  'files/archive.zip': 'binary-zip',
  // A raw literal (not JSON.stringify): jest.mock factories may only
  // reference this map while its initializer is entirely call-free.
  'files/q3-revenue.chart.json':
    '{"type":"column","title":"Q3 revenue","subtitle":"by product line",' +
    '"footnote":"Source: finance close","categories":["Jul","Aug","Sep"],' +
    '"series":[{"name":"Hardware","data":[12,14,17]}]}',
  'files/broken.chart.json': 'not a chart spec',
  // Listed in CACHED below — the already-materialized case.
  'files/cached.ts': 'export const cached = true\n'
}

/**
 * Paths whose bytes are already materialized in the fake cache — the state
 * every file reaches after its first view, and the one that must render with
 * no fetch and no placeholder. Everything else takes the download path.
 * A literal, like FILES: jest hoists the factories above both.
 */
const CACHED: string[] = ['files/cached.ts']

jest.mock('@/lib/files/fileCache', () => ({
  statCachedFile: jest.fn((relPath: string) =>
    CACHED.includes(relPath) && relPath in FILES
      ? { uri: `file:///cache/${relPath}`, sizeBytes: FILES[relPath].length }
      : null
  ),
  resolveWorkspaceFile: jest.fn(async (relPath: string) => {
    // Authoritative absence — the source answered "not here". Transient
    // failures never say missing; they retry (see useFileRetry).
    if (!(relPath in FILES)) return { uri: null, missing: true }
    // Fetched once, cached from then on — what makes the second view sync.
    if (!CACHED.includes(relPath)) CACHED.push(relPath)
    return { uri: `file:///cache/${relPath}`, missing: false }
  })
}))

jest.mock('expo-file-system', () => ({
  File: class {
    uri: string
    constructor(uri: string) {
      this.uri = uri
    }
    get exists(): boolean {
      return this.uri.replace('file:///cache/', '') in FILES
    }
    get size(): number {
      return this.body().length
    }
    private body(): string {
      return FILES[this.uri.replace('file:///cache/', '')] ?? ''
    }
    textSync(): string {
      return this.body()
    }
    async text(): Promise<string> {
      return this.body()
    }
  }
}))

jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native')
  return { Image: (props: object) => <View testID="image" {...props} /> }
})

// Reanimated's worklets runtime needs the native binary; here it carries only
// the expanded image's zoom transform, which starts at rest and stays there
// without fingers on the glass. The geometry behind it is checked on its own
// in lib/utils/__tests__/zoomPan.test.ts.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  return {
    __esModule: true,
    // createAnimatedComponent is gesture-handler's, not ours: it wraps the
    // detector's child at import time, so the mock has to answer for it.
    default: { View, createAnimatedComponent: (component: unknown) => component },
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (style: () => object) => style(),
    // Also gesture-handler's: the detector subscribes to its own event stream
    // through Reanimated, and there is no stream to subscribe to here.
    useEvent: () => () => undefined,
    withTiming: (value: number) => value,
    withDecay: () => 0
  }
})

// The chart host document is composed from bundled assets (ECharts, the page
// runtime, the Plex face) — none of which exist in this faked filesystem.
jest.mock('@/lib/charts/html', () => ({
  ensureChartHostDocument: jest.fn(async () => ({
    uri: 'file:///cache/chart-host/host.html',
    directory: 'file:///cache/chart-host/'
  }))
}))

// Same reason as the chart host, and one more: the module pulls in the whole
// vendored pdf.js build, which boots a Node fallback path the moment it is
// required. Nothing here needs the real composer — the PDF card is checked on
// which document it points the frame at, not on how the page was written.
jest.mock('@/lib/pdf/html', () => ({
  PDF_MAX_INLINE_BYTES: 10 * 1024 * 1024,
  ensurePdfHostDocument: jest.fn(async () => ({
    uri: 'file:///cache/pdf-host/host.html',
    directory: 'file:///cache/pdf-host/'
  }))
}))

jest.mock('react-native-webview', () => {
  const { View } = jest.requireActual('react-native')
  return { WebView: (props: object) => <View testID="webview" {...props} /> }
})

jest.mock('expo-video', () => {
  const { View } = jest.requireActual('react-native')
  return {
    // Includes the listener surface `useEvent(player, 'statusChange')` needs.
    useVideoPlayer: () => ({
      loop: false,
      status: 'readyToPlay',
      // Deliberately not 16/9 — proves the card takes its shape from the track
      // rather than from the placeholder aspect.
      videoTrack: { size: { width: 640, height: 480 } },
      play: jest.fn(),
      pause: jest.fn(),
      addListener: jest.fn(() => ({ remove: jest.fn() })),
      removeListener: jest.fn()
    }),
    VideoView: (props: object) => <View testID="video" {...props} />
  }
})

jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn(), seekTo: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, duration: 12, currentTime: 0 })
}))

jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }))
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => undefined) }))

import '@/lib/i18n'
import { FileBlock } from '@/components/chat/FileBlock'
import { resolveWorkspaceFile } from '@/lib/files/fileCache'
import { ensurePdfHostDocument } from '@/lib/pdf/html'
import * as Sharing from 'expo-sharing'
import { Platform } from 'react-native'

const SAFE_AREA = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 }
}

// `render` and `fireEvent` are async in RNTL 14: they resolve their own
// `act()` before the render result is published to `screen`. Every call site
// must await, or the queries below race the mount.
async function renderBlock(element: ReactElement): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA}>
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        {element}
      </ThemeContext.Provider>
    </SafeAreaProvider>
  )
}

describe('FileBlock — one delivered file per supported type', () => {
  it('renders an image as a tappable thumbnail that expands full screen', async () => {
    await renderBlock(<FileBlock relPath="files/shot.png" declared="image" />)
    await waitFor(() => expect(screen.getByTestId('image')).toBeTruthy())

    await fireEvent.press(screen.getByLabelText('shot.png'))
    // Thumbnail + the expanded sheet's full-bleed copy.
    await waitFor(() => expect(screen.getAllByTestId('image').length).toBeGreaterThan(1))
    expect(screen.getByText('shot.png')).toBeTruthy()
  })

  it('sizes the image by its own ratio once it reports in — nothing cropped', async () => {
    await renderBlock(<FileBlock relPath="files/shot.png" declared="image" />)
    const thumb = await waitFor(() => screen.getByTestId('image'))
    // Placeholder footprint until the decoder reports the natural size.
    expect(thumb.props.style).toMatchObject({ width: 260, height: 200 })

    // A tall screenshot: 750x1800. The old fixed box would crop it.
    await fireEvent(thumb, 'load', { source: { width: 750, height: 1800 } })
    const style = screen.getByTestId('image').props.style
    expect(style).toMatchObject({ width: 260, aspectRatio: 750 / 1800 })
    expect(style.height).toBeUndefined()
    expect(style.maxHeight).toBeUndefined()
  })

  it('renders a video in the native player', async () => {
    await renderBlock(<FileBlock relPath="files/clip.mp4" declared="video" />)
    await waitFor(() => expect(screen.getByTestId('video')).toBeTruthy())
    expect(screen.getByText('clip.mp4')).toBeTruthy()
  })

  it('sizes the video by its own aspect ratio, not a fixed height', async () => {
    await renderBlock(<FileBlock relPath="files/clip.mp4" declared="video" />)
    const style = await waitFor(() => screen.getByTestId('video').props.style)
    // 640x480 track -> 4/3, width-constrained, height left to the ratio.
    expect(style).toMatchObject({ width: '100%', aspectRatio: 4 / 3 })
    expect(style.height).toBeUndefined()
    // No viewport cap either: a portrait clip renders whole, like images.
    expect(style.maxHeight).toBeUndefined()
  })

  it('renders audio as a transport with a play control', async () => {
    await renderBlock(<FileBlock relPath="voice/reply.mp3" declared="audio" />)
    await waitFor(() => expect(screen.getByText('reply.mp3')).toBeTruthy())
    expect(screen.getByText('0:00 / 0:12')).toBeTruthy()

    // Audio carries the same export affordance as video.
    await fireEvent.press(screen.getByLabelText('Share'))
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/voice/reply.mp3')
  })

  it('renders a PDF preview that expands (iOS)', async () => {
    await renderBlock(<FileBlock relPath="files/report.pdf" declared="document" />)
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())
    expect(screen.getByText('report.pdf')).toBeTruthy()

    await fireEvent.press(screen.getByLabelText('Expand'))
    // The sheet takes over the single document renderer; its close control is
    // the proof it is up.
    await waitFor(() => expect(screen.getByLabelText('Close')).toBeTruthy())
    expect(screen.getByTestId('webview')).toBeTruthy()
  })

  /**
   * Android has no PDF engine in its WebView, so the same card has to point
   * the frame at a composed pdf.js page instead of at the file — and at the
   * right one: `#preview` is a single pinned page, `#full` the scrollable
   * document. Getting the hash wrong is invisible in a snapshot and shows up
   * as a card that scrolls inside the feed, or a sheet stuck on page 1.
   */
  it('renders the composed pdf.js document on Android', async () => {
    Platform.OS = 'android'
    try {
      await renderBlock(<FileBlock relPath="files/report.pdf" declared="document" />)
      await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())
      expect(ensurePdfHostDocument).toHaveBeenCalledWith(
        'file:///cache/files/report.pdf',
        `files/report.pdf:${FILES['files/report.pdf'].length}`
      )
      expect(screen.getByTestId('webview').props.source).toEqual({
        uri: 'file:///cache/pdf-host/host.html#preview'
      })
      // The page may not read a second file — the document is inside it.
      expect(screen.getByTestId('webview').props.allowFileAccessFromFileURLs).toBe(false)

      await fireEvent.press(screen.getByLabelText('Expand'))
      await waitFor(() => expect(screen.getByLabelText('Close')).toBeTruthy())
      expect(screen.getByTestId('webview').props.source).toEqual({
        uri: 'file:///cache/pdf-host/host.html#full'
      })
    } finally {
      Platform.OS = 'ios'
    }
  })

  it('renders HTML live, toggles to source, and expands', async () => {
    await renderBlock(<FileBlock relPath="files/page.html" declared="file" />)
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())

    await fireEvent.press(screen.getByLabelText('Source'))
    await waitFor(() => expect(screen.queryByTestId('webview')).toBeNull())
    expect(screen.getByText(/<h1>Report<\/h1>/)).toBeTruthy()

    await fireEvent.press(screen.getByLabelText('Preview'))
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())

    await fireEvent.press(screen.getByLabelText('Expand'))
    await waitFor(() => expect(screen.getByLabelText('Close')).toBeTruthy())
    expect(screen.getByTestId('webview')).toBeTruthy()
  })

  it('renders markdown as rich text, not source', async () => {
    await renderBlock(<FileBlock relPath="files/README.md" declared="file" />)
    await waitFor(() => expect(screen.getByText('Title')).toBeTruthy())
    expect(screen.getByText('bold')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
  })

  it('renders plain text as line-numbered source', async () => {
    await renderBlock(<FileBlock relPath="files/notes.txt" declared="document" />)
    await waitFor(() => expect(screen.getByText(/plain line one/)).toBeTruthy())
    expect(screen.getByText('1\n2')).toBeTruthy()
    expect(screen.getByText('2 lines')).toBeTruthy()
  })

  it('renders source files as a code card', async () => {
    await renderBlock(<FileBlock relPath="files/app.ts" declared="file" />)
    await waitFor(() => expect(screen.getByText(/export const answer = 42/)).toBeTruthy())
    expect(screen.getByText(/typescript/)).toBeTruthy()
  })

  it('renders an SVG exactly like any other image', async () => {
    // expo-image decodes SVG, so a delivered logo gets the same thumbnail,
    // lightbox and share as a .png — no card chrome, and never its markup.
    await renderBlock(<FileBlock relPath="files/logo.svg" declared="file" />)
    await waitFor(() => expect(screen.getByTestId('image')).toBeTruthy())
    expect(screen.queryByText(/<circle/)).toBeNull()

    await fireEvent.press(screen.getByLabelText('logo.svg'))
    await waitFor(() => expect(screen.getAllByTestId('image').length).toBeGreaterThan(1))
    expect(screen.getByText('logo.svg')).toBeTruthy()
  })

  it('renders CSV as a table', async () => {
    await renderBlock(<FileBlock relPath="files/data.csv" declared="document" />)
    await waitFor(() => expect(screen.getByText('widget')).toBeTruthy())
    expect(screen.getByText('name')).toBeTruthy()
    expect(screen.getByText('qty')).toBeTruthy()
    expect(screen.getByText(/3 rows/)).toBeTruthy()
  })

  it('renders a chart spec as a chart card with the data toggle', async () => {
    await renderBlock(<FileBlock relPath="files/q3-revenue.chart.json" declared="chart" />)
    // Chrome comes from the spec, not the filename — the desktop card's header.
    await waitFor(() => expect(screen.getByText('Q3 revenue')).toBeTruthy())
    expect(screen.getByText('by product line')).toBeTruthy()
    expect(screen.getByText('Source: finance close')).toBeTruthy()
    expect(screen.getByLabelText('Share as image')).toBeTruthy()

    await fireEvent.press(screen.getByLabelText('Expand'))
    await waitFor(() => expect(screen.getByLabelText('Close')).toBeTruthy())
    // The sheet's chart view is the live plot frame…
    expect(screen.getByTestId('webview')).toBeTruthy()

    // …and the desktop's Chart ⇄ Data toggle shows the parsed spec as JSON.
    await fireEvent.press(screen.getByLabelText('Data'))
    await waitFor(() => expect(screen.getByText(/"type": "column"/)).toBeTruthy())
    expect(screen.queryByTestId('webview')).toBeNull()
  })

  it('degrades an unparseable chart spec to the plain file card', async () => {
    await renderBlock(<FileBlock relPath="files/broken.chart.json" declared="chart" />)
    await waitFor(() => expect(screen.getByText('broken.chart.json')).toBeTruthy())
    // No chart chrome — the generic card keeps the file shareable, nothing more.
    expect(screen.queryByLabelText('Share as image')).toBeNull()
  })

  it.each([
    ['files/book.xlsx', 'book.xlsx', 'XLSX'],
    ['files/letter.docx', 'letter.docx', 'DOCX'],
    ['files/archive.zip', 'archive.zip', 'ZIP']
  ])('hands %s to the system viewer through a file card', async (relPath, name, ext) => {
    await renderBlock(<FileBlock relPath={relPath} declared="file" sizeBytes={2048} />)
    await waitFor(() => expect(screen.getByText(name)).toBeTruthy())
    expect(screen.getByText(`${ext} · 2 KB`)).toBeTruthy()

    await fireEvent.press(screen.getByLabelText(name))
    expect(Sharing.shareAsync).toHaveBeenCalledWith(`file:///cache/${relPath}`)
  })
})

describe('FileBlock — degraded states', () => {
  it.each([
    ['files/gone.png', 'image', 'Image file was deleted or unavailable'],
    ['files/gone.mp4', 'video', 'Video file was deleted or unavailable'],
    ['files/gone.mp3', 'audio', 'Audio file was deleted or unavailable'],
    ['files/gone.md', 'file', 'File was deleted'],
    ['files/gone.csv', 'document', 'File was deleted'],
    ['files/gone.html', 'file', 'File was deleted'],
    ['files/gone.pdf', 'document', 'File was deleted'],
    ['files/gone.zip', 'file', 'File was deleted']
  ])('shows the per-type unavailable state for a pruned %s', async (relPath, declared, label) => {
    await renderBlock(<FileBlock relPath={relPath} declared={declared as 'file'} />)
    await waitFor(() => expect(screen.getByText(label)).toBeTruthy())
  })

  it('renders an already-cached file with no fetch and no placeholder', async () => {
    // The feed's whole stability rests on this: a file the phone already holds
    // renders at full size in its first frame, so nothing resizes underneath
    // the transcript a beat later and drags the scroll position with it.
    await renderBlock(<FileBlock relPath="files/cached.ts" declared="file" />)
    expect(screen.getByText(/export const cached = true/)).toBeTruthy()
    const asked = (resolveWorkspaceFile as jest.Mock).mock.calls.map(([path]) => path)
    expect(asked).not.toContain('files/cached.ts')
  })

  it('renders attachments on the user side with the same dispatch', async () => {
    await renderBlock(
      <FileBlock
        relPath="files/data.csv"
        declared="other"
        displayName="quarterly.csv"
        align="end"
      />
    )
    await waitFor(() => expect(screen.getByText('quarterly.csv')).toBeTruthy())
    expect(screen.getByText('widget')).toBeTruthy()
  })
})
