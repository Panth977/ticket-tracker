# Frontend conventions for page agents

web-core owns everything below `lib/{firebase,stores,api,ui,layout,people,keyboard}`,
the root `+layout.*`, `app.css` / `app.html`. Need a change there? Add a
`REQUEST web-core: …` task. Don't fork it locally.

## Layout, auth, routing

- The root layout boots auth, runs the route guard, and draws the **Shell** (sidebar, ⌘K, toasts,
  'Saving…', offline notice) around every screen except `/login /welcome /invite /oauth /new-board /t/…`
  (`lib/layout/routes.ts › NO_SHELL_PREFIXES`). Pages render only their content column.
- Guard: signed out → `/login?next=…`, first sign-in / no `users/{uid}` → `/welcome`. `/login` sends a
  signed-in person to `next` (read it with `safeNext` from `$lib/firebase/guard`).
- `import { auth } from '$lib/firebase/auth.svelte'`: `auth.uid`, `auth.user` (email, emailVerified),
  `auth.profile` (live `users/{uid}`), `signInWithGoogle()`, `signInWithMicrosoft()`,
  `sendEmailLink(email, next)`, `isEmailLink()`, `completeEmailLink(href, email?)` (returns `'needEmail'` when the
  link is opened on another device), `signOut()`. **Welcome must call `auth.finishWelcome()` when done.**
- Build URLs with `routes` from `$lib/layout/routes` (`routes.board(key, viewId, ticketKey)`,
  `routes.ticket(key)`, `routes.boardSettings(key, 'people')`, `routes.account('tokens')`…). Section ids:
  `ACCOUNT_SECTIONS`, `BOARD_SETTINGS_SECTIONS`. Sidebar links you must honour:
  `/inbox?tab=invitations`. The sidebar is a flat list of boards (agents.html §Q1): a board row goes straight to
  `routes.board(key, prefs.lastViewId ?? board.defaultViewId)`. Views, People and Settings are on the board page —
  `routes.boardPeople(key)` IS `/b/KEY/settings/people`, and `/b/KEY/people` only redirects there.

## Reading data: live stores (`$lib/stores`)

- `docStore<T>(path)` → `{ loading, error, data: (T & { id }) | null, exists, fromCache }`.
- `queryStore<T>({ path, where, orderBy, limit, group })` → `{ loading, error, data: (T & { id })[] }`.
- Same path/spec = one shared, ref-counted `onSnapshot`; it closes 2 s after the last subscriber leaves.
  Always build paths with `paths.*` from `@tm/shared`. A `null` path/spec gives an idle store.
- Ready-made queries (rule-provable): `myBoards(uid)`, `boardByKey(uid, key)`, `myInvites(email)`,
  `inboxUnread(uid)`, `boardViews(boardId, uid)` (shared ∪ mine), `boardPref(boardId, uid)`.
- In components: `const board = $derived(boardByKey(auth.uid, page.params.boardKey));` then `$board.board`.
- People: `person(uid)` from `$lib/people/person` → `{ loading, person: { name, email, avatarUrl, deleted } }`.
  Display people with `<PersonChip uid={…} layout="inline|stacked|compact" />` — never a raw uid or email alone.

## Writing: `command()` (`$lib/api`)

```ts
import { command, isAppError } from '$lib/api';
const { boardId } = await command('boardCreate', { name, key, template: 'kanban' });
await command(
  'ticketUpdate',
  { boardId, ticketId, patch: { title } },
  {
    optimistic: { path: paths.ticket(boardId, ticketId), patch: { title } }, // null patch = hide the doc
  },
);
```

- Typed from `COMMANDS` (input = `CommandReq<N>` without `clientId`, result = `CommandRes<N>`). Input is
  zod-validated before sending. Every write goes through here: never write Firestore directly
  (the one exception is `users/{uid}/devices`, `inbox` read/archive/snooze fields, and `reads/`, which rules allow).
- Failure: throws `AppError` (`err.code`: `invalid | forbidden | not_found | conflict | gone | unprocessable | …`,
  `err.message`, `err.details` for extras like `missing`, `current`). The optimistic patch is rolled back and a toast
  shown. Pass `{ toast: false }` to handle it yourself, or `{ toast: 'Could not move ticket' }` for a headline.
- Offline: refused immediately (`unavailable`). Pass `clientId` yourself only when retrying the same change.

## UI kit (`$lib/ui`)

Button, IconButton, Input, Textarea, Select, Checkbox, Menu (+ `MenuItem`), Popover, Dialog, Drawer, Tabs,
Tooltip, Avatar, PersonChip, Badge, Toaster/`toast`, Skeleton, EmptyState, Kbd, DatePicker (Millis + allDay, in
`auth.profile.timezone`), ColorSwatch (+ `PALETTE` picker), Field. Icons: `lucide-svelte`.
Colours come from tokens only: `bg-bg bg-surface bg-surface-2 border-line text-text text-muted text-subtle
bg-accent text-accent-fg bg-accent-soft text-danger bg-danger-soft text-success text-warning shadow-pop`.
Light/dark/system follow the profile's `theme` automatically.

## Keyboard (`$lib/keyboard`)

- `useShortcut('c', () => openQuickAdd(), { description: 'New ticket' })` binds for the component's lifetime
  (newest binding wins; return `false` to pass). Plain keys are ignored while typing unless `{ inInputs: true }`.
- The shell owns `mod+k` (palette) and `/` (focuses the element marked `data-search`, else opens the palette).
  Pages own: `c` new ticket (board), `j`/`k` list movement, `e` archive / `s` snooze (inbox), `mod+enter` send (composer).
- Add palette results: `palette.register({ id: 'tickets', group: 'Tickets', minQuery: 1, search: async (q) => [...] })`
  in an `$effect` (returns the unregister). Items have `href` or `run()`.

## Placeholders (replace, don't extend)

- Every screen route has a `+page.svelte` rendering `<Placeholder …/>`; the owning step replaces the file.
- Cross-owner components with FINAL props:
  `lib/ticket/TicketDrawer.svelte` → `<TicketDrawer ticketKey="ENG-42" onClose={…} />` (web-ticket), and
  `lib/board/PeopleAndRoles.svelte` → `<PeopleAndRoles boardId={…} />` (web-board).
