/**
 * ⌘K providers this feature adds to the palette (the Shell already registers
 * screens + boards, lib/layout/navProviders):
 *   Tickets   — full-text over every board I can read (./tickets)
 *   Commands  — things you DO: mark all read, turn on notifications, theme,
 *               inbox tabs, sign out
 *
 * Reference-counted: mount <SearchProviders/> anywhere (Shell, pages); the
 * providers live while at least one is mounted.
 */
import { get } from 'svelte/store';
import {
  AtSign,
  BellRing,
  CheckCheck,
  Clock,
  FileText,
  LogOut,
  Mail,
  Monitor,
  Moon,
  Sun,
  UserPlus,
} from 'lucide-svelte';
import type { Theme } from '@tm/shared';
import { command } from '$lib/api';
import { auth } from '$lib/firebase/auth.svelte';
import { filterItems, palette, type PaletteItem } from '$lib/keyboard/palette.svelte';
import { routes } from '$lib/layout/routes';
import { markRead } from '$lib/notifications/actions';
import { boardKeyOf } from '$lib/notifications/inbox';
import { push } from '$lib/notifications/push.svelte';
import { inboxUnread, myBoards } from '$lib/stores/app';
import { toast } from '$lib/ui/toast.svelte';
import { searchTickets } from './tickets';

// 'cancelled' is the pre-phase-6 value still on disk until the migration runs: it reads as archived.
const STATE_HINT: Record<string, string> = { archived: 'archived', cancelled: 'archived' };

async function ticketItems(q: string): Promise<PaletteItem[]> {
  const uid = auth.uid;
  const boards = uid
    ? new Map(get(myBoards(uid)).data.map((b) => [b.id, b.name]))
    : new Map<string, string>();
  const hits = await searchTickets(q, { limit: 8 });
  return hits.map((t) => ({
    id: `t-${t.id}`,
    label: `${t.key} ${t.title}`,
    hint: STATE_HINT[t.state] ?? boards.get(t.boardId) ?? boardKeyOf(t.key),
    icon: FileText,
    href: routes.board(boardKeyOf(t.key), null, t.key),
    keywords: t.key,
  }));
}

function commandItems(): PaletteItem[] {
  const uid = auth.uid;
  const theme = (t: Theme) => async () => {
    await command('profileUpdate', { theme: t }, { toast: 'Could not change the theme' });
  };
  const items: PaletteItem[] = [
    {
      id: 'cmd-mark-all-read',
      label: 'Mark all notifications read',
      icon: CheckCheck,
      keywords: 'inbox clear',
      run: async () => {
        if (!uid) return;
        const ids = get(inboxUnread(uid)).data.map((r) => r.id);
        if (await markRead(uid, ids))
          toast.success(ids.length ? `Marked ${ids.length} read` : 'Nothing unread');
      },
    },
    {
      id: 'cmd-inbox-mentions',
      label: 'Inbox: Mentions',
      icon: AtSign,
      href: routes.inbox('mentions'),
      keywords: 'notifications',
    },
    {
      id: 'cmd-inbox-assigned',
      label: 'Inbox: Assigned to me',
      icon: UserPlus,
      href: routes.inbox('assigned'),
    },
    {
      id: 'cmd-inbox-invites',
      label: 'Inbox: Invitations',
      icon: Mail,
      href: routes.invitations(),
      keywords: 'invite join',
    },
    {
      id: 'cmd-inbox-snoozed',
      label: 'Inbox: Snoozed',
      icon: Clock,
      href: routes.inbox('snoozed'),
    },
    {
      id: 'cmd-theme-light',
      label: 'Theme: Light',
      icon: Sun,
      keywords: 'appearance',
      run: theme('light'),
    },
    {
      id: 'cmd-theme-dark',
      label: 'Theme: Dark',
      icon: Moon,
      keywords: 'appearance',
      run: theme('dark'),
    },
    {
      id: 'cmd-theme-system',
      label: 'Theme: System',
      icon: Monitor,
      keywords: 'appearance auto',
      run: theme('system'),
    },
  ];
  push.sync();
  if (uid && push.permission === 'default') {
    items.push({
      id: 'cmd-push-on',
      label: 'Turn on browser notifications',
      icon: BellRing,
      keywords: 'push desktop alerts',
      run: async () => {
        if (await push.enable(uid)) toast.success('Browser notifications are on');
        else if (push.permission === 'denied')
          toast.info('Notifications are blocked', 'Allow them in your browser’s site settings.');
      },
    });
  }
  items.push({
    id: 'cmd-sign-out',
    label: 'Sign out',
    icon: LogOut,
    keywords: 'log out logout',
    run: async () => {
      await auth.signOut();
      location.assign(routes.login());
    },
  });
  return items;
}

let refs = 0;
let off: (() => void) | null = null;

export function retainSearchProviders(): () => void {
  if (refs++ === 0) {
    const offs = [
      palette.register({
        id: 'tickets',
        group: 'Tickets',
        order: 5,
        minQuery: 1,
        search: ticketItems,
      }),
      palette.register({
        id: 'commands',
        group: 'Commands',
        order: 60,
        minQuery: 1,
        search: (q) => filterItems(q, commandItems()),
      }),
    ];
    off = () => offs.forEach((o) => o());
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--refs === 0) {
      off?.();
      off = null;
    }
  };
}
