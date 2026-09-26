/**
 * Phase 6 compatibility: the ticket state 'cancelled' is gone (a ticket is
 * active or archived — see @tm/shared TICKET_STATES), but rows written before
 * the migration (scripts/migrate-cancelled.mjs) can still hold it. Firestore
 * reads are raw casts, not schema-parsed, so such a ticket would otherwise
 * carry a state nothing in the UI knows about and quietly vanish.
 *
 * Everything the app reads goes through here: a stored 'cancelled' READS as
 * 'archived' (its closest meaning: read-only, out of default views, an admin
 * can restore it), and a query for archived tickets also asks for the legacy
 * value. After the migration has run both are simple no-ops, and this file
 * can go.
 */
import type { Ticket, TicketState } from '@tm/shared';

/** The state value phase 6 removed; still on disk until the migration runs. */
const LEGACY_CANCELLED = 'cancelled';

/** Read a stored state: the legacy 'cancelled' reads as 'archived'. */
export function readState(raw: string | null | undefined): TicketState {
  return raw === 'active' ? 'active' : 'archived';
}

/** A ticket as the UI should see it — nothing but `state` is touched. */
export function withReadState<T extends Pick<Ticket, 'state'>>(t: T): T {
  return t.state === 'active' || t.state === 'archived' ? t : { ...t, state: readState(t.state) };
}

/**
 * The values a Firestore `state in [...]` query needs to cover `states`:
 * asking for archived must also catch tickets still stored as 'cancelled'.
 */
export function stateQueryValues(states: readonly TicketState[]): string[] {
  return states.includes('archived') ? [...states, LEGACY_CANCELLED] : [...states];
}
