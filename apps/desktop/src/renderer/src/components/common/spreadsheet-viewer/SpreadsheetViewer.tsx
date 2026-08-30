import { cn } from '@lib/utils/cn'
import { Download01Icon, File01Icon, FolderOpenIcon, LinkSquare02Icon } from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as XLSX from 'xlsx'

export type SpreadsheetViewerProps = {
  filePath: string
  fileExists: boolean
  fileName: string
  sizeBytes: number
}

export function SpreadsheetViewer({
  filePath,
  fileExists,
  fileName
}: SpreadsheetViewerProps): React.JSX.Element {
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
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [activeSheet, setActiveSheet] = useState(0)
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const buffer = await window.api.upload.readFile(filePath)
        if (!buffer) throw new Error(`missing upload: ${filePath}`)
        const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' })
        if (cancelled) return
        setWorkbook(wb)
        setSheetNames(wb.SheetNames)
      } catch {
        if (!cancelled) setError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filePath])

  const html = useMemo(() => {
    if (!workbook) return null
    const name = workbook.SheetNames[activeSheet]
    const sheet = name ? workbook.Sheets[name] : undefined
    return sheet ? XLSX.utils.sheet_to_html(sheet) : null
  }, [workbook, activeSheet])

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
          className="spreadsheet-preview bg-bg text-fg max-h-[400px] overflow-auto p-4 text-xs"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="flex h-[200px] w-full items-center justify-center">
          <span className="text-muted animate-pulse text-xs">
            {t('chat.spreadsheetViewer.loading')}
          </span>
        </div>
      )}
      {sheetNames.length > 1 && (
        <div className="border-border flex gap-1 overflow-x-auto border-t px-2 py-1">
          {sheetNames.map((name, idx) => (
            <button
              key={name}
              type="button"
              onClick={() => setActiveSheet(idx)}
              className={cn(
                'shrink-0 rounded px-2 py-0.5 text-[11px]',
                idx === activeSheet
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted hover:text-fg cursor-pointer'
              )}
            >
              {name}
            </button>
          ))}
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
