/**
 * THE COMMAND REGISTRY — one entry per `/api/{name}` command. The backend's
 * runner parses Req with `COMMANDS[name].req`, runs the handler, parses Res;
 * the frontend's command(name, input) is typed by the same map.
 */
import type { z } from 'zod';
import * as account from './account.js';
import * as agents from './agents.js';
import * as boards from './boards.js';
import type { CommandSpec } from './define.js';
import * as platform from './platform.js';
import * as questions from './questions.js';
import * as tasklists from './tasklists.js';
import * as tickets from './tickets.js';
import * as users from './users.js';
import * as workspaces from './workspaces.js';
import * as artifacts from '../artifacts/commands.js';

export * from './define.js';
export * from './boards.js';
export * from './tickets.js';
export * from './account.js';
export * from './platform.js';
export * from './agents.js';
export * from './questions.js';
export * from './tasklists.js';
export * from './users.js';
export * from './workspaces.js';

export const COMMANDS = {
  // boards, people, views
  inviteCreate: boards.inviteCreate,
  inviteAccept: boards.inviteAccept,
  inviteRevoke: boards.inviteRevoke,
  boardCreate: boards.boardCreate,
  boardUpdate: boards.boardUpdate,
  tagCreate: boards.tagCreate,
  boardAccessSet: boards.boardAccessSet,
  boardArchive: boards.boardArchive,
  boardPrefSet: boards.boardPrefSet,
  viewSave: boards.viewSave,
  viewDelete: boards.viewDelete,
  // tickets and threads
  ticketCreate: tickets.ticketCreate,
  ticketUpdate: tickets.ticketUpdate,
  ticketBulk: tickets.ticketBulk,
  ticketState: tickets.ticketState,
  ticketDelete: tickets.ticketDelete,
  messagePost: tickets.messagePost,
  messageEdit: tickets.messageEdit,
  messagePin: tickets.messagePin,
  messageReact: tickets.messageReact,
  ticketWatch: tickets.ticketWatch,
  // account
  searchKey: account.searchKey,
  profileUpdate: account.profileUpdate,
  whatsappLink: account.whatsappLink,
  accountDelete: account.accountDelete,
  accountExport: account.accountExport,
  sessionRevokeAll: account.sessionRevokeAll,
  ping: account.ping,
  icsFeedUrl: account.icsFeedUrl,
  // platform
  grantRevoke: platform.grantRevoke,
  apiKeyCreate: platform.apiKeyCreate,
  apiKeyRevoke: platform.apiKeyRevoke,
  webhookUpsert: platform.webhookUpsert,
  // extras (not named in docs/data, implied by screens / REST CRUD)
  webhookDelete: platform.webhookDelete,
  intakeUpsert: platform.intakeUpsert,
  installRemove: platform.installRemove,
  installConfigure: platform.installConfigure,
  // phase 2: agents (docs/plan/agents.html)
  agentCreate: agents.agentCreate,
  agentUpdate: agents.agentUpdate,
  agentArchive: agents.agentArchive,
  boardAgentSet: agents.boardAgentSet,
  agentInboxAck: agents.agentInboxAck,
  // phase 3: questions, task lists, heartbeat (agents.html §L)
  questionAsk: questions.questionAsk,
  questionAnswer: questions.questionAnswer,
  questionCancel: questions.questionCancel,
  tasklistSet: tasklists.tasklistSet,
  tasklistItemUpdate: tasklists.tasklistItemUpdate,
  tasklistDelete: tasklists.tasklistDelete,
  agentHeartbeat: tasklists.agentHeartbeat,
  // phase 16: the allow list (agents.html §X) — the admin's Users module
  userList: users.userList,
  userAllow: users.userAllow,
  userDisallow: users.userDisallow,
  // artifacts (docs/plan/artifacts.html)
  artifactCreate: artifacts.artifactCreate,
  artifactUpdate: artifacts.artifactUpdate,
  artifactShare: artifacts.artifactShare,
  artifactPublish: artifacts.artifactPublish,
  artifactSetCurrent: artifacts.artifactSetCurrent,
  artifactDelete: artifacts.artifactDelete,
  artifactOpen: artifacts.artifactOpen,
  artifactFileUrl: artifacts.artifactFileUrl,
  artifactFileList: artifacts.artifactFileList,
  artifactFileDelete: artifacts.artifactFileDelete,
  artifactSourceUrl: artifacts.artifactSourceUrl,
  artifactDataClear: artifacts.artifactDataClear,
  artifactBoardAccessSet: artifacts.artifactBoardAccessSet,
  // workspaces (agents.html §AB): a person's own sidebar
  workspaceCreate: workspaces.workspaceCreate,
  workspaceUpdate: workspaces.workspaceUpdate,
  workspaceDelete: workspaces.workspaceDelete,
  sidebarHide: workspaces.sidebarHide,
} as const satisfies { [K in string]: CommandSpec<K> };

export type Commands = typeof COMMANDS;
export type CommandName = keyof Commands;
/** What the caller sends (zod INPUT: optional/defaulted fields may be omitted). */
export type CommandReq<N extends CommandName> = z.input<Commands[N]['req']>;
/** What the handler receives after parsing. */
export type CommandReqParsed<N extends CommandName> = z.output<Commands[N]['req']>;
/** What the command answers. */
export type CommandRes<N extends CommandName> = z.output<Commands[N]['res']>;

export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[];

export const isCommandName = (s: string): s is CommandName =>
  Object.prototype.hasOwnProperty.call(COMMANDS, s);

/** The spec for a name, or undefined — for routers that receive arbitrary strings. */
export function getCommand(name: string): CommandSpec | undefined {
  return isCommandName(name) ? (COMMANDS[name] as CommandSpec) : undefined;
}
