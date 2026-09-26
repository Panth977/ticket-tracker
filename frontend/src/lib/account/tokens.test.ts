import { describe, expect, it } from 'vitest';
import { ACCOUNT_SCOPES, SCOPE_PRESETS, TOKEN_SCOPES } from '@tm/shared';
import {
  ACCOUNT_DEFAULT_EXPIRY,
  ACCOUNT_SCOPE_SECTION,
  apiBase,
  choiceOf,
  EXPIRY_OPTIONS,
  expiryIsRisky,
  presetsFor,
  revokedReasonLabel,
  SCOPE_SECTIONS,
  scopesSummary,
  scopesTooltip,
  toggleScope,
  tokenDraftErrors,
  tokenKindLabel,
  tokenRequest,
  withChoice,
  type TokenDraft,
} from './tokens';

const AG = 'ag_AAAAAAAAAAAAAAAA';
const draft = (o: Partial<TokenDraft> = {}): TokenDraft => ({
  name: 'orch-eng-builder',
  kind: 'board',
  boardId: 'b1',
  actsAs: 'agent',
  agentId: AG,
  scopes: [...SCOPE_PRESETS.worker],
  expiry: '90',
  ...o,
});

describe('token form (agents.html §E)', () => {
  it('offers never / 30 / 90 / 365 days', () => {
    expect(EXPIRY_OPTIONS.map((o) => o.value)).toEqual(['never', '30', '90', '365']);
  });
  it('shows every token scope exactly once', () => {
    expect(SCOPE_SECTIONS.flatMap((s) => s.scopes).sort()).toEqual([...TOKEN_SCOPES].sort());
  });
  it('toggles scopes in vocabulary order', () => {
    expect(toggleScope(['tickets:read'], 'board:read', true)).toEqual([
      'board:read',
      'tickets:read',
    ]);
    expect(toggleScope(['board:read', 'tickets:read'], 'board:read', false)).toEqual([
      'tickets:read',
    ]);
  });
  it('validates a draft', () => {
    expect(tokenDraftErrors(draft())).toEqual({});
    expect(
      Object.keys(
        tokenDraftErrors(draft({ name: ' ', boardId: null, agentId: null, scopes: [] })),
      ).sort(),
    ).toEqual(['agentId', 'boardId', 'name', 'scopes']);
    expect(tokenDraftErrors(draft({ scopes: ['board:read', 'webhooks:manage'] })).scopes).toMatch(
      /admin/,
    );
    expect(
      tokenDraftErrors(
        draft({ actsAs: 'me', agentId: null, scopes: ['board:read', 'webhooks:manage'] }),
      ),
    ).toEqual({});
  });
  it('builds the apiKeyCreate request', () => {
    expect(tokenRequest(draft())).toEqual({
      name: 'orch-eng-builder',
      kind: 'board',
      boardId: 'b1',
      actsAs: { kind: 'agent', id: AG },
      scopes: [...SCOPE_PRESETS.worker],
      expiresInDays: 90,
    });
    const me = tokenRequest(draft({ actsAs: 'me', expiry: 'never', scopes: ['board:read'] }));
    expect(me).toEqual({
      name: 'orch-eng-builder',
      kind: 'board',
      boardId: 'b1',
      actsAs: { kind: 'user' },
      scopes: ['board:read'],
    });
  });
  it('summarises scopes for the list', () => {
    expect(scopesSummary([...SCOPE_PRESETS.readOnly])).toBe('Read only');
    expect(scopesSummary([...SCOPE_PRESETS.everything])).toBe('Everything');
    expect(scopesSummary(['board:read', 'tickets:read'])).toBe('2 permissions');
    expect(scopesSummary(['board:read', 'webhooks:manage'])).toBe('1 permission + admin');
    expect(scopesSummary([...SCOPE_PRESETS.fullAccount])).toBe('Full account');
    expect(scopesSummary(['board:read', 'boards:create'])).toBe('1 permission + account');
    expect(scopesTooltip(['tickets:move', 'board:read'])).toMatch(
      /^board:read — .+\ntickets:move — /,
    );
  });
  it('explains revocations', () => {
    expect(revokedReasonLabel('agentArchived')).toMatch(/archived/);
    expect(revokedReasonLabel('agentRemoved')).toMatch(/left the board/);
    expect(revokedReasonLabel(null)).toBe('Revoked');
  });
  it('picks the API base', () => {
    expect(apiBase(undefined, 'http://127.0.0.1:5190')).toBe('http://127.0.0.1:5190');
    expect(apiBase('https://api.example.com/', 'x')).toBe('https://api.example.com');
  });
});

/**
 * §R1 — THE THIRD CHOICE. An account token has no board, always acts as the
 * person, may carry the account scopes, and is created deliberately: it
 * starts with an expiry, and 'never' is flagged.
 */
describe('account tokens (agents.html §R1)', () => {
  const acc = (o: Partial<TokenDraft> = {}): TokenDraft =>
    draft({
      kind: 'account',
      boardId: null,
      actsAs: 'me',
      agentId: null,
      scopes: [...SCOPE_PRESETS.fullAccount],
      ...o,
    });

  it('offers three choices, and switching between them keeps the draft legal', () => {
    expect(choiceOf(draft())).toBe('agent');
    expect(choiceOf(draft({ actsAs: 'me' }))).toBe('me');
    expect(choiceOf(acc())).toBe('account');

    // board · agent → account: the board, the agent and the admin scopes go.
    const toAccount = withChoice(draft({ scopes: ['board:read', 'webhooks:manage'] }), 'account');
    expect(toAccount.kind).toBe('account');
    expect(toAccount.boardId).toBe(null);
    expect(toAccount.agentId).toBe(null);
    expect(toAccount.actsAs).toBe('me');
    expect(toAccount.scopes).toEqual(['board:read']);

    // account → board: the account scopes go, because a board token may not carry them.
    const back = withChoice(acc(), 'me');
    expect(back.kind).toBe('board');
    expect(back.scopes.some((s) => (ACCOUNT_SCOPES as readonly string[]).includes(s))).toBe(false);
    expect(back.scopes).toEqual([...SCOPE_PRESETS.everything]);
  });

  it("an account token starts with an expiry, and 'never' is flagged in red", () => {
    expect(ACCOUNT_DEFAULT_EXPIRY).toBe('90');
    // Choosing 'account' while 'never' is selected moves it back to 90 days.
    expect(withChoice(draft({ expiry: 'never' }), 'account').expiry).toBe('90');
    // 'never' is still POSSIBLE — it just says so.
    expect(EXPIRY_OPTIONS.map((o) => o.value)).toContain('never');
    expect(expiryIsRisky('account', 'never')).toBe(true);
    expect(expiryIsRisky('account', '90')).toBe(false);
    expect(expiryIsRisky('board', 'never')).toBe(false);
  });

  it('needs no board, and refuses account scopes on a board token', () => {
    expect(tokenDraftErrors(acc())).toEqual({});
    // No boardId is not an error here — it is the point.
    expect(tokenDraftErrors(acc({ boardId: null })).boardId).toBeUndefined();
    expect(
      tokenDraftErrors(draft({ actsAs: 'me', scopes: ['board:read', 'boards:create'] })).scopes,
    ).toMatch(/[Aa]ccount/);
    expect(tokenDraftErrors(acc({ name: '  ' })).name).toBeTruthy();
    expect(tokenDraftErrors(acc({ scopes: [] })).scopes).toBeTruthy();
  });

  it("builds an apiKeyCreate request with kind 'account' and no board", () => {
    expect(tokenRequest(acc())).toEqual({
      name: 'orch-eng-builder',
      kind: 'account',
      boardId: null,
      actsAs: { kind: 'user' },
      scopes: [...SCOPE_PRESETS.fullAccount],
      expiresInDays: 90,
    });
    // A board token never carries an account scope, even if one sneaks in.
    expect(
      tokenRequest(draft({ actsAs: 'me', scopes: ['board:read', 'boards:admin'] })).scopes,
    ).toEqual(['board:read']);
  });

  it('offers the right presets and the account checkboxes', () => {
    expect(presetsFor('account').map((p) => p.id)).toEqual(['readOnly', 'worker', 'fullAccount']);
    expect(presetsFor('board').map((p) => p.id)).toEqual(['readOnly', 'worker', 'everything']);
    expect(ACCOUNT_SCOPE_SECTION.scopes).toEqual([...ACCOUNT_SCOPES]);
    // The account checkboxes are NOT among the board ones.
    for (const s of ACCOUNT_SCOPE_SECTION.scopes)
      expect(SCOPE_SECTIONS.flatMap((x) => x.scopes)).not.toContain(s);
    expect(tokenKindLabel('account')).toBe('Account token');
    expect(tokenKindLabel('board')).toBe('Board token');
  });
});
