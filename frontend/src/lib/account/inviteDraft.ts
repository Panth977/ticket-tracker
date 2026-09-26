/**
 * The 'Invite people (email + role)' rows on /new-board: parse what was
 * typed or pasted into rows, and validate them before inviteCreate.
 */
import { BOARD_ROLES, EmailSchema, type BoardRole, MAX_INVITES_PER_CALL } from '@tm/shared';

export interface InviteDraft {
  email: string;
  role: BoardRole;
}

/** Split a paste like 'a@x.com, b@y.com; c@z.com' into trimmed addresses. */
export function splitEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^<|>$/g, ''))
    .filter(Boolean);
}

export function isEmail(s: string): boolean {
  return EmailSchema.safeParse(s).success;
}

/**
 * Add addresses to the list: lower-cased, de-duplicated, own address skipped.
 * Returns the new list and anything that was not an address.
 */
export function addInvites(
  list: InviteDraft[],
  text: string,
  role: BoardRole,
  selfEmail?: string | null,
): { list: InviteDraft[]; rejected: string[] } {
  const seen = new Set(list.map((d) => d.email));
  const self = selfEmail?.toLowerCase();
  const rejected: string[] = [];
  const out = [...list];
  for (const raw of splitEmails(text)) {
    const email = raw.toLowerCase();
    if (!isEmail(email)) {
      rejected.push(raw);
      continue;
    }
    if (email === self || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, role });
  }
  return { list: out.slice(0, MAX_INVITES_PER_CALL), rejected };
}

export const ROLE_LABELS: Record<BoardRole, string> = {
  admin: 'Admin',
  editor: 'Editor',
  commenter: 'Commenter',
  viewer: 'Viewer',
};

export const ROLE_OPTIONS = BOARD_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));
