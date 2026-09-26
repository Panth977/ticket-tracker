/**
 * The palette's built-in items: screens, account sections, boards. Registered
 * by the Shell; feature areas add their own providers (tickets, people…).
 */
import { get } from 'svelte/store';
import {
  Bell,
  FolderPlus,
  Inbox,
  LayoutGrid,
  Settings,
  SquareCheck,
  SquareKanban,
  User,
} from 'lucide-svelte';
import type { Board } from '@tm/shared';
import { filterItems, palette, type PaletteItem } from '$lib/keyboard/palette.svelte';
import type { QueryState } from '$lib/stores';
import type { Readable } from 'svelte/store';
import { ACCOUNT_SECTIONS, routes } from './routes';

export function registerNavProviders(boards: () => Readable<QueryState<Board>> | null): () => void {
  const screens: PaletteItem[] = [
    {
      id: 'nav-inbox',
      label: 'Inbox',
      icon: Inbox,
      href: routes.inbox(),
      keywords: 'notifications mentions',
    },
    {
      id: 'nav-me',
      label: 'My work',
      icon: SquareCheck,
      href: routes.myWork(),
      keywords: 'assigned mine',
    },
    {
      id: 'nav-boards',
      label: 'All boards',
      icon: LayoutGrid,
      href: routes.home(),
      keywords: 'archived home',
    },
    {
      id: 'nav-new-board',
      label: 'New board',
      icon: FolderPlus,
      href: routes.newBoard(),
      keywords: 'create',
    },
    {
      id: 'nav-notif',
      label: 'Notification settings',
      icon: Bell,
      href: routes.account('notifications'),
    },
    ...ACCOUNT_SECTIONS.map((s) => ({
      id: `nav-acct-${s.id}`,
      label: `Account: ${s.label}`,
      icon: User,
      href: routes.account(s.id),
    })),
  ];
  const offs = [
    palette.register({
      id: 'nav',
      group: 'Go to',
      order: 50,
      search: (q) => filterItems(q, screens),
    }),
    palette.register({
      id: 'boards',
      group: 'Boards',
      order: 10,
      search: (q) => {
        const s = boards();
        const list = s ? get(s).data.filter((b) => b.archivedAt == null) : [];
        const items: PaletteItem[] = list.flatMap((b) => [
          {
            id: `b-${b.id}`,
            label: b.name,
            hint: b.key,
            icon: SquareKanban,
            href: routes.board(b.key),
            keywords: b.key,
          },
          ...(q
            ? [
                {
                  id: `b-${b.id}-people`,
                  label: `${b.name} › Settings › People`,
                  hint: b.key,
                  icon: User,
                  href: routes.boardPeople(b.key),
                  keywords: `${b.key} members roles invite`,
                },
                {
                  id: `b-${b.id}-settings`,
                  label: `${b.name} › Settings`,
                  hint: b.key,
                  icon: Settings,
                  href: routes.boardSettings(b.key),
                  keywords: b.key,
                },
              ]
            : []),
        ]);
        return filterItems(q, items);
      },
    }),
  ];
  return () => offs.forEach((o) => o());
}
