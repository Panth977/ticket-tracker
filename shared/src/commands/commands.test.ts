import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { APP_ERROR_CODES } from '../errors.js';
import { fixtures } from '../schema/fixtures.js';
import { SCOPE_PRESETS, SCOPES, TOKEN_SCOPES } from '../types/index.js';
import {
  bulkActionScope,
  COMMAND_NAMES,
  COMMANDS,
  getCommand,
  patchScopes,
  TOKEN_DENIED_COMMANDS,
  tokenDenied,
  tokenMayCall,
  type CommandReq,
  type CommandRes,
} from './index.js';

/** Every `POST /api/{name}` named in docs/data/{app,platform}/backend.json. */
function specApiCommands(): string[] {
  const names = new Set<string>();
  for (const f of ['app', 'platform']) {
    const spec = JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../docs/data/${f}/backend.json`, import.meta.url)),
        'utf8',
      ),
    ) as { services: { name: string; location?: string }[] };
    for (const s of spec.services) {
      const m = /\/api\/([A-Za-z]+)/.exec(s.location ?? '');
      if (m) names.add(m[1]!);
    }
  }
  return [...names].sort();
}

describe('COMMANDS registry', () => {
  const spec = specApiCommands();

  it('the spec names at least the known 31 commands', () => {
    expect(spec.length).toBeGreaterThanOrEqual(31);
  });

  it('covers every /api command in the spec, with matching names', () => {
    expect(spec.filter((n) => !(n in COMMANDS))).toEqual([]);
  });

  it("anything not in the spec is marked 'extra' (or 'phase2': agents.html, docs/data catching up)", () => {
    const extras = COMMAND_NAMES.filter((n) => !spec.includes(n));
    for (const n of extras) expect(['extra', 'phase2', 'phase3']).toContain(COMMANDS[n].source);
    for (const n of spec) expect(COMMANDS[n as keyof typeof COMMANDS].source).not.toBe('extra');
  });

  it('phase-3 commands are registered (agents.html §L)', () => {
    for (const n of [
      'questionAsk',
      'questionAnswer',
      'questionCancel',
      'tasklistSet',
      'tasklistItemUpdate',
      'tasklistDelete',
      'agentHeartbeat',
    ] as const)
      expect(COMMANDS[n].source).toBe('phase3');
  });

  it('phase-2 commands are registered', () => {
    for (const n of [
      'agentCreate',
      'agentUpdate',
      'agentArchive',
      'boardAgentSet',
      'agentInboxAck',
    ] as const)
      expect(COMMANDS[n].source).toBe('phase2');
  });

  it('token gate: scopes are any-of; commands without scopes are app-only', () => {
    expect(tokenMayCall(COMMANDS.ticketUpdate, ['tickets:move'])).toBe(true);
    expect(tokenMayCall(COMMANDS.ticketUpdate, ['comments:write'])).toBe(false);
    // §R1: agentCreate is reachable now — but only with the ACCOUNT scope
    // agents:write, which only an account token may carry.
    expect(tokenMayCall(COMMANDS.agentCreate, ['agents:write'])).toBe(true);
    expect(tokenMayCall(COMMANDS.agentCreate, [...TOKEN_SCOPES])).toBe(false);
    expect(tokenMayCall(COMMANDS.ticketDelete, [...SCOPES])).toBe(false);
    expect(tokenMayCall(COMMANDS.ticketDelete, undefined)).toBe(true);
    expect(tokenMayCall(COMMANDS.agentInboxAck, ['events:read'])).toBe(true);
    for (const n of COMMAND_NAMES)
      for (const sc of COMMANDS[n].scopes ?? []) expect(SCOPES).toContain(sc);
  });

  /**
   * §R1 THE DENY LIST — the one rule no scope can buy past. Checked by NAME,
   * so that giving one of these commands a scope later still cannot open it
   * to a token: a leaked token can never mint another token.
   */
  it('deny list: no token may ever call these, whatever its scopes', () => {
    for (const n of TOKEN_DENIED_COMMANDS) {
      expect(COMMAND_NAMES).toContain(n);
      expect(tokenDenied(n)).toBe(true);
      // Every scope in the vocabulary at once, and every preset: still no.
      expect(tokenMayCall(COMMANDS[n], [...SCOPES])).toBe(false);
      for (const preset of Object.values(SCOPE_PRESETS))
        expect(tokenMayCall(COMMANDS[n], [...preset])).toBe(false);
      // A token cannot mint a token even if someone later gives the command a scope.
      expect(tokenMayCall({ name: n, scopes: [...SCOPES] }, ['board:read'])).toBe(false);
      // The app itself (no scopes = a full session) still may.
      expect(tokenMayCall(COMMANDS[n], undefined)).toBe(true);
    }
    expect([...TOKEN_DENIED_COMMANDS]).toEqual(
      expect.arrayContaining([
        'apiKeyCreate',
        'apiKeyRevoke',
        'grantRevoke',
        'sessionRevokeAll',
        'accountDelete',
        'accountExport',
        'profileUpdate',
      ]),
    );
    expect(tokenDenied('ticketCreate')).toBe(false);
  });

  it('each entry is well-formed', () => {
    for (const n of COMMAND_NAMES) {
      const c = COMMANDS[n];
      expect(c.name).toBe(n);
      expect(c.permission.length).toBeGreaterThan(3);
      for (const e of c.errors) expect(APP_ERROR_CODES).toContain(e);
    }
    expect(getCommand('nope')).toBeUndefined();
    expect(getCommand('ticketCreate')?.name).toBe('ticketCreate');
    expect(getCommand('toString')).toBeUndefined();
  });
});

describe('request schemas', () => {
  const doc = fixtures.tickets.description!.doc;

  it('ticketCreate: minimal and full; unknown keys rejected', () => {
    expect(COMMANDS.ticketCreate.req.safeParse({ boardId: 'b', title: 'Fix it' }).success).toBe(
      true,
    );
    expect(
      COMMANDS.ticketCreate.req.safeParse({
        boardId: 'b',
        title: 'Fix it',
        description: doc,
        priorityId: null,
        assigneeUids: ['u1'],
        dueAt: 1,
        fields: { f_abc123: ['x'] },
        clientId: 'c-1',
      }).success,
    ).toBe(true);
    expect(
      COMMANDS.ticketCreate.req.safeParse({ boardId: 'b', title: 'x', bogus: 1 }).success,
    ).toBe(false);
    expect(COMMANDS.ticketCreate.req.safeParse({ boardId: 'b', title: '   ' }).success).toBe(false);
  });

  it('ticketUpdate: patch is strict and partial', () => {
    const r = COMMANDS.ticketUpdate.req;
    expect(
      r.safeParse({ boardId: 'b', ticketId: 't', patch: { stageId: 's' }, rank: { after: 't2' } })
        .success,
    ).toBe(true);
    expect(r.safeParse({ boardId: 'b', ticketId: 't', patch: { key: 'ENG-9' } }).success).toBe(
      false,
    );
  });

  it('messagePost requires clientId; messageEdit needs exactly one of body/delete', () => {
    expect(
      COMMANDS.messagePost.req.safeParse({ boardId: 'b', ticketId: 't', body: doc }).success,
    ).toBe(false);
    expect(
      COMMANDS.messagePost.req.safeParse({ boardId: 'b', ticketId: 't', body: doc, clientId: 'x1' })
        .success,
    ).toBe(true);
    const e = COMMANDS.messageEdit.req;
    expect(e.safeParse({ boardId: 'b', ticketId: 't', messageId: 'm', delete: true }).success).toBe(
      true,
    );
    expect(e.safeParse({ boardId: 'b', ticketId: 't', messageId: 'm' }).success).toBe(false);
    expect(
      e.safeParse({ boardId: 'b', ticketId: 't', messageId: 'm', body: doc, delete: true }).success,
    ).toBe(false);
  });

  it('ticketBulk actions, inviteCreate lower-cases, whatsappLink steps', () => {
    expect(
      COMMANDS.ticketBulk.req.safeParse({
        boardId: 'b',
        ticketIds: ['t'],
        action: { type: 'addTag', tagId: 'x' },
      }).success,
    ).toBe(true);
    expect(
      COMMANDS.ticketBulk.req.safeParse({
        boardId: 'b',
        ticketIds: ['t'],
        action: { type: 'nuke' },
      }).success,
    ).toBe(false);
    const inv = COMMANDS.inviteCreate.req.parse({
      boardId: 'b',
      invites: [{ email: 'A@B.com', role: 'viewer' }],
    });
    expect(inv.invites[0]!.email).toBe('a@b.com');
    expect(
      COMMANDS.whatsappLink.req.safeParse({ step: 'send', number: '+919812345678' }).success,
    ).toBe(true);
    expect(COMMANDS.whatsappLink.req.safeParse({ step: 'verify', code: '12345' }).success).toBe(
      false,
    );
  });

  it('boardCreate validates the key; viewSave takes a view without ownerUid', () => {
    expect(COMMANDS.boardCreate.req.safeParse({ name: 'Eng', key: 'ENG' }).success).toBe(true);
    expect(COMMANDS.boardCreate.req.safeParse({ name: 'Eng', key: 'eng' }).success).toBe(false);
    const { ownerUid: _o, ...view } = fixtures.views;
    expect(COMMANDS.viewSave.req.safeParse({ boardId: 'b', view }).success).toBe(true);
    // A client-sent ownerUid is stripped, never trusted: the owner is always the actor.
    const parsed = COMMANDS.viewSave.req.parse({ boardId: 'b', view: fixtures.views });
    expect('ownerUid' in parsed.view).toBe(false);
  });

  it('empty-request commands accept {} and a clientId', () => {
    expect(COMMANDS.searchKey.req.safeParse({}).success).toBe(true);
    expect(COMMANDS.accountExport.req.safeParse({ clientId: 'abc' }).success).toBe(true);
  });

  it('patchScopes / bulkActionScope name what a token needs', () => {
    expect(patchScopes({ stageId: 's' })).toEqual(['tickets:move']);
    expect(patchScopes({ assigneeUids: ['ag_Bu1lder000000001'], title: 'x' }).sort()).toEqual([
      'tickets:assign',
      'tickets:update',
    ]);
    expect(patchScopes({})).toEqual([]);
    expect(bulkActionScope({ type: 'state', state: 'archived' })).toBe('tickets:state');
    expect(bulkActionScope({ type: 'addTag', tagId: 't' })).toBe('tickets:update');
  });

  it('messagePost takes fileIds alongside Storage paths, ≤ 20 together', () => {
    const base = { boardId: 'b', ticketId: 't', body: doc, clientId: 'x1' };
    expect(COMMANDS.messagePost.req.safeParse({ ...base, fileIds: ['f1', 'f2'] }).success).toBe(
      true,
    );
    const paths = Array.from({ length: 15 }, (_, i) => `boards/b/tickets/t/a${i}/x.png`);
    const ids = Array.from({ length: 6 }, (_, i) => `f${i}`);
    expect(
      COMMANDS.messagePost.req.safeParse({ ...base, attachments: paths, fileIds: ids }).success,
    ).toBe(false);
  });

  it('messagePost takes a turn receipt (§Y1) and rejects a malformed one', () => {
    const base = { boardId: 'b', ticketId: 't', body: doc, clientId: 'x1' };
    const run = {
      n: 3,
      outcome: 'review',
      costUsd: 1.24,
      sessionUsd: 21.1,
      durationMs: 743000,
      apiTurns: 46,
      model: 'claude-fable-5-1',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    };
    expect(COMMANDS.messagePost.req.safeParse({ ...base, run }).success).toBe(true);
    expect(COMMANDS.messagePost.req.safeParse({ ...base, run: null }).success).toBe(true);
    expect(
      COMMANDS.messagePost.req.safeParse({ ...base, run: { ...run, usage: null, model: null } })
        .success,
    ).toBe(true);
    expect(COMMANDS.messagePost.req.safeParse({ ...base, run: { ...run, n: 0 } }).success).toBe(
      false,
    );
    expect(
      COMMANDS.messagePost.req.safeParse({ ...base, run: { ...run, outcome: 'done' } }).success,
    ).toBe(false);
    expect(
      COMMANDS.messagePost.req.safeParse({ ...base, run: { ...run, costUsd: -0.5 } }).success,
    ).toBe(false);
    // The receipt is a token's thing, but the command itself stays reachable with comments:write.
    expect(tokenMayCall(COMMANDS.messagePost, ['comments:write'])).toBe(true);
  });

  it('apiKeyCreate v2: one board, actsAs, scopes; agent tokens never admin', () => {
    const r = COMMANDS.apiKeyCreate.req;
    const ok = r.parse({ name: 'orch', boardId: 'b', scopes: ['tickets:read'] });
    expect(ok.actsAs).toEqual({ kind: 'user' });
    expect(
      r.safeParse({
        name: 'orch',
        boardId: 'b',
        actsAs: { kind: 'agent', id: 'ag_Bu1lder000000001' },
        scopes: [...SCOPE_PRESETS.worker],
        expiresInDays: 30,
      }).success,
    ).toBe(true);
    expect(
      r.safeParse({
        name: 'orch',
        boardId: 'b',
        actsAs: { kind: 'agent', id: 'ag_Bu1lder000000001' },
        scopes: ['board:admin'],
      }).success,
    ).toBe(false);
    expect(
      r.safeParse({
        name: 'orch',
        boardId: 'b',
        actsAs: { kind: 'agent', id: 'nope' },
        scopes: ['board:read'],
      }).success,
    ).toBe(false);
    expect(r.safeParse({ name: 'orch', boardIds: ['b'], scopes: ['board:read'] }).success).toBe(
      false,
    );
    expect(r.safeParse({ name: 'orch', boardId: 'b', scopes: ['tickets:write'] }).success).toBe(
      false,
    );
    expect(r.safeParse({ name: 'orch', boardId: 'b', scopes: [] }).success).toBe(false);
  });

  it('agent commands', () => {
    expect(
      COMMANDS.agentCreate.req.safeParse({ name: 'Builder', systemPrompt: '# Hi' }).success,
    ).toBe(true);
    expect(COMMANDS.agentCreate.req.safeParse({ name: '  ' }).success).toBe(false);
    expect(
      COMMANDS.agentCreate.req.safeParse({ name: 'x', systemPrompt: 'a'.repeat(50_001) }).success,
    ).toBe(false);
    expect(
      COMMANDS.agentUpdate.req.safeParse({ agentId: 'ag_Bu1lder000000001', description: null })
        .success,
    ).toBe(true);
    expect(COMMANDS.agentArchive.req.parse({ agentId: 'ag_Bu1lder000000001' }).action).toBe(
      'archive',
    );
    const set = COMMANDS.boardAgentSet.req;
    expect(
      set.safeParse({
        boardId: 'b',
        agentId: 'ag_Bu1lder000000001',
        role: 'commenter',
        stageGrant: { stages: ['s'] },
      }).success,
    ).toBe(true);
    expect(
      set.safeParse({ boardId: 'b', agentId: 'ag_Bu1lder000000001', role: null }).success,
    ).toBe(true);
    expect(
      set.safeParse({ boardId: 'b', agentId: 'ag_Bu1lder000000001', role: 'admin' }).success,
    ).toBe(false);
    const ack = COMMANDS.agentInboxAck.req;
    expect(ack.safeParse({ agentId: 'ag_Bu1lder000000001', ids: ['e1'] }).success).toBe(true);
    expect(ack.safeParse({ agentId: 'ag_Bu1lder000000001', upTo: 'e9' }).success).toBe(true);
    expect(ack.safeParse({ agentId: 'ag_Bu1lder000000001' }).success).toBe(false);
    expect(ack.safeParse({ agentId: 'ag_Bu1lder000000001', ids: ['e1'], upTo: 'e9' }).success).toBe(
      false,
    );
  });

  it('types line up', () => {
    expectTypeOf<CommandReq<'ticketCreate'>['title']>().toEqualTypeOf<string>();
    expectTypeOf<CommandRes<'ticketCreate'>['key']>().toEqualTypeOf<`${string}-${number}`>();
    expectTypeOf<CommandRes<'boardUpdate'>>().toEqualTypeOf<{ ok: true }>();
  });
});
