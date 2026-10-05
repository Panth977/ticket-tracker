/**
 * MCP APPS — the TaskManager UI inside the Claude chat (web, desktop, phone).
 *
 * The extension (modelcontextprotocol/ext-apps): a tool whose _meta names a
 * ui:// resource is rendered by the host as that HTML, in a sandboxed frame
 * (a WebView on the phone), fed the tool's structuredContent. The frame has
 * no network and no Firebase session — everything it shows or does goes back
 * through THIS connection with app.callServerTool, so it acts with exactly the
 * person's OAuth grant, like every other tool.
 *
 *   show_board    the board as a kanban: columns by stage, move, add, open
 *   show_ticket   one ticket: details, thread, move, assign me, comment
 *   show_my_work  what is assigned to me across boards, overdue first
 *
 * The page is ONE self-contained file (frontend/mcp-ui, built by
 * `pnpm --filter ./frontend mcp-ui:build` into mcpUiHtml.gen.ts): inline JS
 * and CSS, so it needs no CSP allowance at all. The text content of each
 * result stays for hosts that do not render apps (Claude Code).
 */
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  hasScope,
  isAgentId,
  paths,
  type BoardWithId,
  type Scope,
  type Ticket,
  type TicketWithId,
} from '@tm/shared';
import { readableBoards, requestBoard, ticketByKey } from '../platform/resolve.js';
import { boardView, ticketDetail } from '../platform/v1.js';
import type { ServerCtx } from '../runtime/context.js';
import { db } from '../runtime/firebase.js';
import { toAppError } from '../runtime/runner.js';
import { withTicketId } from '../tickets/access.js';
import { MCP_UI_HTML } from './mcpUiHtml.gen.js';

export const UI_URI = 'ui://taskmanager/app';

/** mcp.ts's list row builder (kept there, where the other tools use it). */
export type Briefs = (
  boards: Map<string, BoardWithId>,
  ts: TicketWithId[],
) => Promise<Record<string, unknown>[]>;

const MAX_BOARD_TICKETS = 400;

function result(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}
function fail(e: unknown): CallToolResult {
  const err = toAppError(e);
  return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
}

const can = (ctx: ServerCtx, s: Scope) => !ctx.scopes || hasScope(ctx.scopes, s);

/** What the page may offer, so it never shows a button the grant would refuse. */
const abilities = (ctx: ServerCtx) => ({
  move: can(ctx, 'tickets:move'),
  assign: can(ctx, 'tickets:assign'),
  create: can(ctx, 'tickets:create'),
  comment: can(ctx, 'comments:write'),
});

export function registerUiTools(server: McpServer, ctx: ServerCtx, briefs: Briefs): void {
  // A person looks at a chat; an agent's token runs headless, so it gets none of this.
  if (!can(ctx, 'tickets:read') || isAgentId(ctx.actor)) return;
  const ui = { ui: { resourceUri: UI_URI } };

  registerAppResource(
    server,
    'TaskManager',
    UI_URI,
    { description: 'TaskManager boards, tickets and your work, inside the chat' },
    async () => ({
      contents: [
        {
          uri: UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: MCP_UI_HTML,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    'show_board',
    {
      title: 'Show board',
      description:
        'SHOW the person a board as an interactive kanban in the chat (columns by stage; they can move, add and open tickets there). Use when they want to see or work a board; use get_board / search_tickets for your own reading.',
      inputSchema: { board: z.string().optional().describe("Board key ('ENG')") },
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    async (a: { board?: string }) => {
      try {
        const board = await requestBoard(ctx, a.board ?? null);
        const snap = await db()
          .collection(paths.tickets(board.id))
          .where('state', '==', 'active')
          .limit(MAX_BOARD_TICKETS + 1)
          .get();
        const ts = snap.docs
          .map((d) => withTicketId(board.id, d.id, d.data() as Ticket))
          .sort((x, y) => x.rank.localeCompare(y.rank));
        const tickets = await briefs(new Map([[board.id, board]]), ts.slice(0, MAX_BOARD_TICKETS));
        const pub = await boardView(ctx, board);
        const counts = pub.stages.map(
          (s) => `${s.name}: ${tickets.filter((t) => t.stage === s.name).length}`,
        );
        return result(`Board ${board.key} · ${board.name} — ${counts.join(', ')}`, {
          view: 'board',
          board: pub,
          tickets,
          truncated: ts.length > MAX_BOARD_TICKETS,
          can: abilities(ctx),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerAppTool(
    server,
    'show_ticket',
    {
      title: 'Show ticket',
      description:
        'SHOW the person one ticket as an interactive card in the chat (details and thread; they can move it, take it, comment). Use get_ticket for your own reading.',
      inputSchema: { key: z.string().describe("Ticket key, e.g. 'ENG-42'") },
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    async (a: { key: string }) => {
      try {
        const { board, ticket } = await ticketByKey(ctx, a.key);
        const [detail, pub] = await Promise.all([
          ticketDetail(ctx, board, ticket, 30),
          boardView(ctx, board),
        ]);
        return result(`${detail.key} · ${detail.title} — ${detail.stage.name}`, {
          view: 'ticket',
          ticket: detail,
          board: pub,
          me: ctx.actor,
          can: abilities(ctx),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerAppTool(
    server,
    'show_my_work',
    {
      title: 'Show my work',
      description:
        'SHOW the person what is assigned to them across every board, overdue and due-soon first, as an interactive list in the chat. Use list_my_tickets for your own reading.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    async () => {
      try {
        const boards = await readableBoards(ctx);
        const byId = new Map(boards.map((b) => [b.id, b]));
        const lists = await Promise.all(
          boards.map(async (b) =>
            (
              await db()
                .collection(paths.tickets(b.id))
                .where('assigneeUids', 'array-contains', ctx.actor)
                .where('state', '==', 'active')
                .limit(200)
                .get()
            ).docs.map((d) => withTicketId(b.id, d.id, d.data() as Ticket)),
          ),
        );
        const ts = lists
          .flat()
          .sort(
            (x, y) =>
              (x.dueAt ?? Number.MAX_SAFE_INTEGER) - (y.dueAt ?? Number.MAX_SAFE_INTEGER) ||
              y.updatedAt - x.updatedAt,
          );
        const overdue = ts.filter((t) => t.dueAt !== null && t.dueAt < ctx.now).map((t) => t.key);
        return result(
          `${ts.length} ticket(s) assigned to you${overdue.length ? `, ${overdue.length} overdue: ${overdue.join(', ')}` : ''}`,
          {
            view: 'mywork',
            now: new Date(ctx.now).toISOString(),
            tickets: await briefs(byId, ts),
            overdue,
            can: abilities(ctx),
          },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
