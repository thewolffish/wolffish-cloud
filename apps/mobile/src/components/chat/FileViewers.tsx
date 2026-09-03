import {
  ArrowExpandIcon,
  CodeIcon,
  Copy01Icon,
  EyeIcon,
  File01Icon,
  Pdf02Icon,
  Upload01Icon,
  Table01Icon,
  Tick02Icon
} from '@/components/core/icons'
import { ExpandedSheet } from '@/components/core/ExpandedSheet'
import { delimiterFor, parseDelimited, type SheetTable } from '@/lib/files/csv'
import { fileName as baseName, formatBytes, type FileClassification } from '@/lib/files/fileKinds'
import { useWorkspaceFile } from '@/lib/files/useWorkspaceFile'
import { useWorkspaceFileText } from '@/lib/files/useWorkspaceFileText'
import { cn } from '@/lib/utils/cn'
import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { ensurePdfHostDocument, PDF_MAX_INLINE_BYTES, type PdfHostDocument } from '@/lib/pdf/html'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { DownloadGlyph, DownloadStatus } from '@/components/chat/DownloadStatus'
import {
  CardFooter,
  CardHeader,
  CardShell,
  IconAction,
  MissingCard,
  RenderGuard,
  shareFile,
  type Align
} from '@/components/chat/FileChrome'
import { MarkdownView } from '@/components/chat/MarkdownView'

/**
 * Inline file viewers — the mobile counterparts of the desktop's
 * MarkdownFileViewer / CodeFileViewer / HtmlFileViewer / SpreadsheetViewer /
 * PdfViewer. Each renders a preview card at chat-bubble width and opens the
 * same content full-screen through ExpandedSheet, mirroring the desktop's
 * card→expand pair.
 *
 * Two mobile-specific rules, both about living inside a scrolling feed:
 *  - inline previews are NON-INTERACTIVE (a WebView that scrolls inside the
 *    chat list steals the list's pan gesture) — tapping a preview expands it,
 *    and the expanded sheet is where scrolling, zooming and links live;
 *  - the desktop's open/reveal/download trio collapses into the system share
 *    sheet, which is where "open in…", "save to Files" and "print" live.
 */

/** Line-numbered source and rendered markdown both clamp to this inline. */
const INLINE_BODY_HEIGHT = 260
/** Beyond this many characters the body is clipped for rendering only. */
const MAX_RENDER_CHARS = 120_000

function CopyAction({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const Icon = copied ? Tick02Icon : Copy01Icon
  return (
    <IconAction
      label={t('chat.copy')}
      icon={<Icon size={14} className={copied ? 'text-emerald-600' : 'text-muted'} />}
      onPress={() => {
        void Clipboard.setStringAsync(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    />
  )
}

export function ShareAction({ uri }: { uri: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <IconAction
      label={t('chat.fileCard.share')}
      icon={<Upload01Icon size={14} className="text-muted" />}
      onPress={() => shareFile(uri)}
    />
  )
}

export function ExpandAction({ onPress }: { onPress: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <IconAction
      label={t('chat.fileCard.expand')}
      icon={<ArrowExpandIcon size={14} className="text-muted" />}
      onPress={onPress}
    />
  )
}

/**
 * The card a viewer occupies while its bytes are still arriving.
 *
 * Deliberately not a spinner in a box: it is the SAME shell, the same header
 * (the icon and the name are known long before the file is), the same footer
 * with the same number of action slots, and a body of exactly the height the
 * loaded body will take. Loading and loaded therefore have one footprint, so
 * the file landing swaps content inside a box that never changes size —
 * nothing below it moves, and the feed's scroll position stays put. It is the
 * desktop's rule for the same problem (PdfViewer's loading state and its
 * iframe are both `h-[400px]`, ImageViewer's placeholder carries the image's
 * own aspect ratio) applied to the whole card rather than just the body.
 *
 * The reserved body carries the transfer itself (DownloadStatus) instead of a
 * shimmer — same footprint, but it says which download you are waiting on.
 */
export function ViewerSkeleton({
  align,
  icon,
  name,
  relPath,
  expectedBytes,
  bodyHeight,
  footerLabel,
  actions
}: {
  align?: Align
  icon: ReactNode
  name: string
  /** The file being fetched — the key its progress is reported under. */
  relPath: string
  /** Size from the message metadata, if it carried one. */
  expectedBytes?: number
  /** Height of the body the loaded card will render. */
  bodyHeight: number
  footerLabel?: string
  /** How many action buttons the loaded footer carries — they set its height. */
  actions: number
}): React.JSX.Element {
  return (
    <CardShell align={align}>
      <CardHeader icon={icon} name={name} />
      <View className="bg-bg border-border border-t p-3" style={{ height: bodyHeight }}>
        <View className="bg-border h-full w-full rounded-lg opacity-40" />
        <DownloadStatus relPath={relPath} expectedBytes={expectedBytes} />
      </View>
      <CardFooter label={footerLabel}>
        {/* m-1.5 + 14pt matches IconAction's p-1.5 + 14pt icon, so the footer
            is the same height with placeholders as with real buttons. */}
        {Array.from({ length: actions }, (_, index) => (
          <View key={index} className="bg-border m-1.5 h-3.5 w-3.5 rounded opacity-40" />
        ))}
      </CardFooter>
    </CardShell>
  )
}

/**
 * Non-interactive preview that expands on tap — see the file header note.
 * Text-ish bodies pass `maxHeight` so a two-line file gets a two-line card;
 * WebView bodies (HTML, PDF) have no intrinsic height and pass `height`.
 */
function PreviewTap({
  onPress,
  label,
  height,
  maxHeight,
  children
}: {
  onPress: () => void
  label: string
  height?: number
  maxHeight?: number
  children: ReactNode
}): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
      <View
        pointerEvents="none"
        style={height !== undefined ? { height } : { maxHeight }}
        className="overflow-hidden"
      >
        {children}
      </View>
    </Pressable>
  )
}

/** Line-numbered monospace body — one Text per column keeps it cheap. */
export function SourceBody({
  content,
  flex
}: {
  content: string
  flex?: boolean
}): React.JSX.Element {
  const shown = content.length > MAX_RENDER_CHARS ? content.slice(0, MAX_RENDER_CHARS) : content
  const gutter = useMemo(
    () => Array.from({ length: Math.max(shown.split('\n').length, 1) }, (_, i) => i + 1).join('\n'),
    [shown]
  )
  return (
    <ScrollView
      className={flex ? 'flex-1' : ''}
      style={flex ? undefined : { maxHeight: INLINE_BODY_HEIGHT }}
      nestedScrollEnabled
    >
      {/* The gutter sits OUTSIDE the horizontal scroller — line numbers stay
          pinned to the leading edge while only the code slides sideways (the
          desktop does the same with `sticky left-0`). Both columns share the
          vertical scroller and the same line metrics, so rows stay aligned. */}
      <View className="flex-row" style={{ direction: 'ltr' }}>
        <View className="bg-bg-soft border-border border-e px-2 py-2">
          {/* text-muted, not muted/70: the alpha would drop (same var() rule
              as the CSV borders below) and default-black numbers vanish on
              a dark background. */}
          <Text
            className="text-muted text-right font-mono"
            style={{ fontSize: 11, lineHeight: 18 }}
            selectable={false}
          >
            {gutter}
          </Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text
            className="text-fg px-3 py-2 font-mono"
            style={{ fontSize: 11, lineHeight: 18 }}
            selectable
          >
            {shown}
          </Text>
        </ScrollView>
      </View>
    </ScrollView>
  )
}

function MarkdownBody({ content, flex }: { content: string; flex?: boolean }): React.JSX.Element {
  const shown = content.length > MAX_RENDER_CHARS ? content.slice(0, MAX_RENDER_CHARS) : content
  return (
    <ScrollView
      className={flex ? 'flex-1' : ''}
      style={flex ? undefined : { maxHeight: INLINE_BODY_HEIGHT }}
      contentContainerStyle={{ padding: 12 }}
      nestedScrollEnabled
    >
      <MarkdownView>{shown}</MarkdownView>
    </ScrollView>
  )
}

export type FileViewerProps = {
  relPath: string
  conversationId?: string
  classification: FileClassification
  sizeBytes?: number
  displayName?: string
  align?: Align
  /** Rendered when the body can't be shown inline (missing, oversized, binary). */
  fallback: React.JSX.Element
}

/**
 * Markdown, plain-text and source files: rendered markdown or line-numbered
 * source, clamped inline with copy/share/expand — the desktop's
 * MarkdownFileViewer/CodeFileViewer card.
 */
export function TextFileCard({
  relPath,
  conversationId,
  classification,
  sizeBytes,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const {
    text,
    uri,
    sizeBytes: readSize,
    loading,
    missing,
    oversized
  } = useWorkspaceFileText(relPath, conversationId)
  const name = displayName ?? classification.name ?? baseName(relPath)
  const isMarkdown = classification.kind === 'markdown'
  const icon = isMarkdown ? (
    <File01Icon size={14} className="text-muted" />
  ) : (
    <CodeIcon size={14} className="text-muted" />
  )

  if (loading) {
    return (
      <ViewerSkeleton
        align={align}
        icon={icon}
        name={name}
        relPath={relPath}
        expectedBytes={sizeBytes}
        // The loaded body clamps AT this height; a file short enough to come in
        // under it settles upward by the difference. Reserving the clamp is the
        // better of the two errors — most delivered source files run past it,
        // and anything already cached renders at its true height on frame one
        // (useWorkspaceFileText) without passing through here at all.
        bodyHeight={INLINE_BODY_HEIGHT}
        footerLabel={[classification.language ?? classification.ext, formatBytes(sizeBytes ?? 0)]
          .filter(Boolean)
          .join(' · ')}
        actions={3}
      />
    )
  }
  if (missing || oversized || text === null) return fallback

  const lineCount = text.split('\n').length
  const body = isMarkdown ? <MarkdownBody content={text} /> : <SourceBody content={text} />
  const expandedBody = isMarkdown ? (
    <MarkdownBody content={text} flex />
  ) : (
    <SourceBody content={text} flex />
  )
  const footerLabel = [
    classification.language ?? classification.ext,
    formatBytes(sizeBytes || readSize)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <CardShell align={align}>
      <CardHeader icon={icon} name={name} meta={t('chat.fileViewer.lines', { count: lineCount })} />
      <PreviewTap onPress={() => setOpen(true)} label={name} maxHeight={INLINE_BODY_HEIGHT}>
        {body}
      </PreviewTap>
      <CardFooter label={footerLabel}>
        <ShareAction uri={uri} />
        <CopyAction text={text} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={
          <>
            <ShareAction uri={uri} />
            <CopyAction text={text} />
          </>
        }
      >
        {expandedBody}
      </ExpandedSheet>
    </CardShell>
  )
}

/**
 * HTML files: a live (sandboxed) render of the page with a source toggle —
 * the desktop's HtmlFileViewer. The inline card is a static preview; expanding
 * gives the full-screen, interactive page, which is the mobile answer to
 * "open this website".
 */
export function HtmlFileCard({
  relPath,
  conversationId,
  classification,
  sizeBytes,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'preview' | 'source'>('preview')
  const {
    text,
    uri,
    sizeBytes: readSize,
    loading,
    missing,
    oversized
  } = useWorkspaceFileText(relPath, conversationId)
  const name = displayName ?? classification.name ?? baseName(relPath)

  if (loading) {
    return (
      <ViewerSkeleton
        align={align}
        icon={<CodeIcon size={14} className="text-muted" />}
        name={name}
        relPath={relPath}
        expectedBytes={sizeBytes}
        // Exact: the loaded preview is a WebView pinned to this same height.
        bodyHeight={INLINE_BODY_HEIGHT}
        footerLabel={['html', formatBytes(sizeBytes ?? 0)].filter(Boolean).join(' · ')}
        actions={4}
      />
    )
  }
  if (missing || oversized || text === null) return fallback

  // The page runs for real — scripts and all — which is the point of
  // delivering an HTML file to a phone. It is confined the same way the
  // desktop's sandboxed iframe is: loaded from a string (opaque origin, no
  // baseUrl), no file access, no shared storage, so it can reach neither the
  // app's data nor the workspace cache. Only the initial document load may
  // navigate the frame — a tapped link opens in the system browser instead of
  // replacing the card's contents.
  const frame = (
    <WebView
      originWhitelist={['*']}
      source={{ html: text }}
      style={{ backgroundColor: 'white' }}
      javaScriptEnabled
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={(request) => {
        if (request.url === 'about:blank' || request.url.startsWith('data:')) return true
        if (/^https?:/.test(request.url)) void WebBrowser.openBrowserAsync(request.url)
        return false
      }}
    />
  )

  const previewing = view === 'preview'
  const footerLabel = ['html', formatBytes(sizeBytes || readSize)].filter(Boolean).join(' · ')
  const viewToggle = (
    <IconAction
      label={t(`chat.htmlViewer.${previewing ? 'source' : 'preview'}`)}
      selected={previewing}
      icon={
        previewing ? (
          <CodeIcon size={14} className="text-muted" />
        ) : (
          <EyeIcon size={14} className="text-muted" />
        )
      }
      onPress={() => setView(previewing ? 'source' : 'preview')}
    />
  )

  return (
    <CardShell align={align}>
      <CardHeader icon={<CodeIcon size={14} className="text-muted" />} name={name} />
      <PreviewTap onPress={() => setOpen(true)} label={name} height={INLINE_BODY_HEIGHT}>
        {/* While the sheet is up the card is hidden behind it — don't keep a
            second copy of the page (and its scripts) alive underneath. */}
        {open ? (
          <View className="bg-surface flex-1" />
        ) : previewing ? (
          frame
        ) : (
          <SourceBody content={text} />
        )}
      </PreviewTap>
      <CardFooter label={footerLabel}>
        {viewToggle}
        <ShareAction uri={uri} />
        <CopyAction text={text} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={
          <>
            {viewToggle}
            <ShareAction uri={uri} />
            <CopyAction text={text} />
          </>
        }
      >
        {previewing ? frame : <SourceBody content={text} flex />}
      </ExpandedSheet>
    </CardShell>
  )
}

function SheetGrid({ table, flex }: { table: SheetTable; flex?: boolean }): React.JSX.Element {
  const [header, ...body] = table.rows
  return (
    <ScrollView
      horizontal
      className={flex ? 'flex-1' : ''}
      style={flex ? undefined : { maxHeight: INLINE_BODY_HEIGHT }}
    >
      <ScrollView nestedScrollEnabled style={flex ? undefined : { maxHeight: INLINE_BODY_HEIGHT }}>
        <View style={{ direction: 'ltr' }}>
          {header ? (
            <View className="bg-bg-soft border-border flex-row border-b">
              {header.map((cell, index) => (
                <Text
                  key={index}
                  selectable
                  numberOfLines={2}
                  className="text-fg font-sans-medium border-border w-32 border-e px-2 py-1.5 text-left text-[11px]"
                >
                  {cell}
                </Text>
              ))}
            </View>
          ) : null}
          {body.map((row, rowIndex) => (
            // border-soft, not border/60: an alpha modifier on a var() color
            // silently drops in RN and a dropped border color paints black
            // (see global.css) — the token is the same tone, precomputed.
            <View key={rowIndex} className="border-border-soft flex-row border-b">
              {row.map((cell, index) => (
                <Text
                  key={index}
                  selectable
                  numberOfLines={2}
                  className="text-fg border-border-soft w-32 border-e px-2 py-1.5 text-left font-sans text-[11px]"
                >
                  {cell}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  )
}

/** CSV/TSV rendered as a table — the desktop's SpreadsheetViewer for those. */
export function SheetFileCard({
  relPath,
  conversationId,
  classification,
  sizeBytes,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const {
    text,
    uri,
    sizeBytes: readSize,
    loading,
    missing,
    oversized
  } = useWorkspaceFileText(relPath, conversationId)
  const table = useMemo(
    () => (text === null ? null : parseDelimited(text, delimiterFor(classification.ext))),
    [text, classification.ext]
  )
  const name = displayName ?? classification.name ?? baseName(relPath)

  if (loading) {
    return (
      <ViewerSkeleton
        align={align}
        icon={<Table01Icon size={14} className="text-muted" />}
        name={name}
        relPath={relPath}
        expectedBytes={sizeBytes}
        bodyHeight={INLINE_BODY_HEIGHT}
        footerLabel={formatBytes(sizeBytes ?? 0)}
        actions={3}
      />
    )
  }
  if (missing || oversized || text === null || table === null || table.rows.length === 0) {
    return fallback
  }

  const footerLabel = [
    t('chat.fileViewer.rows', { count: table.totalRows }),
    formatBytes(sizeBytes || readSize)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <CardShell align={align}>
      <CardHeader icon={<Table01Icon size={14} className="text-muted" />} name={name} />
      <PreviewTap onPress={() => setOpen(true)} label={name} maxHeight={INLINE_BODY_HEIGHT}>
        <SheetGrid table={table} />
      </PreviewTap>
      <CardFooter label={footerLabel}>
        <ShareAction uri={uri} />
        <CopyAction text={text} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={
          <>
            <ShareAction uri={uri} />
            <CopyAction text={text} />
          </>
        }
      >
        <SheetGrid table={table} flex />
      </ExpandedSheet>
    </CardShell>
  )
}

/**
 * PDFs — a first-page preview that expands to a scrollable document, the
 * desktop's PdfViewer.
 *
 * Two engines behind one card. iOS renders PDFs natively in WKWebView, so
 * there the frame is simply pointed at the file. Android's WebView has never
 * shipped a PDF engine, so the renderer travels with the page: lib/pdf/html
 * composes a self-contained pdf.js document around the file's bytes, and the
 * frame loads that instead. Everything outside `source` is the same, including
 * the closed sandbox — neither engine may read a second file.
 *
 * The card still degrades to the plain file row (`fallback`, which hands the
 * document to the system viewer through the share sheet) when the file is past
 * the inline ceiling or pdf.js cannot make a page out of it.
 */
export function PdfFileCard({
  relPath,
  conversationId,
  classification,
  sizeBytes,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { uri, sizeBytes: cachedSize, loading, missing } = useWorkspaceFile(relPath, conversationId)
  const name = displayName ?? classification.name ?? baseName(relPath)

  const native = Platform.OS === 'ios'
  const bytes = sizeBytes || cachedSize
  const oversized = !native && bytes > PDF_MAX_INLINE_BYTES
  const [host, setHost] = useState<PdfHostDocument | null>(null)
  // Set by a page that loaded but could not render — a PDF pdf.js rejects, or
  // a document too heavy for the WebView's renderer. Both end at the file row.
  const [engineFailed, setEngineFailed] = useState(false)
  // Remounts the frame if the renderer dies under a large document.
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (native || !uri || oversized) return
    let alive = true
    ensurePdfHostDocument(uri, `${relPath}:${bytes}`)
      .then((built) => {
        if (alive) setHost(built)
      })
      .catch(() => {
        // Asset read or a full disk — the file row still shares the document.
        if (alive) setEngineFailed(true)
      })
    return () => {
      alive = false
    }
  }, [native, uri, oversized, relPath, bytes])

  if (loading || (!native && uri && !oversized && !host && !engineFailed)) {
    return (
      <ViewerSkeleton
        align={align}
        icon={<Pdf02Icon size={14} className="text-muted" />}
        name={name}
        relPath={relPath}
        expectedBytes={sizeBytes}
        // Exact: the loaded document frame is pinned to this same height.
        bodyHeight={INLINE_BODY_HEIGHT + 60}
        footerLabel={[classification.ext.toUpperCase(), formatBytes(sizeBytes ?? 0)]
          .filter(Boolean)
          .join(' · ')}
        actions={2}
      />
    )
  }
  if (missing || !uri) return fallback
  if (!native && (oversized || engineFailed || !host)) return fallback

  const directory = native ? uri.slice(0, uri.lastIndexOf('/') + 1) : host!.directory
  // The composed page serves both mounts; the hash is how it knows which one
  // is asking (page 1, pinned — or every page, scrollable and zoomable).
  const documentUri = (mode: 'preview' | 'full'): string => (native ? uri : `${host!.uri}#${mode}`)
  const frame = (mode: 'preview' | 'full'): React.JSX.Element => (
    <WebView
      key={`${mode}-${generation}`}
      source={{ uri: documentUri(mode) }}
      // Without file:// in the whitelist the WebView refuses the document and
      // punts it to Linking.openURL, which can't open a sandbox path — the
      // card renders blank. This is what makes the PDF preview appear at all.
      originWhitelist={['file://*']}
      // iOS needs explicit read access to the containing directory to load a
      // file:// document; scoping it to the file's own folder keeps the frame
      // away from the rest of the cache.
      allowingReadAccessToURL={directory}
      allowFileAccess
      // Shut on both platforms, and load-bearing on Android: it is what says
      // the pdf.js page may not go reading the rest of the sandbox. Closing it
      // is why the document is inlined into the page rather than fetched.
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      javaScriptEnabled
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
      style={{ backgroundColor: 'white' }}
      onShouldStartLoadWithRequest={(request) => request.url.startsWith('file://')}
      onMessage={(event) => {
        let message: { type?: string }
        try {
          message = JSON.parse(event.nativeEvent.data) as typeof message
        } catch {
          return
        }
        if (message.type === 'error') setEngineFailed(true)
      }}
      onContentProcessDidTerminate={() => setGeneration((n) => n + 1)}
      onRenderProcessGone={() => setGeneration((n) => n + 1)}
    />
  )

  return (
    <CardShell align={align}>
      <CardHeader icon={<Pdf02Icon size={14} className="text-muted" />} name={name} />
      <PreviewTap onPress={() => setOpen(true)} label={name} height={INLINE_BODY_HEIGHT + 60}>
        {/* One document renderer at a time — see HtmlFileCard. */}
        {open ? <View className="bg-surface flex-1" /> : frame('preview')}
      </PreviewTap>
      <CardFooter
        label={[classification.ext.toUpperCase(), formatBytes(bytes)].filter(Boolean).join(' · ')}
      >
        <ShareAction uri={uri} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={<ShareAction uri={uri} />}
      >
        {frame('full')}
      </ExpandedSheet>
    </CardShell>
  )
}

/**
 * The catch-all card: icon, name, type · size, and a tap that hands the file
 * to the OS (share sheet → open in…, save to Files). Also the fallback every
 * viewer above degrades to.
 */
export function GenericFileCard({
  relPath,
  conversationId,
  sizeBytes,
  displayName,
  classification,
  align
}: {
  relPath: string
  conversationId?: string
  sizeBytes?: number
  displayName?: string
  classification: FileClassification
  align?: Align
}): React.JSX.Element {
  const { t } = useTranslation()
  const { uri, sizeBytes: cachedSize, loading, missing } = useWorkspaceFile(relPath, conversationId)
  const name = displayName ?? classification.name ?? baseName(relPath)
  // Attachments carry a size; delivered files don't — fall back to the file
  // the cache actually holds (the desktop stats over IPC for the same reason).
  const shownSize = sizeBytes || cachedSize

  if (!loading && (missing || !uri)) {
    return <MissingCard label={t('chat.fileCard.deleted')} align={align} />
  }

  const isPdf = classification.kind === 'pdf'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      disabled={loading || !uri}
      onPress={() => shareFile(uri)}
      className={cn(
        // w-[85%], not max-w — a card sized to its filename would sit short of
        // every other card in the feed.
        'bg-surface border-border w-[85%] flex-row items-center gap-3 rounded-xl border px-4 py-3',
        'active:bg-border-soft',
        align === 'end' ? 'self-end' : 'self-start'
      )}
    >
      <View className="bg-bg border-border h-10 w-10 items-center justify-center rounded-lg border">
        {loading ? (
          <DownloadGlyph />
        ) : isPdf ? (
          <Pdf02Icon size={18} className="text-muted" />
        ) : (
          <File01Icon size={18} className="text-muted" />
        )}
      </View>
      {/* Held to the leading box's height in both states — the loaded column is
          shorter than the box, so the box is what sets this row's height, and
          the loading column has to stay inside it or the bytes landing would
          resize the card and nudge the feed. `h-10` rather than a number: it
          is the box's own class, so the two track each other. */}
      <View className="min-w-0 h-10 flex-1 flex-col justify-center gap-0.5 overflow-hidden">
        <Text numberOfLines={1} className="text-fg font-sans-medium text-left text-sm">
          {name}
        </Text>
        {loading ? (
          <DownloadStatus relPath={relPath} expectedBytes={shownSize} variant="row" rowGap={2} />
        ) : (
          <Text className="text-muted text-left font-sans text-xs">
            {[classification.ext.toUpperCase(), formatBytes(shownSize)].filter(Boolean).join(' · ')}
          </Text>
        )}
      </View>
    </Pressable>
  )
}
