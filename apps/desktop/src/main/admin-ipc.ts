/**
 * The admin layer's IPC surface.
 *
 * A thin, deliberately boring bridge: each handler forwards to the org API
 * with the signed-in admin's own token and hands the answer back. It is a
 * separate module rather than more lines in index.ts because it is the one
 * IPC group with a rule of its own —
 *
 *   NOTHING READ HERE TOUCHES DISK.
 *
 * Everything else the desktop fetches is the signed-in employee's own work,
 * and the workspace is their cache of it. This is other people's spend and
 * other people's conversations. Caching any of it would leave the company's
 * transcripts on whichever laptop opened the admin screen, and leave them
 * there after that person stopped being an admin. So the renderer holds it
 * in memory while the screen is open and that is the whole lifetime.
 *
 * The one place that needed care is reading a transcript. Rather than a
 * second renderer for admins, the records are rebuilt into a
 * ConversationFile with `rebuildConversation` — the SAME function restore
 * uses to turn synced records back into a conversation on disk — and handed
 * to the renderer, which maps it with the same `mapConversationMessages`
 * and draws it with the same bubbles the employee saw. Identical input,
 * identical code, identical picture; it simply never reaches the disk.
 */
import * as admin from '@main/cloud/admin'
import { rebuildConversation } from '@main/cloud/restore'
import { cloudSession } from '@main/cloud/session'
import { handle } from '@main/ipc-registry'
import type { ConversationFile } from '@main/conversations'

/** Roles the admin screen exists for. Advisory — the server re-checks. */
const ADMIN_ROLES = new Set(['owner', 'admin', 'support'])

export type AdminAccess = {
  /** Can this device's user open the admin screen at all? */
  canRead: boolean
  /** Can they change anything, or is this the view-only (support) tier? */
  canWrite: boolean
  /** Only an owner may touch roles, or another owner. */
  isOwner: boolean
  role: string | null
  /**
   * The admin's own email — the renderer's way to recognise itself in the
   * roster and not offer to suspend the person using the screen. Email
   * rather than id because the session record exposes email, and the roster
   * carries it on every row, so no extra call is needed to match them up.
   */
  email: string | null
}

function access(): AdminAccess {
  const state = cloudSession.getState()
  const role = state.user?.role ?? null
  return {
    canRead: role !== null && ADMIN_ROLES.has(role),
    canWrite: role === 'owner' || role === 'admin',
    isOwner: role === 'owner',
    role,
    email: state.user?.email ?? null
  }
}

/**
 * Refuse locally what the server would refuse anyway. Not a security
 * boundary — the API re-verifies every call — but it keeps a stale renderer
 * (a window left open across a role change) from firing calls that would
 * come back 403, and it makes the reason legible in one place.
 */
function assertRead(): void {
  if (!access().canRead) throw new Error('forbidden')
}

function assertWrite(): void {
  if (!access().canWrite) throw new Error('forbidden')
}

export type AdminTranscript = {
  conversation: ConversationFile
  owner: { userId: string; name: string | null; email: string | null }
  /** True when the conversation was longer than the read loop's safety valve. */
  truncated: boolean
}

export function registerAdminIpc(): void {
  handle('admin:getAccess', () => access())

  handle('admin:roster', (_e, days?: number) => {
    assertRead()
    return admin.getRoster(days ?? 30)
  })

  handle('admin:userOverview', (_e, userId: string, days?: number) => {
    assertRead()
    return admin.getUserOverview(userId, days ?? 30)
  })

  handle(
    'admin:listConversations',
    (_e, userId: string, opts?: { before?: string; limit?: number }) => {
      assertRead()
      return admin.listConversations(userId, opts ?? {})
    }
  )

  /**
   * One conversation, rebuilt into exactly the file the employee's own
   * client holds. `rebuildConversation` needs the conversation's metadata
   * alongside its records, and the records endpoint returns both.
   */
  handle('admin:readConversation', async (_e, conversationId: string): Promise<AdminTranscript> => {
    assertRead()
    const { records, conversation, truncated } = await admin.readTranscript(conversationId)
    const file = rebuildConversation(
      {
        id: conversation.id,
        title: conversation.title,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at
      },
      records
    )
    return {
      conversation: file,
      owner: {
        userId: conversation.user_id,
        name: conversation.user_name,
        email: conversation.user_email
      },
      truncated
    }
  })

  handle('admin:userAudit', (_e, userId: string, limit?: number) => {
    assertRead()
    return admin.getUserAudit(userId, limit ?? 100)
  })

  handle('admin:audit', (_e, limit?: number) => {
    assertRead()
    return admin.getAudit(limit ?? 100)
  })

  handle('admin:getOrg', () => {
    assertRead()
    return admin.getOrg()
  })

  handle('admin:getGates', () => {
    assertRead()
    return admin.getGates()
  })

  // ── Mutations ──────────────────────────────────────────────────────────

  handle('admin:invite', (_e, input: { email: string; name: string; role: admin.AdminRole }) => {
    assertWrite()
    return admin.inviteUser(input)
  })

  handle(
    'admin:updateUser',
    (
      _e,
      userId: string,
      patch: { name?: string; role?: admin.AdminRole; status?: 'active' | 'suspended' }
    ) => {
      assertWrite()
      return admin.updateUser(userId, patch)
    }
  )

  handle('admin:setPlan', (_e, userId: string, plan: admin.TokenPlan) => {
    assertWrite()
    return admin.setPlan(userId, plan)
  })

  handle(
    'admin:setPolicy',
    (
      _e,
      userId: string,
      policy: {
        allowed_models?: string[] | null
        daily_token_cap?: number | null
        daily_search_cap?: number | null
        token_plan?: admin.TokenPlan | null
      }
    ) => {
      assertWrite()
      return admin.setPolicy(userId, policy)
    }
  )

  handle('admin:resetPassword', (_e, userId: string) => {
    assertWrite()
    return admin.resetPassword(userId)
  })

  handle('admin:clearPin', (_e, userId: string, deviceId?: string) => {
    assertWrite()
    return admin.clearPin(userId, deviceId)
  })

  handle('admin:revokeSessions', (_e, userId: string) => {
    assertWrite()
    return admin.revokeSessions(userId)
  })

  handle('admin:patchOrg', (_e, patch: Parameters<typeof admin.patchOrg>[0]) => {
    assertWrite()
    return admin.patchOrg(patch)
  })
}
