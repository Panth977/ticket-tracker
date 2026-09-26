/**
 * THE LINK BETWEEN THE SDK'S FLAT TYPES AND THE SERVER'S ZOD SCHEMAS.
 *
 * src/types.ts spells the /v1 shapes out in plain TypeScript so the shipped
 * sdk.d.ts / sdk.ts need neither zod nor @tm/shared. This file is what keeps
 * that honest: for every shape it asserts assignability IN BOTH DIRECTIONS
 * against the @tm/shared schema the server validates with. Mutual
 * assignability is structural identity, so any field the server adds, drops
 * or retypes breaks `pnpm --filter @tm/sdk typecheck` — the spec's "a wrong
 * field is a compile error rather than a 400", pointed at the SDK itself.
 *
 * It is types only: nothing here runs, and nothing here reaches dist/.
 */
import type {
  PublicActor,
  PublicAgent,
  PublicAgentStatus,
  PublicCost,
  PublicRunReceipt,
  PublicAttachment,
  PublicBoard,
  PublicEvent,
  PublicFile,
  PublicMember,
  PublicMessage,
  PublicPrincipal,
  PublicQuestion,
  PublicQuestionField,
  PublicTasklist,
  PublicTicket,
  PublicTicketDetail,
  RestMeRes,
  Scope as SharedScope,
} from '@tm/shared';
import type {
  Actor,
  Agent,
  AgentStatus,
  Cost,
  RunReceipt,
  Attachment,
  Board,
  BoardRef,
  Me,
  Member,
  Message,
  Principal,
  Question,
  QuestionField,
  Scope,
  Tasklist,
  Ticket,
  TicketDetail,
  TmEvent,
  TmFile,
} from '../src/types.js';

/** `Exact<A, B>` only compiles when A and B are the same type both ways round. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const exact = <T extends true>(_ok: T): void => void 0;

/** @tm/shared exports no alias for PublicBoardRefSchema; a ticket's `board` is one. */
type PublicBoardRef = PublicTicket['board'];

exact<Exact<Scope, SharedScope>>(true);
exact<Exact<Principal, PublicPrincipal>>(true);
exact<Exact<Actor, PublicActor>>(true);
exact<Exact<Member, PublicMember>>(true);
exact<Exact<BoardRef, PublicBoardRef>>(true);
exact<Exact<Board, PublicBoard>>(true);
exact<Exact<Ticket, PublicTicket>>(true);
exact<Exact<TicketDetail, PublicTicketDetail>>(true);
exact<Exact<Attachment, PublicAttachment>>(true);
exact<Exact<TmFile, PublicFile>>(true);
exact<Exact<Message, PublicMessage>>(true);
exact<Exact<QuestionField, PublicQuestionField>>(true);
exact<Exact<Question, PublicQuestion>>(true);
exact<Exact<Tasklist, PublicTasklist>>(true);
exact<Exact<AgentStatus, PublicAgentStatus>>(true);
exact<Exact<TmEvent, PublicEvent>>(true);
exact<Exact<Me, RestMeRes>>(true);
// phase 17
exact<Exact<Cost, PublicCost>>(true);
exact<Exact<RunReceipt, PublicRunReceipt>>(true);
exact<Exact<Agent, PublicAgent>>(true);
