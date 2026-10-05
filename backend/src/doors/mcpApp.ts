/**
 * THE APP OVER MCP: everything the web app can do, as tools, so the Claude
 * app (desktop / phone) can be the whole UI.
 *
 * TWO HALVES:
 *
 *   1. THE COMMAND BRIDGE. Every write the app makes is a command (shared
 *      COMMANDS). Each one a token may call (tokenMayCall: it has scopes and is
 *      not on the deny list) becomes a tool named after it — boardCreate →
 *      board_create — whose input IS the command's own zod schema. The runner
 *      checks scopes, can() and idempotency exactly as for /api, so there is
 *      nothing to keep in step: a new command with scopes shows up here by
 *      itself. Commands the hand-written tools in mcp.ts already cover (by
 *      name, not id) are left out so the model sees one way to do each thing.
 *      `boardId` takes a board KEY and `ticketId` a ticket KEY as well as ids.
 *
 *   2. THE READS the app does straight from Firestore (board settings, views,
 *      invites, webhooks, intake, integrations, agents, the notification
 *      inbox), with the same checks the security rules make. Nothing secret
 *      leaves: fields named like a secret, token, hash or nonce are dropped.
 *
 * What stays app-only is the deny list (TOKEN_DENIED_COMMANDS): minting or
 * revoking tokens, OAuth grants, sessions, the account itself and the
 * profile's security settings — a leaked token must never become permanent.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  COMMAND_NAMES,
  COMMANDS,
  isAgentId,
  paths,
  tokenMayCall,
  type CommandName,
  type CommandReq,
  type Scope,
} from '@tm/shared';
import { invoke } from '../platform/ops.js';
import { readableBoards, requestBoard, ticketByKey } from '../platform/resolve.js';
import type { ServerCtx } from '../runtime/context.js';
import { auth, db } from '../runtime/firebase.js';
import { toAppError } from '../runtime/runner.js';
import { requireCan } from '../tickets/access.js';

/** Covered by a friendlier hand-written tool in mcp.ts (names, not ids). */
const COVERED = new Set<CommandName>([
  'ticketCreate', // create_ticket
  'ticketUpdate', // update_ticket, move_ticket, assign_ticket
  'messagePost', // post_message
  'questionAsk', // ask_question
  'questionCancel', // cancel_question
  'tasklistSet', // set_tasklist
  'tasklistItemUpdate', // update_task_item
  'tasklistDelete', // delete_tasklist
  'agentHeartbeat', // heartbeat
  'agentInboxAck', // ack_events
  'artifactCreate', // artifact_create
  'artifactPublish', // artifact_publish
  'artifactSetCurrent', // artifact_rollback
  'artifactShare', // artifact_share
  'artifactSourceUrl', // artifact_source
]);
/** Plumbing for the app itself, not something a person does. */
// memoryFilePut follows a browser upload to Storage; a token writes with memory_file_write.
const PLUMBING = new Set<string>(['ping', 'searchKey', 'memoryFilePut']);

/** What each command does, in a line; the spec's `permission` says who may. */
const SUMMARY: Partial<Record<CommandName, string>> = {
  boardCreate:
    'Create a board (you become its admin). template: blank / kanban / bug tracker, or copy a board. Give it a `description` (plain text: what the board is for — agents read it) and optionally an `indicator` (its mark: { kind: color | icon | emoji, … }).',
  boardUpdate:
    'Change board settings: name, key, description (plain text), indicator, stages (each with its own description — what the stage MEANS, which agents read to decide where a ticket goes — and indicator), priorities, fields, tags, WIP limits and the settings object (patch). Read get_board_settings first.',
  boardArchive:
    "Archive, restore or DELETE a board. Deleting needs confirmKey = the board's key and removes every ticket — confirm with the person first.",
  boardAccessSet:
    'Set people’s roles on a board (admin / editor / commenter / viewer, or null to remove), their stage grants, or leave the board.',
  boardAgentSet:
    'Put one of your agents on a board with a role, change it, or take it off (role null).',
  boardPrefSet:
    'Your own preferences for a board (notification mode all / mine / muted, and the like).',
  tagCreate: 'Create a tag on a board (an existing tag with the same name is returned instead).',
  viewSave:
    'Create or update a saved view (kanban / table / calendar / timeline …), personal or shared.',
  viewDelete: 'Delete a saved view.',
  inviteCreate: 'Invite people to a board by email with a role.',
  inviteRevoke: 'Revoke a pending invite, or resend it (resend: true).',
  inviteAccept:
    'Accept or decline an invite sent to your email (list_invites with no board shows yours).',
  ticketDelete:
    "Delete a ticket for good (only when the board's settings allow deleting). Prefer ticket_state archived; confirm first.",
  ticketState: 'Archive a ticket, or restore an archived one (admins).',
  ticketBulk: 'One action over many tickets: move stage, set priority, assign, tag, archive …',
  ticketWatch: 'Watch or unwatch a ticket (notifications even on a muted board).',
  messageEdit: 'Edit your own message, or delete a message (author or board admin).',
  messagePin: 'Pin or unpin a message in a ticket thread.',
  messageReact: 'Add or remove an emoji reaction on a message.',
  questionAnswer: 'Answer a question an agent asked in a thread.',
  webhookUpsert:
    'Create or update a board webhook (https only); rotateSecret returns a new secret once.',
  webhookDelete: 'Delete a board webhook.',
  intakeUpsert:
    'Configure the board’s intake form (public ticket submission): on/off, origins, defaults.',
  installConfigure: 'Configure a connected integration (GitHub repos, Slack channel, events).',
  installRemove: 'Disconnect an integration from a board.',
  agentCreate: 'Create an agent (an AI teammate with a name, description and system prompt).',
  agentUpdate: 'Change one of your agents: name, description, system prompt, icon.',
  agentArchive: 'Archive one of your agents (off every board, tokens revoked) or restore it.',
  userList: 'App admin only: who is allowed to use this app.',
  userAllow: 'App admin only: allow an email address to use this app.',
  userDisallow: 'App admin only: take an email address off the allow list.',
  artifactUpdate:
    'Rename an artifact, change its description or indicator (its mark), make it read-only, archive it.',
  artifactDelete: 'Delete an artifact with all its builds, source, files and data — confirm first.',
  artifactOpen: 'A link that opens the artifact (current build, or a kept one by buildId).',
  artifactFileList:
    'List the files an artifact stored (its own file storage), under a path prefix.',
  artifactFileUrl: 'A download link for one file an artifact stored.',
  artifactFileDelete: 'Delete one file an artifact stored.',
  artifactDataClear:
    'Wipe an artifact’s data (Firestore, RTDB and files) — builds stay. Confirm first.',
  artifactBoardAccessSet:
    'Let an artifact’s page read (or read and write) a board’s tickets through BackendDriver.tickets, or take that away (access null). Viewers still only see what their own board role allows.',
  workspaceCreate:
    'Create one of your workspaces: a named bundle of boards and artifacts in your sidebar (grants nothing), with an optional description and indicator.',
  workspaceUpdate:
    'Rename a workspace, change its description or indicator, or attach and detach boards and artifacts (add / remove, or whole lists).',
  workspaceDelete: 'Delete a workspace. Its boards and artifacts are untouched.',
  sidebarHide:
    'Hide a board, artifact or memory from your sidebar’s root lists, or show it again. Nothing about it changes otherwise.',
  // Memory (docs/plan/memory.html): buckets of files. Nodes are named by PATH ('docs/brand/logo.svg').
  memoryCreate:
    'Create a memory: an online bucket of files and folders (notes, images, video, APKs …) you own.',
  memoryUpdate:
    'Rename a memory, change its description or indicator (its mark), archive or restore it.',
  memoryDelete:
    'Delete a memory with every file in it — confirm first. Tickets that pointed at its files show them as gone.',
  memoryShare:
    'Give a person a role on a memory by email (editor / viewer), or take it away (null).',
  memoryGrantSet:
    'Let a board (its members, and its agents) or an artifact’s page use a memory: read, or read and write; null removes. Each person still only gets what their own board role allows.',
  memoryList:
    'The memories you can reach — yours, and those granted to boards you are on (or to one board / artifact).',
  memoryTree:
    'List the files and folders in a memory (all of it, or under a path; shallow = one level).',
  memoryFileRead:
    'Read a memory file: its text (text files, up to 1 MB) and a short-lived download URL (any file).',
  memoryFileWrite:
    'Create or replace a memory file at a path, from text or base64 (≤ 10 MB). Missing folders are created; expectedFileId guards against overwriting a newer version.',
  memoryFilePut:
    'Register a file already uploaded to Storage at memories/{memoryId}/{fileId}/{name} (the web app’s upload path) — over MCP, use memory_file_write.',
  memoryFolderCreate: 'Create a folder (and any missing parents) in a memory.',
  memoryMove:
    'Rename or move a file or folder in a memory to a new full path (a folder takes everything inside).',
  memoryNodeDelete:
    'Delete files or folders in a memory (a folder with everything inside) — confirm first.',
};

/** board_create, view_save, artifact_file_url … */
export const toolNameOf = (command: string): string =>
  command.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const DESTRUCTIVE = /Delete|Archive|Revoke|Remove|Clear|Disallow/;

/** The commands bridged for this credential. */
export function bridgedCommands(scopes: readonly Scope[] | undefined | null): CommandName[] {
  return COMMAND_NAMES.filter(
    (n) =>
      !COVERED.has(n) &&
      !PLUMBING.has(n) &&
      // A full session (no scopes) is the app itself, never MCP; a token must
      // be let through by the spec's own scopes, deny list first.
      !!COMMANDS[n].scopes?.length &&
      tokenMayCall({ ...COMMANDS[n], name: n }, scopes ?? []),
  );
}

type Shape = Record<string, z.ZodTypeAny>;

/** The command's request object, minus clientId, with keys accepted for ids. */
function inputShape(name: CommandName): Shape {
  let s: z.ZodTypeAny = COMMANDS[name].req;
  while (s instanceof z.ZodEffects) s = s._def.schema as z.ZodTypeAny;
  if (!(s instanceof z.ZodObject)) return { input: z.record(z.unknown()) };
  const out: Shape = {};
  for (const [k, v] of Object.entries(s.shape as Shape)) {
    if (k === 'clientId') continue;
    const opt = v.isOptional();
    const loose =
      k === 'boardId'
        ? z
            .string()
            .optional()
            .describe(
              "Board key ('ENG') or id; may be left out when a ticket key names it, or you are on one board",
            )
        : k === 'ticketId'
          ? z.string().describe("Ticket key ('ENG-42') or id")
          : k === 'ticketIds'
            ? z.array(z.string()).describe("Ticket keys ('ENG-42') or ids")
            : null;
    out[k] = loose ? (opt || k === 'boardId' ? loose.optional() : loose) : v;
  }
  return out;
}

/**
 * Does the command NEED a board, so a left-out boardId means "the one I am
 * on"? Only when its own schema requires one: an optional boardId (memory_list,
 * memory_grant_set, sidebar_hide …) means "no board" when left out.
 */
function boardRequired(name: CommandName): boolean {
  let s: z.ZodTypeAny = COMMANDS[name].req;
  while (s instanceof z.ZodEffects) s = s._def.schema as z.ZodTypeAny;
  if (!(s instanceof z.ZodObject)) return false;
  const f = (s.shape as Shape).boardId;
  return !!f && !f.isOptional();
}

const TICKET_KEY = /^#?[A-Za-z][A-Za-z0-9]{1,9}-\d+$/;

/** Keys → ids, so the model can say ENG and ENG-42 the way people do. */
async function resolveIds(ctx: ServerCtx, args: Record<string, unknown>, wantsBoard: boolean) {
  const out = { ...args };
  const tickets = async (k: string) => {
    if (!TICKET_KEY.test(k)) return k;
    const { board, ticket } = await ticketByKey(ctx, k);
    if (out.boardId === undefined) out.boardId = board.id;
    return ticket.id;
  };
  if (typeof out.ticketId === 'string') out.ticketId = await tickets(out.ticketId);
  if (Array.isArray(out.ticketIds))
    out.ticketIds = await Promise.all(out.ticketIds.map((k) => tickets(String(k))));
  if (typeof out.boardId === 'string') out.boardId = (await requestBoard(ctx, out.boardId)).id;
  else if (wantsBoard) out.boardId = (await requestBoard(ctx, null)).id;
  return out;
}

/** inviteAccept and the allow list compare a VERIFIED email; a token does not carry one. */
const NEEDS_EMAIL = new Set<CommandName>(['inviteAccept', 'userList', 'userAllow', 'userDisallow']);
async function withEmail(ctx: ServerCtx): Promise<ServerCtx> {
  if (isAgentId(ctx.actor)) return ctx;
  const u = await auth().getUser(ctx.actor);
  return { ...ctx, email: u.email ?? null, emailVerified: u.emailVerified };
}

/** Drop anything that could be a credential, at any depth. */
const SECRETISH = /secret|token|hash|nonce/i;
export function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !SECRETISH.test(k))
        .map(([k, x]) => [k, scrub(x)]),
    );
  return v;
}

const json = (v: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(v, null, 2) }],
});
function fail(e: unknown): CallToolResult {
  const err = toAppError(e);
  return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
}
const run =
  <A>(fn: (a: A) => Promise<unknown>) =>
  async (a: A): Promise<CallToolResult> => {
    try {
      return json(await fn(a));
    } catch (e) {
      return fail(e);
    }
  };

const hasAny = (ctx: ServerCtx, want: readonly Scope[]) =>
  !ctx.scopes || want.some((s) => ctx.scopes!.includes(s));
const docs = async (q: FirebaseFirestore.Query) =>
  (await q.get()).docs.map((d) => ({ id: d.id, ...(scrub(d.data()) as object) }));

const boardArg = z
  .string()
  .optional()
  .describe("Board key ('ENG'); optional when you are on one board");

/** Register the bridge and the reads on `server` for `ctx`. */
export function registerAppTools(server: McpServer, ctx: ServerCtx): void {
  // ─── 1. every command, as a tool ──────────────────────────────────────────
  for (const name of bridgedCommands(ctx.scopes)) {
    const spec = COMMANDS[name];
    const shape = inputShape(name);
    server.registerTool(
      toolNameOf(name),
      {
        description: `${SUMMARY[name] ?? `The app's ${name} command.`} Who may: ${spec.permission}`,
        inputSchema: shape,
        annotations: {
          readOnlyHint:
            name === 'userList' ||
            /^artifact(Open|File(List|Url))$/.test(name) ||
            /^memory(List|Tree|FileRead)$/.test(name),
          destructiveHint: DESTRUCTIVE.test(name) || name === 'boardArchive',
        },
      },
      run(async (args: Record<string, unknown>) => {
        const input = await resolveIds(
          ctx,
          'input' in args ? (args.input as Record<string, unknown>) : args,
          boardRequired(name),
        );
        const c = NEEDS_EMAIL.has(name) ? await withEmail(ctx) : ctx;
        return invoke(name, input as CommandReq<typeof name>, c);
      }),
    );
  }

  // ─── 2. the reads the app makes straight from Firestore ───────────────────
  const read = (
    name: string,
    scopes: readonly Scope[],
    description: string,
    shape: Shape,
    fn: (a: Record<string, unknown>) => Promise<unknown>,
    peopleOnly = false,
  ) => {
    if (!hasAny(ctx, scopes) || (peopleOnly && isAgentId(ctx.actor))) return;
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { readOnlyHint: true } },
      run(fn),
    );
  };
  const board = (a: Record<string, unknown>) => requestBoard(ctx, (a.board as string) ?? null);
  const admin = async (a: Record<string, unknown>) => {
    const b = await board(a);
    requireCan(ctx, b, 'admin', null, null, 'Only board admins see this');
    return b;
  };

  read(
    'get_board_settings',
    ['board:read'],
    'Everything on the board’s settings screen, with ids: stages (WIP limits, categories), priorities, fields and their options, tags, people’s roles and stage grants, the settings object — plus your own prefs for it. Read this before board_update.',
    { board: boardArg },
    async (a) => {
      const b = await board(a);
      const pref = await db().doc(paths.pref(b.id, ctx.actor)).get();
      return { ...(scrub(b) as object), my_prefs: pref.exists ? scrub(pref.data()) : null };
    },
  );
  read(
    'list_views',
    ['board:read'],
    'The board’s saved views: every shared one, and your personal ones.',
    { board: boardArg },
    async (a) => {
      const b = await board(a);
      const all = await docs(db().collection(paths.views(b.id)));
      return all.filter(
        (v) =>
          (v as { scope?: string }).scope !== 'personal' ||
          (v as { ownerUid?: string }).ownerUid === ctx.actor,
      );
    },
  );
  read(
    'list_invites',
    ['invites:write', 'boards:admin', 'board:admin'],
    'With `board`: the board’s invites (admins). Without: the pending invites sent to YOUR email — accept them with invite_accept.',
    { board: z.string().optional().describe("Board key ('ENG'); leave out for invites to you") },
    async (a) => {
      if (a.board) {
        const b = await admin(a);
        return docs(db().collection(paths.invites()).where('boardId', '==', b.id));
      }
      const me = await withEmail(ctx);
      if (!me.email) return [];
      return docs(
        db()
          .collection(paths.invites())
          .where('email', '==', me.email.toLowerCase())
          .where('status', '==', 'pending'),
      );
    },
    true,
  );
  read(
    'list_webhooks',
    ['webhooks:manage'],
    'The board’s webhooks (admins). Secrets are never shown; rotate one with webhook_upsert.',
    { board: boardArg },
    async (a) => docs(db().collection(paths.webhooks((await admin(a)).id))),
  );
  read(
    'get_intake',
    ['board:admin', 'boards:admin'],
    'The board’s intake form settings (admins). Change them with intake_upsert.',
    { board: boardArg },
    async (a) => {
      const b = await admin(a);
      const rows = await docs(db().collection(paths.intakes()).where('boardId', '==', b.id));
      return rows[0] ?? null;
    },
  );
  read(
    'list_integrations',
    ['board:admin', 'boards:admin'],
    'The board’s connected integrations (GitHub, Slack …) and how they are configured (admins).',
    { board: boardArg },
    async (a) => docs(db().collection(paths.integrations((await admin(a)).id))),
  );
  read(
    'list_workspaces',
    ['board:read'],
    'Your workspaces (bundles of boards and artifacts: ids, names, descriptions, indicators) and what you hid from the sidebar.',
    {},
    async () => {
      const [ws, side, boards] = await Promise.all([
        docs(db().collection(paths.workspaces(ctx.actor)).orderBy('position')),
        db().doc(paths.sidebarPrefs(ctx.actor)).get(),
        readableBoards(ctx, { includeArchived: true }),
      ]);
      const key = new Map(boards.map((b) => [b.id, b.key]));
      const keys = (ids: unknown) =>
        (Array.isArray(ids) ? (ids as string[]) : []).map((id) => key.get(id) ?? id);
      return {
        workspaces: ws.map((w) => ({ ...w, boards: keys((w as { boardIds?: unknown }).boardIds) })),
        hidden: side.exists ? scrub(side.data()) : { hiddenBoardIds: [], hiddenArtifactIds: [] },
      };
    },
    true,
  );
  read(
    'list_agents',
    ['agents:write'],
    'Your agents (AI teammates): name, description, system prompt, archived or not.',
    {},
    async () => docs(db().collection(paths.agents()).where('ownerUid', '==', ctx.actor)),
    true,
  );
  read(
    'list_notifications',
    ['events:read'],
    'Your notification inbox, newest first: mentions, assignments, moves, due dates, invites.',
    {
      unread_only: z.boolean().optional().describe('Only unread (default true)'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 30'),
    },
    async (a) => {
      const rows = await docs(
        db()
          .collection(paths.inbox(ctx.actor))
          .orderBy('createdAt', 'desc')
          .limit((a.limit as number) ?? 30),
      );
      return a.unread_only === false
        ? rows
        : rows.filter(
            (r) =>
              !(r as { readAt?: unknown }).readAt && !(r as { archivedAt?: unknown }).archivedAt,
          );
    },
    true,
  );

  if (hasAny(ctx, ['events:read']) && !isAgentId(ctx.actor))
    server.registerTool(
      'mark_notifications',
      {
        description:
          'Mark notifications read or unread, or archive them (ids from list_notifications, or all: true).',
        inputSchema: {
          ids: z.array(z.string()).max(200).optional(),
          all: z.boolean().optional().describe('Every unread notification'),
          action: z.enum(['read', 'unread', 'archive']),
        },
      },
      run(async (a: { ids?: string[]; all?: boolean; action: 'read' | 'unread' | 'archive' }) => {
        const col = db().collection(paths.inbox(ctx.actor));
        const ids = a.all
          ? (await col.where('readAt', '==', null).limit(500).get()).docs.map((d) => d.id)
          : (a.ids ?? []);
        const flags =
          a.action === 'read'
            ? { readAt: ctx.now }
            : a.action === 'unread'
              ? { readAt: null }
              : { archivedAt: ctx.now, readAt: ctx.now };
        // Only rows that exist: an unknown id must not create a notification.
        const found = ids.length
          ? (await db().getAll(...ids.map((id) => col.doc(id)))).filter((d) => d.exists)
          : [];
        const batch = db().batch();
        for (const d of found) batch.update(d.ref, flags);
        if (found.length) await batch.commit();
        return { updated: found.length };
      }),
    );
}
