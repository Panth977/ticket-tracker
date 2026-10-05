import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  actionsForScopes,
  can,
  canEditTasklist,
  effectiveRole,
  scopeAllows,
  type Action,
  type CanBoard,
} from './can.js';
import {
  AGENT_TOKEN_SCOPES,
  presetOf,
  SCOPE_PRESETS,
  SCOPES,
  type BoardRole,
  type Scope,
} from '../types/index.js';

const board = (over: Partial<CanBoard> = {}): CanBoard => ({
  id: 'b1',
  access: { ad: 'admin', ed: 'editor', co: 'commenter', vi: 'viewer', co2: 'commenter' },
  stageGrants: {
    co: { stages: ['review', 'done'] },
    co2: { stages: ['review', 'done'], assignedOnly: true },
  },
  settings: { allowDelete: true },
  ...over,
});
const uidFor: Record<BoardRole, string> = {
  admin: 'ad',
  editor: 'ed',
  commenter: 'co',
  viewer: 'vi',
};

// Expected answer per role × action on a board that allows delete (move for
// the commenter is tested separately, because it depends on the grant).
const TABLE: Record<BoardRole, Record<Action, boolean>> = {
  admin: {
    read: true,
    comment: true,
    create: true,
    edit: true,
    move: true,
    state: true,
    restore: true,
    delete: true,
    pin: true,
    admin: true,
    assign: true,
    upload: true,
    ask: true,
    answer: true,
    tasklist: true,
    status: true,
  },
  editor: {
    read: true,
    comment: true,
    create: true,
    edit: true,
    move: true,
    state: true,
    restore: false,
    delete: true,
    pin: true,
    admin: false,
    assign: true,
    upload: true,
    ask: true,
    answer: true,
    tasklist: true,
    status: true,
  },
  commenter: {
    read: true,
    comment: true,
    create: false,
    edit: false,
    move: false,
    state: false,
    restore: false,
    delete: false,
    pin: false,
    admin: false,
    assign: false,
    upload: true,
    ask: true,
    answer: true,
    // A commenter's list is its own (canEditTasklist); can(tasklist) alone is editor+.
    tasklist: false,
    status: true,
  },
  viewer: {
    read: true,
    comment: false,
    create: false,
    edit: false,
    move: false,
    state: false,
    restore: false,
    delete: false,
    pin: false,
    admin: false,
    assign: false,
    upload: false,
    ask: false,
    answer: false,
    tasklist: false,
    status: false,
  },
};

describe('can — role × action', () => {
  for (const role of Object.keys(TABLE) as BoardRole[]) {
    for (const action of ACTIONS) {
      it(`${role} ${action} → ${TABLE[role][action]}`, () => {
        // commenter 'move' without ticket/toStage is false; covered below with a grant
        expect(can({ actor: uidFor[role] }, board(), action)).toBe(TABLE[role][action]);
      });
    }
  }

  it('someone not on the board can do nothing, not even read', () => {
    for (const action of ACTIONS) expect(can({ actor: 'stranger' }, board(), action)).toBe(false);
  });

  it('prototype keys are not roles', () => {
    expect(can({ actor: 'constructor' }, board(), 'read')).toBe(false);
    expect(can({ actor: '__proto__' }, board(), 'read')).toBe(false);
  });
});

describe('can — delete needs allowDelete', () => {
  it.each(['ad', 'ed'])('%s cannot delete when the board has not opted in', (actor) => {
    expect(can({ actor }, board({ settings: { allowDelete: false } }), 'delete')).toBe(false);
  });
});

describe('can — commenter StageGrant', () => {
  const t = (stageId: string, assigneeUids: string[] = []) => ({ stageId, assigneeUids });
  it('moves between granted stages', () => {
    expect(can({ actor: 'co' }, board(), 'move', t('review'), 'done')).toBe(true);
    expect(can({ actor: 'co' }, board(), 'move', t('done'), 'review')).toBe(true);
  });
  it('from outside the grant → false', () => {
    expect(can({ actor: 'co' }, board(), 'move', t('todo'), 'done')).toBe(false);
  });
  it('to outside the grant → false', () => {
    expect(can({ actor: 'co' }, board(), 'move', t('review'), 'todo')).toBe(false);
  });
  it('without ticket or target → false', () => {
    expect(can({ actor: 'co' }, board(), 'move', t('review'))).toBe(false);
    expect(can({ actor: 'co' }, board(), 'move', undefined, 'done')).toBe(false);
  });
  it('no grant → false', () => {
    expect(can({ actor: 'co' }, board({ stageGrants: {} }), 'move', t('review'), 'done')).toBe(
      false,
    );
  });
  it('assignedOnly: only tickets assigned to them', () => {
    expect(can({ actor: 'co2' }, board(), 'move', t('review', ['someone']), 'done')).toBe(false);
    expect(can({ actor: 'co2' }, board(), 'move', t('review', ['co2']), 'done')).toBe(true);
  });
  it('a grant does not help a viewer', () => {
    const b = board({ stageGrants: { vi: { stages: ['review', 'done'] } } });
    expect(can({ actor: 'vi' }, b, 'move', t('review'), 'done')).toBe(false);
  });
  it('editors move anywhere regardless of grants', () => {
    expect(can({ actor: 'ed' }, board(), 'move', t('todo'), 'backlog')).toBe(true);
  });
});

describe('can — scopes narrow, never widen', () => {
  it('tickets:read only reads', () => {
    const ctx = { actor: 'ad', scopes: ['tickets:read'] as const };
    expect(can(ctx, board(), 'read')).toBe(true);
    expect(can(ctx, board(), 'edit')).toBe(false);
    expect(can(ctx, board(), 'comment')).toBe(false);
  });
  it('comments:write comments and pins but does not edit', () => {
    const ctx = { actor: 'ed', scopes: ['comments:write'] as const };
    expect(can(ctx, board(), 'comment')).toBe(true);
    expect(can(ctx, board(), 'pin')).toBe(true);
    expect(can(ctx, board(), 'move')).toBe(false);
  });
  it('tickets:update cannot lift a viewer', () => {
    expect(can({ actor: 'vi', scopes: ['tickets:update'] }, board(), 'edit')).toBe(false);
  });
  it('admin needs board:admin or webhooks:manage', () => {
    expect(can({ actor: 'ad', scopes: [...SCOPE_PRESETS.everything] }, board(), 'admin')).toBe(
      false,
    );
    expect(can({ actor: 'ad', scopes: ['board:admin'] }, board(), 'admin')).toBe(true);
    expect(can({ actor: 'ad', scopes: ['webhooks:manage'] }, board(), 'admin')).toBe(true);
  });
  it('empty scope list allows nothing', () => {
    for (const a of ACTIONS) expect(can({ actor: 'ad', scopes: [] }, board(), a)).toBe(false);
  });
  it('hard delete: a person with tickets:state (the Claude app) may, nothing else; the board must opt in', () => {
    expect(can({ actor: 'ad', scopes: ['tickets:state'] }, board(), 'delete')).toBe(true);
    expect(
      can({ actor: 'ad', scopes: ['tickets:update', 'tickets:read'] }, board(), 'delete'),
    ).toBe(false);
    expect(
      can(
        { actor: 'ad', scopes: [...SCOPES] },
        board({ settings: { allowDelete: false } }),
        'delete',
      ),
    ).toBe(false);
    expect(can({ actor: 'ad' }, board(), 'delete')).toBe(true);
  });
  it('scopeAllows table', () => {
    expect(scopeAllows(['members:read'], 'read')).toBe(true);
    expect(scopeAllows(['members:read'], 'create')).toBe(false);
  });

  // Every scope, alone, as an ADMIN (role allows everything): exactly these actions.
  const ONLY: Record<Scope, Action[]> = {
    'board:read': ['read'],
    'members:read': ['read'],
    'tickets:read': ['read'],
    'tickets:create': ['read', 'create'],
    'tickets:update': ['read', 'edit'],
    'tickets:move': ['read', 'move'],
    'tickets:assign': ['read', 'assign'],
    // A person's token may also hard delete (personMayHardDelete); presets never list it.
    'tickets:state': ['read', 'state', 'restore', 'delete'],
    'comments:read': ['read'],
    'comments:write': ['read', 'comment', 'pin'],
    'files:read': ['read'],
    'files:write': ['read', 'upload'],
    'questions:write': ['read', 'ask', 'answer'],
    'tasklists:write': ['read', 'tasklist'],
    'status:write': ['read', 'status'],
    'events:read': ['read'],
    'board:admin': ['read', 'admin'],
    'webhooks:manage': ['read', 'admin'],
    // Phase 10 (§R1): account scopes. Only boards:admin reaches a board action.
    'boards:create': ['read'],
    'boards:admin': ['read', 'admin'],
    'agents:write': ['read'],
    'invites:write': ['read'],
    // Artifacts (artifacts.html §C4): not about a board, so no board action.
    'artifacts:read': ['read'],
    'artifacts:write': ['read'],
  };
  it('the table covers every scope', () => {
    expect(Object.keys(ONLY).sort()).toEqual([...SCOPES].sort());
  });
  for (const scope of SCOPES) {
    it(`${scope} alone → ${ONLY[scope].join(', ')}`, () => {
      const allowed = ACTIONS.filter((a) =>
        can({ actor: 'ad', scopes: [scope] }, board(), a, null, null),
      );
      expect(allowed).toEqual(ACTIONS.filter((a) => ONLY[scope].includes(a)));
      expect(actionsForScopes([scope])).toEqual(allowed.filter((a) => a !== 'delete'));
    });
  }

  it('presets', () => {
    expect(actionsForScopes(SCOPE_PRESETS.readOnly)).toEqual(['read']);
    expect(actionsForScopes(SCOPE_PRESETS.worker).sort()).toEqual(
      [
        'comment',
        'edit',
        'move',
        'pin',
        'read',
        'upload',
        'ask',
        'answer',
        'tasklist',
        'status',
      ].sort(),
    );
    expect(actionsForScopes(SCOPE_PRESETS.everything)).not.toContain('admin');
    expect(actionsForScopes(SCOPE_PRESETS.everything)).not.toContain('delete');
    expect(
      presetOf([
        'tickets:read',
        'board:read',
        'members:read',
        'comments:read',
        'files:read',
        'events:read',
      ]),
    ).toBe('readOnly');
    expect(presetOf([...SCOPE_PRESETS.worker])).toBe('worker');
    expect(presetOf([...SCOPE_PRESETS.everything])).toBe('everything');
    expect(presetOf(['board:read'])).toBeNull();
  });
});

const AG = 'ag_Bu1lder000000001';
const AG2 = 'ag_Rev1ewer00000001';
const AG3 = 'ag_Watcher00000001x';
describe('can — agent principals', () => {
  const b = board({
    access: {
      ad: 'admin',
      [AG]: 'commenter',
      [AG2]: 'editor',
      [AG3]: 'viewer',
      ag_Adm1n0000000000x: 'admin',
    },
    stageGrants: { [AG]: { stages: ['review', 'done'], assignedOnly: true } },
  });
  const t = (stageId: string, assigneeUids: string[] = []) => ({ stageId, assigneeUids });

  it('an agent acts by its role in the access map', () => {
    expect(can({ actor: AG2 }, b, 'edit')).toBe(true);
    expect(can({ actor: AG2 }, b, 'assign')).toBe(true);
    expect(can({ actor: AG3 }, b, 'read')).toBe(true);
    expect(can({ actor: AG3 }, b, 'comment')).toBe(false);
    expect(can({ actor: AG }, b, 'comment')).toBe(true);
    expect(can({ actor: AG }, b, 'upload')).toBe(true);
    expect(can({ actor: AG }, b, 'edit')).toBe(false);
  });
  it('an agent not on the board can do nothing', () => {
    expect(can({ actor: 'ag_Stranger0000000x' }, b, 'read')).toBe(false);
  });
  // §AA2 CHANGED THIS. It used to read: "an agent is never admin: an 'admin'
  // entry acts as editor". An agent may now be a board admin, and the role is
  // the permission — effectiveRole no longer downgrades.
  it("§AA2: an agent's 'admin' entry IS admin (no downgrade to editor)", () => {
    expect(effectiveRole(b, 'ag_Adm1n0000000000x')).toBe('admin');
    expect(can({ actor: 'ag_Adm1n0000000000x' }, b, 'admin')).toBe(true);
    expect(can({ actor: 'ag_Adm1n0000000000x' }, b, 'restore')).toBe(true);
    expect(can({ actor: 'ag_Adm1n0000000000x' }, b, 'edit')).toBe(true);
    expect(effectiveRole(b, 'ad')).toBe('admin');
  });
  it('§AA1: an agent token (AGENT_TOKEN_SCOPES, boardIds null) is cut by the ROLE, never by its scopes', () => {
    const tok = (actor: string) => ({ actor, scopes: AGENT_TOKEN_SCOPES, boardIds: null });
    // admin agent: board settings and restore; hard delete is still app-only (no scope grants it).
    expect(can(tok('ag_Adm1n0000000000x'), b, 'admin')).toBe(true);
    expect(can(tok('ag_Adm1n0000000000x'), b, 'restore')).toBe(true);
    expect(
      can(tok('ag_Adm1n0000000000x'), { ...b, settings: { allowDelete: true } }, 'delete'),
    ).toBe(false);
    // editor agent: everything but admin / restore.
    expect(can(tok(AG2), b, 'edit')).toBe(true);
    expect(can(tok(AG2), b, 'admin')).toBe(false);
    // commenter agent: comments, not edits.
    expect(can(tok(AG), b, 'comment')).toBe(true);
    expect(can(tok(AG), b, 'edit')).toBe(false);
    // viewer agent: read only.
    expect(can(tok(AG3), b, 'read')).toBe(true);
    expect(can(tok(AG3), b, 'comment')).toBe(false);
    // not on the board: nothing, whatever the scopes.
    expect(can(tok('ag_Stranger0000000x'), b, 'read')).toBe(false);
  });
  it('§AA1: an agent acting for an owner reaches a board only while that owner is on it', () => {
    // 'ad' is on the board: the agent acts by its own role.
    expect(can({ actor: AG2, ownerUid: 'ad' }, b, 'edit')).toBe(true);
    // the owner is not (or no longer) on it: the agent has nothing there, not even read —
    // a person removed from a board does not keep it through their agent.
    expect(can({ actor: AG2, ownerUid: 'gone' }, b, 'read')).toBe(false);
    expect(
      can({ actor: AG2, ownerUid: 'gone', scopes: AGENT_TOKEN_SCOPES, boardIds: null }, b, 'edit'),
    ).toBe(false);
    expect(canEditTasklist({ actor: AG, ownerUid: 'gone' }, b, { owner: AG })).toBe(false);
    // no ownerUid (the UI asking what an agent could do): not narrowed
    expect(can({ actor: AG2 }, b, 'edit')).toBe(true);
    // a person's own ctx is never affected
    expect(can({ actor: 'ad', ownerUid: 'ad' }, b, 'edit')).toBe(true);
  });
  it('a commenter agent moves only inside its StageGrant, only its own tickets', () => {
    expect(can({ actor: AG }, b, 'move', t('review', [AG]), 'done')).toBe(true);
    expect(can({ actor: AG }, b, 'move', t('review', ['someone']), 'done')).toBe(false);
    expect(can({ actor: AG }, b, 'move', t('todo', [AG]), 'done')).toBe(false);
  });
  it('the token cannot lift the agent: scopes ∩ role', () => {
    const all = { actor: AG, scopes: [...SCOPE_PRESETS.everything], boardIds: ['b1'] };
    expect(can(all, b, 'move', t('todo', [AG]), 'done')).toBe(false);
    expect(can(all, b, 'edit')).toBe(false);
    expect(can(all, b, 'create')).toBe(false);
    expect(can(all, b, 'comment')).toBe(true);
  });
  it('the role cannot lift the token', () => {
    const readOnly = { actor: AG2, scopes: [...SCOPE_PRESETS.readOnly] };
    expect(can(readOnly, b, 'edit')).toBe(false);
    expect(can(readOnly, b, 'read')).toBe(true);
    const worker = { actor: AG2, scopes: [...SCOPE_PRESETS.worker] };
    expect(can(worker, b, 'move', t('todo'), 'done')).toBe(true);
    expect(can(worker, b, 'assign')).toBe(false);
    expect(can(worker, b, 'create')).toBe(false);
  });
  it('a token bound to another board sees nothing here', () => {
    expect(can({ actor: AG2, scopes: ['board:read'], boardIds: ['b2'] }, b, 'read')).toBe(false);
  });
});

describe('can — boardIds narrow', () => {
  it('a key limited to other boards sees nothing here', () => {
    expect(can({ actor: 'ad', boardIds: ['b2'] }, board(), 'read')).toBe(false);
  });
  it('a key including this board acts by role', () => {
    expect(can({ actor: 'ed', boardIds: ['b1', 'b2'] }, board(), 'edit')).toBe(true);
  });
  it('null = every board', () => {
    expect(can({ actor: 'ed', boardIds: null }, board(), 'edit')).toBe(true);
  });
});

/**
 * PHASE 5 (§N) — 'Everything an agent can do through the API, a person can do
 * in the app.' A signed-in person carries NO scopes, so the scope gate that
 * narrows a token must simply not apply to them. These pin that down for the
 * four commands §N adds to the UI: questionAsk, tasklistSet,
 * tasklistItemUpdate and tasklistDelete.
 */
describe('can — a person needs no scope (§N)', () => {
  const b = board();

  it('lets a commenter ask and answer, like an agent with questions:write', () => {
    expect(can({ actor: 'co' }, b, 'ask')).toBe(true);
    expect(can({ actor: 'co' }, b, 'answer')).toBe(true);
    // The same actions through a token need the scope.
    expect(can({ actor: 'co', scopes: ['comments:write'] }, b, 'ask')).toBe(false);
    expect(can({ actor: 'co', scopes: ['questions:write'] }, b, 'ask')).toBe(true);
  });

  it('lets an editor and an admin change any task list', () => {
    for (const uid of ['ed', 'ad']) {
      expect(can({ actor: uid }, b, 'tasklist')).toBe(true);
      expect(canEditTasklist({ actor: uid }, b, { owner: 'ag_0000000000000001' })).toBe(true);
    }
  });

  it("lets a commenter change only their own list — which is what '+ New list' creates", () => {
    expect(canEditTasklist({ actor: 'co' }, b, { owner: 'co' })).toBe(true);
    expect(canEditTasklist({ actor: 'co' }, b, { owner: 'ed' })).toBe(false);
  });

  it('keeps a viewer read-only, person or not', () => {
    expect(can({ actor: 'vi' }, b, 'ask')).toBe(false);
    expect(can({ actor: 'vi' }, b, 'tasklist')).toBe(false);
    expect(canEditTasklist({ actor: 'vi' }, b, { owner: 'vi' })).toBe(false);
  });

  it('refuses a stranger everything, as always', () => {
    expect(can({ actor: 'nobody' }, b, 'ask')).toBe(false);
    expect(canEditTasklist({ actor: 'nobody' }, b, { owner: 'nobody' })).toBe(false);
  });
});
