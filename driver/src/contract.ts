/**
 * COMPILE-TIME ONLY. src/api.ts is written by hand so it can ship as a
 * declaration file with no imports; this file makes `tsc` fail the moment it
 * and the protocol in @tm/shared/artifacts/driver disagree. Nothing here runs
 * and nothing imports it (esbuild never sees it).
 */
import type {
  DriverArtifact,
  DriverBoard,
  DriverPerson,
  DriverTicket,
  DriverMemory,
  DriverMemoryNode,
  TicketInput as WireTicketInput,
  TicketQuery as WireTicketQuery,
  DriverDoc,
  DriverErrorCode,
  DriverMe,
  DriverResult,
  ListQuery as WireQuery,
  ServerTime as WireServerTime,
  SignalMsg,
  WhereOp as WireWhereOp,
} from '@tm/shared/artifacts/driver';
import type * as Api from './api.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const same = <A, B>(_ok: Same<A, B>): void => {};

same<Api.Me, DriverMe>(true);
same<Api.ArtifactInfo, DriverArtifact>(true);
same<Api.Doc, DriverDoc>(true);
same<Api.WhereOp, WireWhereOp>(true);
same<Api.ListQuery, WireQuery>(true);
same<Api.ErrorCode, DriverErrorCode>(true);
same<Api.ServerTime, WireServerTime>(true);
same<Api.FileInfo[], DriverResult<'st.list'>>(true);
same<keyof Api.SignalMap, SignalMsg['name']>(true);
// §K — a board's tickets.
same<Api.Person, DriverPerson>(true);
same<Api.Board, DriverBoard>(true);
same<Api.Ticket, DriverTicket>(true);
same<Api.TicketQuery, WireTicketQuery>(true);
same<Api.TicketInput, WireTicketInput>(true);
same<Api.Ticket | null, DriverResult<'tk.get'>>(true);
same<{ id: string; key: string }, DriverResult<'tk.create'>>(true);
// memory.html §H
same<Api.Memory, DriverMemory>(true);
same<Api.MemoryNode, DriverMemoryNode>(true);
same<Api.Memory[], DriverResult<'mem.list'>>(true);
same<Api.MemoryNode[], DriverResult<'mem.tree'>>(true);
