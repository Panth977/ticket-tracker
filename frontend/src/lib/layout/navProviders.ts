/**
 * The palette's built-in items: screens, account sections, boards. Registered
 * by the Shell; feature areas add their own providers (tickets, people…).
 */
import { get } from 'svelte/store';
import {
  Bell,
  BookA,
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
  BUCKET_DEFAULT_INDICATOR,
  DICTIONARY_DEFAULT_INDICATOR,
  descriptionText,
  type Artifact,
  type Board,
  type Bucket,
  type Dictionary,
  type Org,
} from '@tm/shared';
import { filterItems, palette, type PaletteItem } from '$lib/keyboard/palette.svelte';
import type { QueryState } from '$lib/stores';
import type { Readable } from 'svelte/store';
import { ACCOUNT_SECTIONS, routes } from './routes';

export function registerNavProviders(
  boards: () => Readable<QueryState<Board>> | null,
  /** Artifacts I have a role on (artifacts.html §F: ⌘K finds them by name). */
  artifacts: () => Readable<QueryState<Artifact>> | null = () => null,
  /** My orgs (agents.html §AC): ⌘K opens one by name. */
  orgs: () => Readable<QueryState<Org>> | null = () => null,
  /** My buckets (bucket.html §F): ⌘K opens one by name. */
  buckets: () => Readable<QueryState<Bucket>> | null = () => null,
  /** My dictionaries (dictionary.html): ⌘K opens one by name. */
  dictionaries: () => Readable<QueryState<Dictionary>> | null = () => null,
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
      id: 'nav-bucket',
      label: 'All bucket',
      icon: Brain,
      href: routes.buckets(),
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
      id: 'buckets',
      group: 'Bucket',
      order: 13,
      search: (q) => {
        const s = buckets();
        const list = s ? get(s).data.filter((m) => m.archivedAt == null) : [];
        return filterItems(
          q,
          list.map((m) => ({
            id: `m-${m.id}`,
            label: m.name,
            hint: m.description ?? undefined,
            icon: Brain,
            indicator: { of: m, seed: m.id, fallback: BUCKET_DEFAULT_INDICATOR },
            href: routes.bucket(m.id),
            keywords: 'bucket files bucket',
          })),
        );
      },
    }),
    palette.register({
      id: 'dictionaries',
      group: 'Dictionaries',
      order: 14,
      search: (q) => {
        const s = dictionaries();
        const list = s ? get(s).data.filter((d) => d.archivedAt == null) : [];
        return filterItems(
          q,
          list.map((d) => ({
            id: `d-${d.id}`,
            label: d.name,
            hint: d.description ?? undefined,
            icon: BookA,
            indicator: { of: d, seed: d.id, fallback: DICTIONARY_DEFAULT_INDICATOR },
            href: routes.dictionary(d.id),
            keywords: 'dictionary env settings keys values',
          })),
        );
      },
    }),
    palette.register({
      id: 'orgs',
      group: 'Orgs',
      order: 11,
      search: (q) => {
        const s = orgs();
        return filterItems(
          q,
          (s ? get(s).data : []).map((w) => ({
            id: `o-${w.id}`,
            label: w.name,
            hint: `@${w.handle} · ${w.memberUids.length} members`,
            icon: Layers,
            indicator: { of: w, seed: w.id },
            href: routes.owner(w.handle),
            keywords: `org team ${w.handle} ${w.description ?? ''}`,
          })),
        );
      },
    }),
  ];
  return () => offs.forEach((o) => o());
}
