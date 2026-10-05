/**
 * WHERE YOU CAME FROM (agents.html §AB3). Opening a board or an artifact from
 * a workspace — its sidebar group or its page — sets this; opening one from
 * the sidebar's root lists, "All boards" or "All artifacts" clears it. While
 * it is set and the open board is IN that workspace, the board header shows
 * "Workspace › Board" and the board switcher lists only the workspace's
 * boards and artifacts.
 *
 * Per tab (sessionStorage): two tabs can be in two workspaces. Kept out of the
 * URL on purpose, so every in-board link (views, tickets, settings) keeps it
 * without carrying a parameter.
 */
const KEY = 'tm.workspace';

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

class WorkspaceContext {
  id = $state<string | null>(typeof sessionStorage === 'undefined' ? null : read());

  enter(id: string) {
    this.id = id;
    try {
      sessionStorage.setItem(KEY, id);
    } catch {
      /* private mode: per page load only */
    }
  }

  leave() {
    this.id = null;
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}

export const workspaceContext = new WorkspaceContext();
