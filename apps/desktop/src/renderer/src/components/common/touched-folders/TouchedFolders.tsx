import type { TouchedFolder } from '@lib/touched-folders/touchedFolders'
import { cn } from '@lib/utils/cn'
import { isMac } from '@lib/utils/platform'
import { Folder01Icon } from 'hugeicons-react'
import { useTranslation } from 'react-i18next'

/**
 * The folders this conversation has changed files in, as a strip of chips
 * laid over the transcript's top edge — starting after the leading glass
 * disc, on the row the FloatingChrome owns, ending before the trailing disc.
 * One chip per folder (its path relative to the working folder, with the
 * number of files changed there); click opens the folder in the system
 * file manager. The strip never wraps: it scrolls on x, scrollbar hidden,
 * so a run that touches twenty folders costs the transcript no height.
 *
 * Fed by collectTouchedFolders over the persisted segments, so the chips
 * are identical live, after the turn and on a reopened conversation.
 */
export function TouchedFolders({
  folders
}: {
  folders: TouchedFolder[]
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (folders.length === 0) return null
  return (
    <div
      role="list"
      aria-label={t('chat.touchedFolders.label')}
      className={cn(
        // Same row as the floating discs (FloatingChrome): mac clears the
        // traffic lights at top-12/px-3, other platforms sit at top-6/px-4.
        // The start/end padding clears a 40px disc plus its gap on each side.
        'pointer-events-none fixed inset-x-0 z-20 flex h-10 items-center',
        isMac ? 'top-12 ps-[3.75rem] pe-[3.75rem]' : 'top-6 ps-[4rem] pe-[4rem]'
      )}
    >
      <div
        className={cn(
          'pointer-events-auto flex max-w-full flex-nowrap items-center gap-2 overflow-x-auto',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
      >
        {folders.map((folder) => (
          <button
            key={folder.path}
            type="button"
            role="listitem"
            onClick={() => void window.api.upload.revealPath(folder.path)}
            title={`${folder.path}\n${t('chat.touchedFolders.chip', { count: folder.files })}`}
            className={cn(
              'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
              'border-border bg-bg/40 text-fg backdrop-blur-md hover:bg-bg/60 active:opacity-60',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          >
            <Folder01Icon size={13} className="text-accent shrink-0" aria-hidden />
            <span dir="ltr" className="max-w-[16rem] truncate">
              {folder.label}
            </span>
            <span className="text-muted tabular-nums">{folder.files}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
