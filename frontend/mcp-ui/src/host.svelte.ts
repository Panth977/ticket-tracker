/**
 * The page's one link to the outside: the MCP Apps host (Claude). Everything
 * the page reads or changes goes through callServerTool — the same tools the
 * model has, acting with the person's own grant. There is no fetch, no
 * Firebase and no token here.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type { View } from './types';

class Host {
  /** What is on screen: the payload of a show_* tool. */
  view = $state<View | null>(null);
  /** Earlier screens, for Back (a ticket opened from the board). */
  stack = $state<View[]>([]);
  error = $state<string | null>(null);
  busy = $state(false);
  fullscreen = $state(false);
  canFullscreen = $state(false);
  insets = $state({ top: 0, right: 0, bottom: 0, left: 0 });

  private app = new App(
    { name: 'TaskManager', version: '1.0.0' },
    { availableDisplayModes: ['inline', 'fullscreen'] },
  );

  async start() {
    this.app.ontoolresult = (r) => {
      const v = r.structuredContent as View | undefined;
      if (v?.view) {
        this.view = v;
        this.stack = [];
      } else if (r.isError) this.error = textOf(r) ?? 'Something went wrong';
    };
    this.app.onhostcontextchanged = (c) => this.context(c);
    await this.app.connect();
    const c = this.app.getHostContext();
    if (c) this.context(c);
  }

  private context(c: McpUiHostContext) {
    if (c.theme) applyDocumentTheme(c.theme);
    if (c.styles?.variables) applyHostStyleVariables(c.styles.variables);
    if (c.styles?.css?.fonts) applyHostFonts(c.styles.css.fonts);
    if (c.displayMode) this.fullscreen = c.displayMode === 'fullscreen';
    if (c.availableDisplayModes)
      this.canFullscreen = c.availableDisplayModes.includes('fullscreen');
    if (c.safeAreaInsets) this.insets = c.safeAreaInsets;
  }

  /** Call a server tool; its JSON answer (structuredContent, else the text parsed). */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    this.error = null;
    const r = await this.app.callServerTool({ name, arguments: args });
    if (r.isError) {
      const msg = textOf(r) ?? `${name} failed`;
      this.error = msg;
      throw new Error(msg);
    }
    if (r.structuredContent) return r.structuredContent as T;
    const t = textOf(r);
    try {
      return JSON.parse(t ?? 'null') as T;
    } catch {
      return t as T;
    }
  }

  /** Run an action, then reload what is on screen. */
  async act(name: string, args: Record<string, unknown>) {
    this.busy = true;
    try {
      await this.call(name, args);
      await this.reload();
    } catch {
      /* error is shown */
    } finally {
      this.busy = false;
    }
  }

  async reload() {
    const v = this.view;
    if (!v) return;
    const next =
      v.view === 'board'
        ? await this.call<View>('show_board', { board: v.board.key })
        : v.view === 'ticket'
          ? await this.call<View>('show_ticket', { key: v.ticket.key })
          : await this.call<View>('show_my_work');
    this.view = next;
  }

  /** Drill into a ticket; full screen first, since inline cards are not for drill-ins. */
  async openTicket(key: string) {
    this.busy = true;
    try {
      const next = await this.call<View>('show_ticket', { key });
      if (this.view) this.stack = [...this.stack, this.view];
      this.view = next;
      if (!this.fullscreen && this.canFullscreen) await this.setFullscreen(true);
    } catch {
      /* error is shown */
    } finally {
      this.busy = false;
    }
  }

  back() {
    const prev = this.stack.at(-1);
    if (!prev) return;
    this.stack = this.stack.slice(0, -1);
    this.view = prev;
    void this.reload();
  }

  async setFullscreen(on: boolean) {
    const r = await this.app.requestDisplayMode({ mode: on ? 'fullscreen' : 'inline' });
    this.fullscreen = r.mode === 'fullscreen';
  }

  open(url: string) {
    void this.app.openLink({ url });
  }

  /** Hand a request to Claude, as if the person typed it. */
  ask(text: string) {
    void this.app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
  }
}

function textOf(r: { content?: { type: string; text?: string }[] }): string | undefined {
  return r.content?.find((c) => c.type === 'text')?.text;
}

export const host = new Host();
