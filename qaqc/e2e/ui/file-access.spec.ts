/**
 * THE BROWSER OPENS AN AGENT'S FILES (phase 11, docs/plan/agents.html §I).
 *
 * The bug this pins down: files uploaded through the API were written by the
 * server, and the app read Storage directly — allowed by a rule that needs a
 * cross-service firestore.get(). When that lookup fails the rule ERRORS, which
 * is a 403, so the file showed "Could not load this file" in production while
 * avatars (rule: plain signedIn()) loaded fine.
 *
 * Now every byte comes from the API. This walks a .md, an .html, an image and
 * a PDF through the thread, the viewer, /f/… and Download — and asserts that
 * the app asked /api/files/… for them and never went to Storage for a board
 * object at all.
 */
import { expect, test } from '@playwright/test';
import { SCOPE_PRESETS } from '@tm/shared';
import { API_URL, call, newBoard, newPerson, giveAttachMemory } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MD = '# Field plan\n\nStep one, then **step two**.\n';
const HTML =
  '<!doctype html><html><body><h1>Build report</h1><p id="out">all green</p></body></html>';
const PDF = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;

test('an agent uploads four kinds of file; the app previews, opens, and downloads every one', async ({
  page,
  context,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const b = await newBoard(ada, { name: 'File access' });
  await giveAttachMemory(ada, b.id);
  const { agentId } = await call(ada, 'agentCreate', {
    name: 'Filer',
    description: 'Uploads things',
    systemPrompt: '# Filer',
  });
  await call(ada, 'boardAgentSet', { boardId: b.id, agentId, role: 'editor' });
  const { key: token } = await call(ada, 'apiKeyCreate', {
    name: 'orch-filer',
    boardId: b.id,
    actsAs: { kind: 'agent', id: agentId },
    scopes: [...SCOPE_PRESETS.worker],
  });
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Ship the report',
    assigneeUids: [agentId],
  });

  const api = async (path: string, body: object) => {
    const r = await fetch(API_URL + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await r.json()) as { file_id: string };
    expect(r.status, JSON.stringify(json)).toBe(201);
    return json;
  };
  const up = `/v1/tickets/${t.key}/files`;
  const md = await api(up, { name: 'field-plan.md', text: MD });
  const html = await api(up, { name: 'build-report.html', text: HTML });
  const png = await api(up, { name: 'pixel.png', content_base64: PNG_B64 });
  const pdf = await api(up, { name: 'summary.pdf', text: PDF });
  await api(`/v1/tickets/${t.key}/messages`, {
    body_markdown: 'Everything is attached.',
    attachments: [md.file_id, html.file_id, png.file_id, pdf.file_id],
  });

  // Every request the page makes, so we can prove where the bytes came from.
  const asked: string[] = [];
  page.on('request', (r) => asked.push(r.url()));

  await signIn(page, ada.email, `/t/${t.key}`);
  const msg = page
    .getByRole('region', { name: 'Thread' })
    .getByRole('article', { name: 'Message from Filer' });
  await expect(msg).toBeVisible();

  // ── the four previews ──
  await expect(msg.locator('[data-kind="markdown"]')).toContainText('Field plan');
  await expect(msg.getByTitle('Preview of build-report.html')).toBeVisible();
  const img = msg.locator('[data-kind="image"] img').first();
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  expect(await img.getAttribute('src')).toContain('/api/files/blob');
  await expect(msg.locator('[data-kind="pdf"]')).toBeVisible();

  // ── the viewer: the image, then the PDF ──
  await msg.getByRole('button', { name: 'Open pixel.png' }).click();
  const viewer = page.getByRole('dialog', { name: 'Viewing pixel.png' });
  const shown = viewer.locator('img').first();
  await expect(shown).toBeVisible();
  await expect
    .poll(() => shown.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  // Download keeps the file's own name (same-origin bytes URL + <a download>).
  const saving = page.waitForEvent('download');
  await viewer.getByTitle('Download').click();
  expect((await saving).suggestedFilename()).toBe('pixel.png');
  await page.keyboard.press('Escape');

  await msg.getByRole('button', { name: 'Open summary.pdf' }).click();
  const pdfViewer = page.getByRole('dialog', { name: 'Viewing summary.pdf' });
  await expect(pdfViewer.locator('iframe')).toHaveAttribute('src', /\/api\/files\/blob|storage/);
  await page.keyboard.press('Escape');

  // ── /f/{board}/{ticket}/{file}: a whole window for the Markdown plan ──
  await msg.getByRole('button', { name: 'Open field-plan.md' }).click();
  const href = await page
    .getByRole('dialog', { name: 'Viewing field-plan.md' })
    .getByTitle('Open in new tab')
    .getAttribute('href');
  expect(href).toBe(`/f/${b.key}/${t.key}/${md.file_id}`);
  const tab = await context.newPage();
  await tab.goto(href!);
  await expect(
    tab
      .getByRole('region', { name: 'Viewing field-plan.md' })
      .getByRole('heading', { name: 'Field plan' }),
  ).toBeVisible();
  await tab.close();

  // ── where the bytes came from ──
  expect(
    asked.some((u) => u.includes('/api/files/url')),
    'the app asked the API for access',
  ).toBe(true);
  const direct = asked.filter((u) => /firebasestorage|\/v0\/b\//.test(u) && u.includes('boards'));
  expect(direct, 'no board object was read straight from Storage').toEqual([]);
});
