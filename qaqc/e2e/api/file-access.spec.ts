/**
 * FILES ARE SERVED BY THE API (phase 11, docs/plan/agents.html §I).
 *
 * The path that shipped broken had no test: a file an AGENT uploaded (the
 * server writes the blob) could not be read back by the app, because the
 * browser read Storage directly and the Storage rule for attachments needs a
 * cross-service firestore.get() that fails in production — and a failed lookup
 * is a rule error, which is a 403.
 *
 * So: upload .md, .html, an image and a PDF as an agent, then read every one
 * of them exactly as the SPA does — GET /api/files/url with the person's ID
 * token, then the bytes from the URL it answers (whole, and as a Range) —
 * and check that the refusals are refusals.
 */
import { expect, test } from '@playwright/test';
import { SCOPE_PRESETS } from '@tm/shared';
import { API_URL, call, http, newBoard, newPerson, read } from '../support/stack.js';

const bearer = (key: string) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
});

/** A 1×1 transparent PNG. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MD = '# Plan\n\n1. Build it\n2. Ship it\n';
const HTML = '<!doctype html><title>Report</title><h1>Numbers</h1><p>All green.</p>';
const PDF = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;

interface Access {
  url: string;
  bytesUrl: string;
  expiresAt: number;
}

test('a file uploaded by an agent is served to the app through /api/files', async () => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'Files board' });
  const { agentId } = await call(ada, 'agentCreate', {
    name: 'Filer',
    description: 'Uploads things',
    systemPrompt: '# Filer',
  });
  await call(ada, 'boardAgentSet', { boardId: eng.id, agentId, role: 'editor' });
  const { key: token } = await call(ada, 'apiKeyCreate', {
    name: 'orch-filer',
    boardId: eng.id,
    actsAs: { kind: 'agent', id: agentId },
    scopes: [...SCOPE_PRESETS.worker],
  });
  const { ticketId, key: ticketKey } = await call(ada, 'ticketCreate', {
    boardId: eng.id,
    title: 'Ship the report',
    assigneeUids: [agentId],
  });

  // ── the agent uploads, server-side: no browser ever touched these objects ──
  const upload = async (body: object) => {
    const r = await http(`/v1/tickets/${ticketKey}/files`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify(body),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { file_id: string; kind: string };
  };
  const files = {
    md: await upload({ name: 'plan.md', text: MD }),
    html: await upload({ name: 'report.html', text: HTML }),
    png: await upload({ name: 'pixel.png', content_base64: PNG_B64 }),
    pdf: await upload({ name: 'doc.pdf', text: PDF }),
  };
  expect([files.md.kind, files.html.kind, files.png.kind, files.pdf.kind]).toEqual([
    'markdown',
    'html',
    'image',
    'pdf',
  ]);

  const posted = await http(`/v1/tickets/${ticketKey}/messages`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({
      body_markdown: 'Report attached.',
      attachments: [files.md.file_id, files.html.file_id, files.png.file_id, files.pdf.file_id],
    }),
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);

  const pathOf = async (fileId: string) =>
    (await read<{ path: string }>(`boards/${eng.id}/tickets/${ticketId}/files/${fileId}`))!.path;

  /** Exactly what the SPA does: ask the API where the bytes are. */
  const accessFor = async (path: string, who = ada) => {
    const r = await http(`/api/files/url?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${who.token}` },
    });
    return r as { status: number; body: Access; headers: Headers };
  };
  const bytes = (bytesUrl: string, init: RequestInit = {}) => fetch(API_URL + bytesUrl, init);

  // ── every kind reads back, whole and as a Range ──
  for (const [what, id, expected, mime] of [
    ['markdown', files.md.file_id, MD, 'text/markdown'],
    ['html', files.html.file_id, HTML, 'text/html'],
    ['pdf', files.pdf.file_id, PDF, 'application/pdf'],
  ] as const) {
    const path = await pathOf(id);
    const a = await accessFor(path);
    expect(a.status, `${what}: ${JSON.stringify(a.body)}`).toBe(200);
    expect(a.body.expiresAt).toBeGreaterThan(Date.now());
    expect(a.headers.get('cache-control')).toContain('no-store');

    const whole = await bytes(a.body.bytesUrl);
    expect(whole.status, what).toBe(200);
    expect(whole.headers.get('content-type')).toContain(mime);
    expect(await whole.text()).toBe(expected);

    // The viewer reads the first N bytes of a big text file this way.
    const part = await bytes(a.body.bytesUrl, { headers: { range: 'bytes=0-7' } });
    expect(part.status, `${what} range`).toBe(206);
    expect(part.headers.get('content-range')).toBe(
      `bytes 0-7/${new TextEncoder().encode(expected).length}`,
    );
    expect(await part.text()).toBe(expected.slice(0, 8));

    // Download keeps the file's own name.
    const dl = await bytes(`${a.body.bytesUrl}&dl=1`);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
  }

  // The image: bytes identical to what was uploaded, and an <img> src to use.
  const png = await accessFor(await pathOf(files.png.file_id));
  expect(png.status).toBe(200);
  const img = await bytes(png.body.bytesUrl);
  expect(img.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await img.arrayBuffer()).toString('base64')).toBe(PNG_B64);

  // ── refusals ──
  const path = await pathOf(files.md.file_id);
  expect((await http(`/api/files/url?path=${encodeURIComponent(path)}`)).status).toBe(401);

  const stranger = await newPerson('Mallory');
  const refused = await accessFor(path, stranger);
  expect(refused.status, 'a stranger gets a 404, never the bytes').toBe(404);

  const a = await accessFor(path);
  const forged = await bytes(a.body.bytesUrl.replace(/sig=[^&]+/, 'sig=not-the-signature'));
  expect(forged.status).toBe(403);
  const expired = await bytes(a.body.bytesUrl.replace(/exp=\d+/, `exp=${Date.now() - 1000}`));
  expect(expired.status).toBe(403);

  // A path that is not a file of a board we can read is a 404, not a 403 —
  // the API never says whether something exists.
  expect((await accessFor(`boards/${eng.id}/tickets/${ticketId}/nope/ghost.md`)).status).toBe(404);
  expect((await accessFor(`exports/${ada.uid}/job.zip`)).status).toBe(404);
});
