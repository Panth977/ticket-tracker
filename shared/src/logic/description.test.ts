import { describe, expect, it } from 'vitest';
import { DESCRIPTION_MAX } from '../types/indicator.js';
import { descriptionText } from './description.js';
import { parseRichText } from './richtext/index.js';

const doc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Ship ' },
        { type: 'text', text: 'fast', marks: [{ type: 'bold' }] },
      ],
    },
  ],
};

describe('descriptionText', () => {
  it('plain text is trimmed; blank is null', () => {
    expect(descriptionText('  hi  ')).toBe('hi');
    expect(descriptionText('   ')).toBeNull();
    expect(descriptionText(null)).toBeNull();
    expect(descriptionText(undefined)).toBeNull();
  });
  it('a bare doc and a stored RichText flatten to Markdown', () => {
    expect(descriptionText(doc)).toBe('Ship **fast**');
    expect(descriptionText(parseRichText(doc))).toBe('Ship **fast**');
    expect(descriptionText({ type: 'doc', content: [] })).toBeNull();
  });
  it('an invalid doc falls back to the stored text', () => {
    expect(
      descriptionText({ doc: { type: 'doc', content: [{ type: 'nope' }] }, text: 'Old' }),
    ).toBe('Old');
  });
  it('never longer than DESCRIPTION_MAX', () => {
    expect(descriptionText('x'.repeat(DESCRIPTION_MAX + 50))!.length).toBe(DESCRIPTION_MAX);
  });
});
