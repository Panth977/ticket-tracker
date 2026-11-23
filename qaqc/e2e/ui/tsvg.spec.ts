/**
 * A TSVG VECTOR VIDEO ATTACHMENT PLAYS IN THE THREAD (docs/plan/agents.html §I).
 *
 * An agent uploads a .tsvgz package; the thread's card shows a still frame and its
 * length, and the viewer plays it with the TSVG engine's own controls and options —
 * inside a sandboxed frame (allow-scripts only, srcdoc, opaque origin), so the
 * document can never reach the app or its session. The engine is @panth977/tsvg,
 * one pinned script from esm.sh — this suite needs the network for it.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { SCOPE_PRESETS } from '@tm/shared';
import { API_URL, call, newBoard, newPerson, giveAttachBucket } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const PACKAGE = readFileSync(new URL('../fixtures/hello.tsvgz', import.meta.url));

/** The frame whose iframe matches `selector` (sandboxed frames are reachable to Playwright). */
async function frameOf(page: Page, selector: string): Promise<Frame> {
  const el = await page.waitForSelector(selector);
  const f = await el.contentFrame();
  expect(f).not.toBeNull();
  return f!;
}

/** Average brightness (0–255) of the player canvas: dark theme vs light theme. */
const brightness = (f: Frame) =>
  f.locator('canvas.main').evaluate((el) => {
    // qaqc type-checks without the DOM lib: the canvas, as far as this needs it.
    const c = el as unknown as {
      width: number;
      height: number;
      getContext(k: '2d'): {
        getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      };
    };
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    return sum / (data.length / 4);
  });

test('an agent attaches a .tsvgz; the card shows a frame and the viewer plays it, sandboxed', async ({
  page,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const b = await newBoard(ada, { name: 'Vector video' });
  await giveAttachBucket(ada, b.id);
  const { agentId } = await call(ada, 'agentCreate', {
    name: 'Director',
    description: 'Makes videos',
    systemPrompt: '# Director',
  });
  await call(ada, 'boardAgentSet', { boardId: b.id, agentId, role: 'editor' });
  const { key: token } = await call(ada, 'apiKeyCreate', {
    name: 'orch-director',
    boardId: b.id,
    actsAs: { kind: 'agent', id: agentId },
    scopes: [...SCOPE_PRESETS.worker],
  });
  const t = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Release video' });

  const api = async (path: string, body: object) => {
    const r = await fetch(API_URL + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await r.json()) as { file_id: string; kind?: string };
    expect(r.status, JSON.stringify(json)).toBe(201);
    return json;
  };
  const up = await api(`/v1/tickets/${t.key}/files`, {
    name: 'hello.tsvgz',
    content_base64: PACKAGE.toString('base64'),
  });
  expect(up.kind).toBe('tsvg');
  await api(`/v1/tickets/${t.key}/messages`, {
    body_markdown: 'The release video.',
    attachments: [up.file_id],
  });

  // The frame's CSP lets in the pinned engine and the package's blob: files — nothing it needs is refused.
  const refused: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|integrity/i.test(m.text()))
      refused.push(m.text());
  });
  await signIn(page, ada.email, `/t/${t.key}`);
  const msg = page
    .getByRole('region', { name: 'Thread' })
    .getByRole('article', { name: 'Message from Director' });
  await expect(msg).toBeVisible();

  // ── the card: a still frame from the sandboxed player, and the length ──
  const card = msg.locator('[data-kind="tsvg"]');
  await expect(card).toBeVisible();
  const posterEl = card.locator('iframe[data-tsvg-frame="poster"]');
  await expect(posterEl).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(card).toContainText('0:06');
  const poster = await frameOf(page, '[data-kind="tsvg"] iframe[data-tsvg-frame="poster"]');
  await expect(poster.locator('canvas.main')).toBeVisible();
  await expect(poster.locator('.bar')).toBeHidden();
  await expect.poll(() => brightness(poster)).toBeGreaterThan(5);
  await page.screenshot({ path: test.info().outputPath('tsvg-card.png') });

  // ── the viewer: the full player ──
  await msg.getByRole('button', { name: 'Open hello.tsvgz' }).click();
  const viewer = page.getByRole('dialog', { name: 'Viewing hello.tsvgz' });
  await expect(viewer.locator('iframe[data-tsvg-frame="player"]')).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  );
  const player = await frameOf(page, '[role="dialog"] iframe[data-tsvg-frame="player"]');
  await expect(player.locator('canvas.main')).toBeVisible();
  await expect(player.locator('.time')).toHaveText('0:00 / 0:06');
  await expect(player.locator('.chap')).toContainText('Hello');
  for (const name of ['play', 'back', 'fwd', 'cc', 'rate', 'menu', 'fs'])
    await expect(player.locator(`[data-a="${name}"]`)).toBeVisible();

  // The frame is an opaque origin: no way into the app.
  expect(
    await player.evaluate(() => {
      const w = globalThis as unknown as { origin: string; parent: { document?: unknown } };
      let reach = 'blocked';
      try {
        reach = w.parent.document ? 'parent' : 'none';
      } catch {
        /* cross-origin */
      }
      return { origin: w.origin, reach };
    }),
  ).toEqual({ origin: 'null', reach: 'blocked' });

  // Options: the document's own (Theme) — light is brighter than dark.
  const dark = await brightness(player);
  await player.locator('[data-a="menu"]').click();
  await expect(player.locator('.menu')).toHaveClass(/open/);
  await player.locator('.menu button[data-g="theme"][data-c="light"]').click();
  await expect(player.locator('.menu button[data-g="theme"][data-c="light"]')).toHaveClass(/on/);
  await expect.poll(() => brightness(player)).toBeGreaterThan(dark + 60);
  await page.screenshot({ path: test.info().outputPath('tsvg-options.png') });
  await player.locator('[data-a="menu"]').click();

  // Transport: skip forward to the second chapter, then play.
  await player.locator('[data-a="fwd"]').click();
  await expect(player.locator('.time')).toHaveText('0:06 / 0:06');
  await player.locator('.track').click({ position: { x: 5, y: 9 } });
  await player.locator('[data-a="play"]').click();
  await expect(player.locator('[data-a="play"]')).toHaveText('❚❚');
  await expect(player.locator('.time')).toHaveText(/^0:0[1-6] \/ 0:06$/, { timeout: 5_000 });
  await page.screenshot({ path: test.info().outputPath('tsvg-playing.png') });

  expect(refused).toEqual([]);

  // Escape inside the frame still closes the viewer.
  await player.locator('canvas.main').press('Escape');
  await expect(viewer).toBeHidden();
});
