import { ConversationsSheet } from '@components/common/floating-chrome/ConversationsSheet'
import { glassButtonClass } from '@components/common/floating-chrome/glass'
import { NewChatButton } from '@components/common/new-chat-button/NewChatButton'
import { ProjectDialog } from '@components/common/project-dialog/ProjectDialog'
import { cn } from '@lib/utils/cn'
import { isMac } from '@lib/utils/platform'
import { useSessions } from '@providers/sessions/useSessions'
import { Menu01Icon } from 'hugeicons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The chat screen's floating chrome — the desktop port of the mobile app's
 * two glass discs laid over the transcript (no rails, no header):
 *
 * - Leading disc: opens the ConversationsSheet (all pages + the full
 *   conversations list).
 * - Trailing disc: New chat (click) with the projects hover card, exactly the
 *   control that used to ride the composer's end edge. In project mode the
 *   disc swaps to the project's emoji and opens the manage dialog (edit /
 *   files / new conversation / exit) — the same conditional the composer slot
 *   carried.
 *
 * Rendered ONCE at app level (inside the chatVisible gate that held the old
 * conversations rail), never per Chat instance: the sheet holds list state
 * and the dialog holds draft state, and `activeProject` in the sessions
 * provider is by construction the ACTIVE session's project.
 */
export function FloatingChrome(): React.JSX.Element {
  const { t } = useTranslation()
  const { newSession, activeProject, setActiveProject, activeConversationId, runStatuses } =
    useSessions()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  // The dialog's `busy` lock (instructions/files frozen under a running turn):
  // the active conversation's live phase is the app-level equivalent of the
  // old per-session `streaming` flag.
  const busy =
    activeConversationId !== null && runStatuses[activeConversationId]?.phase === 'processing'

  return (
    <>
      {/* macOS clears the traffic lights at top-12/px-3; Windows/Linux keep
          their native titlebar above the webview, so the discs ride higher and
          get a touch more breathing room from the window edges. */}
      <div
        className={cn(
          'pointer-events-none fixed inset-x-0 z-30 flex items-center justify-between',
          isMac ? 'top-12 px-3' : 'top-6 px-4'
        )}
      >
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          title={t('chat.conversations')}
          aria-label={t('chat.conversations')}
          className={glassButtonClass}
        >
          <Menu01Icon size={18} />
        </button>
        {activeProject ? (
          <button
            type="button"
            onClick={() => setProjectDialogOpen(true)}
            title={activeProject.title.trim() || t('projects.untitled')}
            aria-label={t('projects.project')}
            className={glassButtonClass}
          >
            <span aria-hidden className="text-base leading-none">
              {activeProject.icon || '📁'}
            </span>
          </button>
        ) : (
          <NewChatButton
            onNew={() => newSession()}
            onNewInProject={(projectId) => newSession({ projectId })}
          />
        )}
      </div>
      {sheetOpen && <ConversationsSheet onClose={() => setSheetOpen(false)} />}
      <ProjectDialog
        project={projectDialogOpen ? activeProject : null}
        onClose={() => setProjectDialogOpen(false)}
        onChanged={setActiveProject}
        busy={busy}
        onNewConversation={(p) => {
          setProjectDialogOpen(false)
          newSession({ projectId: p.id })
        }}
        // Close = leave project mode and land in a fresh plain chat, right
        // here — no detour to the Projects page. newSession() without a
        // projectId both spawns/refocuses the blank session and clears the
        // active project (syncProjectFor(null)).
        onExitProject={() => {
          setProjectDialogOpen(false)
          newSession()
        }}
      />
    </>
  )
}
