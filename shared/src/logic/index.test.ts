import { describe, expect, it } from 'vitest';
import * as logic from './index.js';

describe('@tm/shared logic barrel', () => {
  it.each([
    'can',
    'scopeAllows',
    'between',
    'rankAt',
    'applyView',
    'matchesFilter',
    'sortTickets',
    'richTextExtensions',
    'richTextSchema',
    'validateDoc',
    'derive',
    'parseRichText',
    'markdownToDoc',
    'docToMarkdown',
    'diff',
    'parseQuickAdd',
    'resolveQuickAdd',
    'dueSoon',
    'inQuietHours',
    'nextAfterQuietHours',
    'parseDue',
    'isBoardKey',
    'isTicketKey',
    'parseTicketKey',
  ])('exports %s', (name) => {
    expect(logic).toHaveProperty(name);
  });
});
