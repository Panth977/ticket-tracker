import { describe, expect, it } from 'vitest';
import { fileIcon } from './fileIcons';

describe('fileIcon: by name, extension, then kind', () => {
  it('tells common files apart', () => {
    const md = fileIcon({ name: 'notes.md' });
    const ts = fileIcon({ name: 'main.ts' });
    const json = fileIcon({ name: 'data.json' });
    const apk = fileIcon({ name: 'app.apk' });
    expect(new Set([md.icon, ts.icon, json.icon, apk.icon]).size).toBe(4);
    expect(md.tone).not.toBe(ts.tone);
  });
  it('is case-insensitive and knows special names', () => {
    expect(fileIcon({ name: 'PHOTO.JPG' }).icon).toBe(fileIcon({ name: 'a.png' }).icon);
    expect(fileIcon({ name: 'Dockerfile' }).tone).toBe(fileIcon({ name: 'x.yaml' }).tone);
  });
  it('falls back to the mime kind, then a plain file', () => {
    expect(fileIcon({ name: 'clip', mime: 'video/mp4' }).icon).toBe(
      fileIcon({ name: 'a.mp4' }).icon,
    );
    expect(fileIcon({ name: 'blob' }).tone).toBe('text-muted');
  });
});
