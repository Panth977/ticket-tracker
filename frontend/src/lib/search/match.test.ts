import { describe, expect, it } from 'vitest';
import { rank, score } from './match';

const t = (key: string, title: string, updatedAt = 0) => ({ key, title, updatedAt });

describe('ticket matching (Typesense rules)', () => {
  it('matches key infix', () => {
    expect(score('42', t('ENG-42', 'Fix login'))).toBeGreaterThan(0);
    expect(score('ng', t('ENG-42', 'Fix login'))).toBeGreaterThan(0);
  });
  it('prefix only on the last word', () => {
    expect(score('log', t('ENG-1', 'Fix login redirect'))).toBeGreaterThan(0);
    expect(score('log redirect', t('ENG-1', 'Fix login redirect'))).toBe(0);
    expect(score('login redi', t('ENG-1', 'Fix login redirect'))).toBeGreaterThan(0);
  });
  it('requires every token', () => {
    expect(score('login billing', t('ENG-1', 'Fix login redirect'))).toBe(0);
  });
  it('ranks key over title, then newest', () => {
    const docs = [
      t('ENG-7', 'Mention 42 in docs', 5),
      t('ENG-42', 'Other', 1),
      t('OPS-42', 'Other', 9),
    ];
    expect(rank('42', docs).map((d) => d.key)).toEqual(['OPS-42', 'ENG-42', 'ENG-7']);
  });
});
