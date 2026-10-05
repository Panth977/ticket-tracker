import { describe, expect, it } from 'vitest';
import {
  attachTemplateProblem,
  attachTime,
  DEFAULT_ATTACH_TEMPLATE,
  extensionOf,
  fillAttachTemplate,
  fillTicketKey,
  numberedPath,
  random6,
} from './attach.js';

const at = Date.UTC(2026, 9, 5, 21, 19, 46);
const v = { ticketKey: 'ENG-42', at, random6: 'k3x9q2', filename: 'photo.png' };

describe('ticket attachment templates (memory.html §J)', () => {
  it('fills every variable', () => {
    expect(fillAttachTemplate(DEFAULT_ATTACH_TEMPLATE, v)?.path).toBe(
      'tickets/ENG-42/20261005-211946_photo.png',
    );
    expect(fillAttachTemplate('a/<random6>.<exe>', v)?.path).toBe('a/k3x9q2.png');
    expect(fillAttachTemplate('a/<random6>.<ext>', v)?.path).toBe('a/k3x9q2.png');
  });
  it('says where the filename landed, for the cursor', () => {
    const f = fillAttachTemplate(' /tickets//<ticketId>/<time>_<filename> ', v)!;
    expect(f.path).toBe('tickets/ENG-42/20261005-211946_photo.png');
    expect(f.path.slice(...f.name!)).toBe('photo.png');
    expect(fillAttachTemplate('x/<random6>', v)!.name).toBeNull();
  });
  it('leaves <ticketId> for the server when the key is not known yet', () => {
    const f = fillAttachTemplate(DEFAULT_ATTACH_TEMPLATE, { ...v, ticketKey: null })!;
    expect(f.path).toBe('tickets/<ticketId>/20261005-211946_photo.png');
    expect(fillTicketKey(f.path, 'ENG-7')).toBe('tickets/ENG-7/20261005-211946_photo.png');
  });
  it('keeps a file name to one segment', () => {
    expect(fillAttachTemplate('<filename>', { ...v, filename: 'a/b\\c.txt' })?.path).toBe(
      'a_b_c.txt',
    );
  });
  it('validates templates', () => {
    expect(attachTemplateProblem(DEFAULT_ATTACH_TEMPLATE)).toBeNull();
    expect(attachTemplateProblem('x/<board>/<filename>')).toMatch(/not a variable/);
    expect(attachTemplateProblem('x/<filename')).toMatch(/not a variable/);
    expect(attachTemplateProblem('../<filename>')).toMatch(/can't be used/);
    expect(attachTemplateProblem('  ')).toBe('Give a path');
  });
  it('helpers', () => {
    expect(attachTime(at)).toBe('20261005-211946');
    expect(random6()).toMatch(/^[a-z0-9]{6}$/);
    expect(extensionOf('a.tar.gz')).toBe('gz');
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('.env')).toBe('');
    expect(numberedPath('a/b.png', 2)).toBe('a/b (2).png');
    expect(numberedPath('a/README', 3)).toBe('a/README (3)');
  });
});
