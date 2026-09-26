/**
 * Which file the in-app viewer shows. Cards anywhere in the drawer call
 * fileViewer.open(file, siblings); the drawer's viewer host renders the
 * overlay, preferring the ticket's live file list for prev / next (so ←/→
 * walks every file on the ticket, agents.html §I) and falling back to the
 * siblings given (a message's attachments not yet listed).
 */
import type { ViewerFile } from './types';

class FileViewerState {
  /** The shown file's id, or null (closed). */
  current = $state<string | null>(null);
  /** The list the file was opened from (fallback when the ticket's list doesn't hold it yet). */
  siblings = $state<ViewerFile[]>([]);

  open(file: ViewerFile, siblings: readonly ViewerFile[] = [file]) {
    this.siblings = siblings.some((f) => f.id === file.id) ? [...siblings] : [file, ...siblings];
    this.current = file.id;
  }

  close() {
    this.current = null;
    this.siblings = [];
  }
}

export const fileViewer = new FileViewerState();

/**
 * The files for prev / next: the ticket's live list (oldest first, deleted
 * ones out) when it holds the current file, else the siblings.
 */
export function viewerList(
  current: string | null,
  ticketFiles: readonly ViewerFile[],
  siblings: readonly ViewerFile[],
): ViewerFile[] {
  if (current && ticketFiles.some((f) => f.id === current)) {
    return [...ticketFiles].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }
  return [...siblings];
}
