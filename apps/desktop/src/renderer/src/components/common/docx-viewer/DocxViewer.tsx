import { cn } from '@lib/utils/cn'
import { Download01Icon, File01Icon, FolderOpenIcon, LinkSquare02Icon } from 'hugeicons-react'
import mammoth from 'mammoth'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type DocxViewerProps = {
  filePath: string
  fileExists: boolean
  fileName: string
  sizeBytes: number
}

export function DocxViewer({ filePath, fileExists, fileName }: DocxViewerProps): React.JSX.Element {
  if (!fileExists) return <Deleted fileName={fileName} />
  return <Active filePath={filePath} fileName={fileName} />
}

function Deleted({ fileName }: { fileName: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'border-border bg-surface flex w-full max-w-[85%] items-center gap-3 self-start',
        'rounded-2xl border px-4 py-3 opacity-50'
      )}
    >
      <div className="bg-muted/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
        <File01Icon size={18} className="text-muted" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-muted truncate text-sm font-medium" title={fileName}>
          {fileName}
        </span>
        <span className="text-muted text-xs italic">{t('chat.fileCard.deleted')}</span>
      </div>
    </div>
  )
}

function Active({ filePath, fileName }: { filePath: string; fileName: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const buffer = await window.api.upload.readFile(filePath)
        if (!buffer) throw new Error(`missing upload: ${filePath}`)
        const result = await mammoth.convertToHtml({ arrayBuffer: buffer })
        if (!cancelled) setHtml(result.value)
      } catch {
        if (!cancelled) setError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filePath])

  const openExternal = useCallback(async () => {
    try {
      await window.api.upload.openExternal(filePath)
    } catch {
      // best-effort
    }
  }, [filePath])

  const download = useCallback(async () => {
    try {
      await window.api.upload.download(filePath)
    } catch {
      // best-effort
    }
  }, [filePath])

  const revealInFolder = useCallback(async () => {
    try {
      await window.api.upload.revealInFolder(filePath)
    } catch {
      // best-effort
    }
  }, [filePath])

  if (error) return <Deleted fileName={fileName} />

  return (
    <div
      className={cn(
        'border-border bg-surface flex w-full max-w-[85%] flex-col self-start',
        'overflow-hidden rounded-2xl border'
      )}
    >
      {html !== null ? (
        <div
          className="bg-bg text-fg max-h-[400px] overflow-auto p-4 text-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="flex h-[200px] w-full items-center justify-center">
          <span className="text-muted animate-pulse text-xs">{t('chat.docxViewer.loading')}</span>
        </div>
      )}
      <Footer
        fileName={fileName}
        onOpenExternal={openExternal}
        onReveal={revealInFolder}
        onDownload={download}
      />
    </div>
  )
}

function Footer({
  fileName,
  onOpenExternal,
  onReveal,
  onDownload
}: {
  fileName: string
  onOpenExternal: () => void
  onReveal: () => void
  onDownload: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <File01Icon size={14} className="text-muted shrink-0" />
      <span className="text-muted min-w-0 flex-1 truncate text-[11px] font-medium" title={fileName}>
        {fileName}
      </span>
      <button
        type="button"
        onClick={onOpenExternal}
        title={t('chat.pdfViewer.openExternal')}
        className={cn(
          'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1',
          'focus-visible:ring-2 focus-visible:ring-accent'
        )}
      >
        <LinkSquare02Icon size={14} />
      </button>
      <button
        type="button"
        onClick={onReveal}
        title={t('chat.fileCard.reveal')}
        className={cn(
          'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1',
          'focus-visible:ring-2 focus-visible:ring-accent'
        )}
      >
        <FolderOpenIcon size={14} />
      </button>
      <button
        type="button"
        onClick={onDownload}
        title={t('chat.fileCard.download')}
        className={cn(
          'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1',
          'focus-visible:ring-2 focus-visible:ring-accent'
        )}
      >
        <Download01Icon size={14} />
      </button>
    </div>
  )
}
