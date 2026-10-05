/**
 * The palette's built-in items: screens, account sections, boards. Registered
 * by the Shell; feature areas add their own providers (tickets, people…).
 */
import { get } from 'svelte/store';
import {
  Bell,
  Brain,
  FolderPlus,
  Layers,
  Inbox,
  AppWindow,
  LayoutGrid,
  Settings,
  SquareCheck,
  SquareKanban,
  User,
} from 'lucide-svelte';
import {
  MEMORY_DEFAULT_INDICATOR,
  descriptionText,
  type Artifact,
  type Board,
  type Memory,
  type Workspace,
} from '@tm/shared';
import { filterItems, palette, type PaletteItem } from '$lib/keyboard/palette.svelte';
import type { QueryState } from '$lib/stores';
import type { Readable } from 'svelte/store';
import { ACCOUNT_SECTIONS, routes } from './routes';

export function registerNavProviders(
  boards: () => Readable<QueryState<Board>> | null,
  /** Artifacts I have a role on (artifacts.html §F: ⌘K finds them by name). */
  artifacts: () => Readable<QueryState<Artifact>> | null = () => null,
  /** My workspaces (agents.html §AB): ⌘K opens one by name. */
  workspaces: () => Readable<QueryState<Workspace>> | null = () => null,
  /** My memories (memory.html §F): ⌘K opens one by name. */
  memories: () => Readable<QueryState<Memory>> | null = () => null,
): () => void {
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
      id: 'nav-artifacts',
      label: 'All artifacts',
      icon: AppWindow,
      href: routes.artifacts(),
      keywords: 'apps dashboards archived',
    },
    {
      id: 'nav-memory',
      label: 'All memory',
      icon: Brain,
      href: routes.memories(),
      keywords: 'files bucket drive assets notes',
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
            indicator: { of: b, seed: b.id },
            href: routes.board(b.key),
            keywords: `${b.key} ${descriptionText(b.description) ?? ''}`,
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
    palette.register({
      id: 'artifacts',
      group: 'Artifacts',
      order: 12,
      search: (q) => {
        const s = artifacts();
        const list = s ? get(s).data.filter((a) => a.archivedAt == null) : [];
        return filterItems(
          q,
          list.map((a) => ({
            id: `x-${a.id}`,
            label: a.name,
            hint: a.description ?? undefined,
            icon: AppWindow,
            indicator: { of: a, seed: a.id },
            href: routes.artifact(a.id),
            keywords: 'artifact app',
          })),
        );
      },
    }),
    palette.register({
      id: 'memories',
      group: 'Memory',
      order: 13,
      search: (q) => {
        const s = memories();
        const list = s ? get(s).data.filter((m) => m.archivedAt == null) : [];
        return filterItems(
          q,
          list.map((m) => ({
            id: `m-${m.id}`,
            label: m.name,
            hint: m.description ?? undefined,
            icon: Brain,
            indicator: { of: m, seed: m.id, fallback: MEMORY_DEFAULT_INDICATOR },
            href: routes.memory(m.id),
            keywords: 'memory files bucket',
          })),
        );
      },
    }),
    palette.register({
      id: 'workspaces',
      group: 'Workspaces',
      order: 11,
      search: (q) => {
        const s = workspaces();
        return filterItems(
          q,
          (s ? get(s).data : []).map((w) => ({
            id: `w-${w.id}`,
            label: w.name,
            hint: `${w.boardIds.length} boards · ${w.artifactIds.length} artifacts`,
            icon: Layers,
            indicator: { of: w, seed: w.id },
            href: routes.workspace(w.id),
            keywords: `workspace group ${w.description ?? ''}`,
          })),
        );
      },
    }),
  ];
  return () => offs.forEach((o) => o());
}
