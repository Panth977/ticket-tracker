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
import * as artifacts from '../artifacts/commands.js';
import * as bucket from '../bucket/commands.js';
import * as dictionary from '../dictionary/commands.js';
import * as org from '../org/index.js';
import * as templates from '../templates/commands.js';

export * from './define.js';
export * from './boards.js';
export * from './tickets.js';
export * from './account.js';
export * from './platform.js';
export * from './agents.js';
export * from './questions.js';
export * from './tasklists.js';
export * from './users.js';

export const COMMANDS = {
  // boards, people, views
  inviteCreate: boards.inviteCreate,
  inviteAccept: boards.inviteAccept,
  inviteRevoke: boards.inviteRevoke,
  boardCreate: boards.boardCreate,
  driveDocs: boards.driveDocs,
  driveDocWrite: boards.driveDocWrite,
  entityStorageMove: boards.entityStorageMove,
  boardUpdate: boards.boardUpdate,
  tagCreate: boards.tagCreate,
  boardAccessSet: boards.boardAccessSet,
  boardArchive: boards.boardArchive,
  boardPrefSet: boards.boardPrefSet,
  viewSave: boards.viewSave,
  viewDelete: boards.viewDelete,
  // templates (docs/plan/templates.html)
  templateSave: templates.templateSave,
  templateDelete: templates.templateDelete,
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
  artifactDataCollections: artifacts.artifactDataCollections,
  artifactBoardAccessSet: artifacts.artifactBoardAccessSet,
  boardArtifactList: artifacts.boardArtifactList,
  // dictionaries (docs/plan/dictionary.html): key → JSON entries, granted to boards, artifacts, agents
  dictionaryCreate: dictionary.dictionaryCreate,
  dictionaryUpdate: dictionary.dictionaryUpdate,
  dictionaryDelete: dictionary.dictionaryDelete,
  dictionaryShare: dictionary.dictionaryShare,
  dictionaryGrantSet: dictionary.dictionaryGrantSet,
  dictionaryList: dictionary.dictionaryList,
  dictionaryGet: dictionary.dictionaryGet,
  dictionarySet: dictionary.dictionarySet,
  // owners and orgs (agents.html §AC)
  orgCreate: org.orgCreate,
  orgUpdate: org.orgUpdate,
  orgDelete: org.orgDelete,
  orgInvite: org.orgInvite,
  orgMemberSet: org.orgMemberSet,
  ownerTransfer: org.ownerTransfer,
  handleSet: org.handleSet,
  pathResolve: org.pathResolve,
  // bucket (docs/plan/bucket.html)
  bucketCreate: bucket.bucketCreate,
  bucketUpdate: bucket.bucketUpdate,
  bucketDelete: bucket.bucketDelete,
  bucketShare: bucket.bucketShare,
  bucketGrantSet: bucket.bucketGrantSet,
  boardAttachBucketSet: bucket.boardAttachBucketSet,
  bucketList: bucket.bucketList,
  bucketTree: bucket.bucketTree,
  bucketFileRead: bucket.bucketFileRead,
  bucketFileWrite: bucket.bucketFileWrite,
  bucketFilePut: bucket.bucketFilePut,
  bucketFolderCreate: bucket.bucketFolderCreate,
  bucketMove: bucket.bucketMove,
  bucketNodeDelete: bucket.bucketNodeDelete,
  // Google Drive as a bucket's storage (bucket.html §K)
  bucketDriveUpload: bucket.bucketDriveUpload,
  bucketStorageMove: bucket.bucketStorageMove,
  driveImport: bucket.driveImport,
  driveRecoveryCode: bucket.driveRecoveryCode,
  driveStatus: bucket.driveStatus,
  driveConnect: bucket.driveConnect,
  driveDisconnect: bucket.driveDisconnect,
  drivePickerToken: bucket.drivePickerToken,
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
