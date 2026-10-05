import { fileViewerPath } from '@tm/shared';

/**
 * Every screen's URL, built in one place (docs/data/app/app.json screens).
 * Page agents link with these instead of hand-writing paths.
 */
export const ACCOUNT_SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'channels', label: 'Channels' },
  { id: 'security', label: 'Security' },
  { id: 'connected-apps', label: 'Connected apps' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'data', label: 'Data & deletion' },
  // §X — whose app this is. Only the admin sees it (the menus filter on
  // `adminOnly`); only the admin can call what it does.
  { id: 'users', label: 'Users', adminOnly: true },
  // §X — what it costs. The admin's other module: this month's estimated bill
  // and today's reads/writes against the free daily quota.
  { id: 'usage', label: 'Usage & cost', adminOnly: true },
] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number]['id'];

/**
 * The sections THIS person sees. §X: Users is the admin's module — one
 * configured address — so it is hidden from everyone else's menus. Hiding is
 * manners, not security: the commands behind it check the address themselves.
 */
export const accountSections = (
  isAdmin: boolean,
): readonly { readonly id: AccountSection; readonly label: string }[] =>
  ACCOUNT_SECTIONS.filter((s) => isAdmin || !('adminOnly' in s && s.adminOnly));

export const BOARD_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'stages', label: 'Stages' },
  { id: 'priorities', label: 'Priorities' },
  { id: 'tags', label: 'Tags' },
  { id: 'fields', label: 'Custom fields' },
  { id: 'templates', label: 'Templates' },
  { id: 'people', label: 'People & roles' },
  { id: 'grants', label: 'Stage grants' },
  { id: 'intake', label: 'Intake' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'danger', label: 'Danger zone' },
] as const;
export type BoardSettingsSection = (typeof BOARD_SETTINGS_SECTIONS)[number]['id'];

const q = (params: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const routes = {
  home: () => '/',
  login: (next?: string) => `/login${q({ next })}`,
  welcome: () => '/welcome',
  invite: (inviteId: string, token: string) => `/invite/${inviteId}.${token}`,
  inbox: (tab?: string) => `/inbox${q({ tab })}`,
  /** Inbox filtered to invitations — the sidebar's 'Invitations' entry. */
  invitations: () => '/inbox?tab=invitations',
  myWork: () => '/me',
  newBoard: () => '/new-board',
  /** A board, optionally a view, optionally with the ticket drawer open. */
  board: (boardKey: string, viewId?: string | null, ticketKey?: string | null) =>
    `/b/${boardKey}${viewId ? `/${viewId}` : ''}${q({ ticket: ticketKey })}`,
  /**
   * People & roles is a SECTION of board settings (agents.html §Q2), not a
   * destination of its own. /b/KEY/people still resolves — that route only
   * redirects here — so links people already have keep working.
   */
  boardPeople: (boardKey: string) => `/b/${boardKey}/settings/people`,
  boardSettings: (boardKey: string, section: BoardSettingsSection = 'general') =>
    `/b/${boardKey}/settings/${section}`,
  /**
   * Phase 17 (agents.html §Y3): what the board's agents cost, day by day. A
   * SECTION of board settings (the sidebar stays a flat list of boards);
   * reached from the board bar's cost chip. /b/KEY/analytics still resolves —
   * it redirects here.
   */
  boardAnalytics: (boardKey: string) => `/b/${boardKey}/settings/analytics`,
  ticket: (ticketKey: string) => `/t/${ticketKey}`,
  account: (section: AccountSection = 'profile') => `/account/${section}`,
  /** The Agents page (sidebar › You) and one agent's page (agents.html §B). */
  agents: () => '/agents',
  agent: (agentId: string) => `/agents/${agentId}`,
  /** A ticket file as a full-window viewer page (agents.html §I). */
  file: (boardKey: string, ticketKey: string, fileId: string) =>
    fileViewerPath(boardKey, ticketKey, fileId),
  oauthConsent: () => '/oauth/consent',
  /**
   * Artifacts (docs/plan/artifacts.html §F). An artifact has no key like a
   * board's — it is opened from the sidebar or a link, never typed — so its id
   * is the URL. The section type lives with the feature (lib/artifacts/store).
   */
  artifacts: () => '/x',
  artifact: (artifactId: string) => `/x/${artifactId}`,
  /** §AB: one of my workspaces — its boards and artifacts on one page. */
  workspace: (workspaceId: string) => `/w/${workspaceId}`,
  artifactSettings: (
    artifactId: string,
    section: 'general' | 'people' | 'boards' | 'builds' | 'data',
  ) => `/x/${artifactId}/settings/${section}`,
  /** Static pages an artifact's author is pointed at (served as files, not SPA routes). */
  integrate: () => '/integrate',
  backendDriver: () => '/backend-driver/',
};

/** Screens drawn WITHOUT the Shell (app.json: no `shell: true`). */
export const NO_SHELL_PREFIXES = [
  '/login',
  '/welcome',
  '/invite',
  '/oauth',
  '/new-board',
  '/t',
  '/f',
];

export function hasShell(pathname: string): boolean {
  return !NO_SHELL_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}
