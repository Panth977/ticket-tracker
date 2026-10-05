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
  PublicArtifact,
  PublicArtifactBuild,
  PublicArtifactDetail,
  PublicArtifactMember,
  PublicCost,
  PublicAggField,
  PublicAggCounters,
  PublicMessageAgg,
  PublicAggBuckets,
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
  ArtifactAgentAccess as SharedArtifactAgentAccess,
  ArtifactDataDoc as SharedArtifactDataDoc,
  ArtifactDataFile as SharedArtifactDataFile,
  ArtifactDataWrite as SharedArtifactDataWrite,
  RestArtifactAccessResSchema,
  RestArtifactDataWriteResSchema,
  RestArtifactFileUrlResSchema,
  RestArtifactSourceResSchema,
  WhereOp,
} from '@tm/shared';
import type {
  ArtifactDataDoc,
  ArtifactDataFile,
  ArtifactDataFileUrl,
  ArtifactDataWhereOp,
  ArtifactDataWrite,
  ArtifactDataWriteResult,
} from '../src/data.js';
import type {
  Actor,
  Agent,
  AgentStatus,
  Artifact,
  ArtifactAgentAccess,
  ArtifactBuild,
  ArtifactDetail,
  ArtifactMember,
  ArtifactShareResult,
  ArtifactSource,
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
  AggField,
  AggCounters,
  AggBuckets,
  MessageAgg,
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
// aggregates.html
exact<Exact<AggField, PublicAggField>>(true);
exact<Exact<AggCounters, PublicAggCounters>>(true);
exact<Exact<MessageAgg, PublicMessageAgg>>(true);
exact<Exact<AggBuckets, PublicAggBuckets>>(true);
exact<Exact<Board['agg_fields'], PublicBoard['agg_fields']>>(true);
exact<Exact<Board['aggs'], PublicBoard['aggs']>>(true);
exact<Exact<Ticket['aggs'], PublicTicket['aggs']>>(true);
exact<Exact<Message['agg'], PublicMessage['agg']>>(true);
exact<Exact<Message['kind'], PublicMessage['kind']>>(true);
// artifacts (docs/plan/artifacts.html §C1)
exact<Exact<Artifact, PublicArtifact>>(true);
exact<Exact<ArtifactBuild, PublicArtifactBuild>>(true);
exact<Exact<ArtifactMember, PublicArtifactMember>>(true);
exact<Exact<ArtifactDetail, PublicArtifactDetail>>(true);
// @tm/shared exports these two as schemas only. `_output` is what z.infer
// reads; spelling it here keeps zod out of the SDK's own dependencies.
type Out<S extends { _output: unknown }> = S['_output'];
exact<Exact<ArtifactSource, Out<typeof RestArtifactSourceResSchema>>>(true);
exact<Exact<ArtifactShareResult, Out<typeof RestArtifactAccessResSchema>>>(true);
// agent access and the data API (docs/plan/agents.html §AA3, §AA4)
exact<Exact<ArtifactAgentAccess, SharedArtifactAgentAccess>>(true);
// `agent_access` is optional on both sides, and an optional key cannot break
// mutual assignability by being absent — so it is pinned by name as well.
exact<Exact<NonNullable<Artifact['agent_access']>, NonNullable<PublicArtifact['agent_access']>>>(true);
exact<Exact<NonNullable<ArtifactMember['agent_access']>, NonNullable<PublicArtifactMember['agent_access']>>>(true);
exact<Exact<NonNullable<Me['default_board']>, NonNullable<RestMeRes['default_board']>>>(true);
exact<Exact<ArtifactDataDoc, SharedArtifactDataDoc>>(true);
exact<Exact<ArtifactDataFile, SharedArtifactDataFile>>(true);
exact<Exact<ArtifactDataWhereOp, WhereOp>>(true);
exact<Exact<ArtifactDataWrite, SharedArtifactDataWrite>>(true);
exact<Exact<ArtifactDataWriteResult, Out<typeof RestArtifactDataWriteResSchema>>>(true);
exact<Exact<ArtifactDataFileUrl, Out<typeof RestArtifactFileUrlResSchema>>>(true);
