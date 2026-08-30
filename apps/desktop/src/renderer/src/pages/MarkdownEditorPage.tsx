import { CodeEditor } from '@components/core/CodeEditor'
import { CopyButton } from '@components/core/CopyButton'
import { useToast } from '@components/core/toast/useToast'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { useTheme } from '@providers/theme/useTheme'
import { ArrowLeft02Icon, ArrowRight02Icon, FloppyDiskIcon, Refresh01Icon } from 'hugeicons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type MarkdownEditorPageProps = {
  filePath: string
  fileName: string
}

export function MarkdownEditorPage({
  filePath,
  fileName
}: MarkdownEditorPageProps): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const { isDark } = useTheme()
  const isRtl = RTL_LOCALES.has(locale)
  const BackIcon = isRtl ? ArrowRight02Icon : ArrowLeft02Icon
  const { goTo } = useFlow()
  const toast = useToast()

  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.api.viewer
      .readFile(filePath)
      .then((raw) => {
        if (cancelled) return
        setContent(raw)
        setOriginalContent(raw)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filePath])

  const handleSave = useCallback(async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      await window.api.viewer.writeFile(filePath, content)
      setOriginalContent(content)
      toast.show({ tone: 'success', message: t('workspace.saved') })
    } catch {
      toast.show({ tone: 'error', message: t('workspace.saveError') })
    } finally {
      setSaving(false)
    }
  }, [content, filePath, saving, t, toast])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSave])

  /**
   * Someone else wrote this file — another window, or the paired phone's
   * Customization screen. Adopt it silently so the two devices never sit on
   * different text, but ONLY while this editor is clean: an unsaved draft is
   * work in progress, and replacing it under the cursor would lose keystrokes
   * that exist nowhere else. A dirty editor keeps its draft, and its Save then
   * wins on both screens the way the last write always does.
   *
   * The dirty check reads a ref rather than state so the subscription survives
   * every keystroke — resubscribing per character would drop the notification
   * that arrives between the unsubscribe and the next attach.
   */
  const liveRef = useRef({ content, originalContent })
  useEffect(() => {
    liveRef.current = { content, originalContent }
  }, [content, originalContent])

  useEffect(
    () =>
      window.api.viewer.onCustomizationChanged((payload) => {
        if (payload?.path !== filePath) return
        const { content: current, originalContent: original } = liveRef.current
        if (current !== original) return
        window.api.viewer
          .readFile(filePath)
          .then((raw) => {
            // Re-checked on arrival: typing may have started while the read
            // was in flight, and this is a courtesy refresh, not a demand.
            if (liveRef.current.content !== liveRef.current.originalContent) return
            setContent(raw)
            setOriginalContent(raw)
          })
          .catch(() => {})
      }),
    [filePath]
  )

  const handleRefresh = useCallback(async (): Promise<void> => {
    try {
      const raw = await window.api.viewer.readFile(filePath)
      setContent(raw)
      setOriginalContent(raw)
      toast.show({ tone: 'success', message: t('workspace.resynced') })
    } catch {
      toast.show({ tone: 'error', message: t('workspace.resyncError') })
    }
  }, [filePath, t, toast])

  const isDirty = content !== originalContent

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <header className="border-border flex items-center justify-between gap-2 border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => goTo('chat')}
            aria-label={t('common.back')}
            className={cn(
              'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-sm',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          >
            <BackIcon size={16} />
            <span>{t('common.back')}</span>
          </button>
        </div>
      </header>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-border flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-fg text-sm font-medium">{fileName}</span>
            {isDirty && <span className="text-muted text-xs italic">(unsaved)</span>}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={loading}
              className={cn(
                'text-muted hover:text-fg inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs',
                'disabled:cursor-not-allowed disabled:opacity-40'
              )}
            >
              <Refresh01Icon size={14} />
              <span>{t('workspace.resync')}</span>
            </button>
            <CopyButton text={content} variant="inline" />
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!isDirty || saving}
              aria-label={t('workspace.save')}
              title={t('workspace.save')}
              className={cn(
                'text-muted hover:text-fg hover:bg-border/40 flex h-8 w-8 items-center justify-center rounded-lg cursor-pointer',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted'
              )}
            >
              <FloppyDiskIcon size={16} />
            </button>
          </div>
        </div>
        {loading ? (
          <div className="text-muted flex flex-1 items-center justify-center text-sm">
            {t('common.loading')}
          </div>
        ) : (
          <CodeEditor
            value={content}
            language="markdown"
            isDark={isDark}
            readOnly={false}
            onChange={setContent}
            className="min-h-0 w-full flex-1"
            spellcheck
          />
        )}
      </section>
    </main>
  )
}
