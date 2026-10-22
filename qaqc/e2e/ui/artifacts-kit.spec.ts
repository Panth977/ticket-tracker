/**
 * KIT ARTIFACTS, end to end (docs/plan/artifacts.html §L): a build that
 * carries artifact.json runs in the Sandbox Environment kit's frame instead of
 * the classic iframe, and reaches the stores through the same broker —
 * over the kit's bridge — as the owner and as a read-only viewer. Then the
 * Code tab: a starter, the live preview, Publish, and the Website running it.
 */
import { expect, test } from '@playwright/test';
import { call, newPerson } from '../support/stack.js';
import { signIn } from '../support/ui.js';

/** A compiled artifact (the kit's CompiledArtifact), hand-written: plain JS needs no compiler. */
function compiled(code: string) {
  return {
    protocol: 1,
    entry: 'sbx:/index.js',
    modules: { 'sbx:/index.js': code },
    css: [],
    imports: {},
    manifest: { name: 'Kit E2E' },
  };
}

const APP = `
import { host } from "@panth977/sandbox/artifact";
const root = document.getElementById("root");
root.innerHTML = '<h1 id="who">…</h1><p id="ro"></p><p id="sandbox"></p><button class="sbx-btn" id="add">Add</button>' +
  '<p id="error"></p><ul id="items"></ul><p id="kit"></p>';
const $ = (id) => document.getElementById(id);
let storage = "blocked";
try { localStorage.setItem("x", "1"); storage = "OPEN"; } catch {}
$("sandbox").textContent = "localStorage " + storage + ", origin " + self.origin;
$("kit").textContent = customElements.get("sbx-select") ? "ui kit" : "no kit";
const me = await host.me();
$("who").textContent = me.name + " (" + me.role + ")";
$("ro").textContent = "readOnly " + me.readOnly;
$("add").onclick = () => host.db.add("/items", { by: me.role, at: Date.now() }).catch((e) => ($("error").textContent = e.code));
for (const bad of ["../../../users/x", "/a/../b"]) {
  try { await host.db.get(bad); $("error").textContent = "ESCAPED " + bad; } catch {}
}
for await (const docs of host.db.watchList("/items", { orderBy: ["at", "asc"] })) {
  $("items").innerHTML = docs.map((d) => "<li>" + d.data.by + "</li>").join("");
}
`;

test('a kit build: runs in the kit frame, live data through the broker, read-only viewer', async ({
  page,
  browser,
}) => {
  const owner = await newPerson('Kira');
  const viewer = await newPerson('Vito');
  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Kit E2E' });
  await call(owner, 'artifactPublish', {
    artifactId,
    files: [
      { path: 'index.html', content: '<p>open in the app</p>' },
      { path: 'artifact.json', content: JSON.stringify(compiled(APP)) },
      { path: 'sbx-src.json', content: JSON.stringify({ files: { '/index.js': APP } }) },
    ],
  });

  await signIn(page, owner.email, `/x/${artifactId}`);
  await expect(page.locator('[data-kit]')).toBeVisible();
  const frame = page.frameLocator('[data-kit] iframe');
  await expect(frame.locator('#who')).toHaveText(/\(owner\)$/);
  await expect(frame.locator('#kit')).toHaveText('ui kit');
  await expect(frame.locator('#sandbox')).toHaveText('localStorage blocked, origin null');
  await expect(frame.locator('#error')).toHaveText('');
  const sandbox = await page.locator('[data-kit] iframe').getAttribute('sandbox');
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  await frame.locator('#add').click();
  await expect(frame.locator('#items li')).toHaveText(['owner']);

  // a viewer, read-only, in a second browser: sees the data live, cannot write
  await call(owner, 'artifactShare', { artifactId, email: viewer.email, role: 'viewer' });
  await call(owner, 'artifactUpdate', { artifactId, readOnly: true });
  const ctx = await browser.newContext();
  const page2 = await ctx.newPage();
  await signIn(page2, viewer.email, `/x/${artifactId}`);
  const frame2 = page2.frameLocator('[data-kit] iframe');
  await expect(frame2.locator('#who')).toHaveText(/\(viewer\)$/);
  await expect(frame2.locator('#ro')).toHaveText('readOnly true');
  await expect(frame2.locator('#items li')).toHaveText(['owner']);
  await frame2.locator('#add').click();
  await expect(frame2.locator('#error')).toHaveText('permission-denied');
  await frame.locator('#add').click();
  await expect(frame2.locator('#items li')).toHaveText(['owner', 'owner']);
  // no Code tab for a viewer's data
  await page2.goto(`/x/${artifactId}?tab=code`);
  await expect(page2.getByText(/only the artifact's owner and editors/i)).toBeVisible();
  await ctx.close();
});

test('the Code tab: a starter, the live preview, Publish, the Website runs it', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await newPerson('Cody');
  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Coded' });
  await signIn(page, owner.email, `/x/${artifactId}?tab=code`);
  await page.getByRole('button', { name: 'TypeScript' }).click();
  // the dev engine: editor + preview (TypeScript comes from the CDN on first build)
  await expect(page.locator('sbx-editor')).toBeVisible();
  const preview = page.frameLocator('.sbx-dev__preview iframe');
  await expect(preview.locator('h1')).toHaveText('Notes', { timeout: 60_000 });
  await preview.locator('input[name=text]').fill('from the preview');
  await preview.getByRole('button', { name: 'Add' }).click();
  await expect(preview.locator('sbx-table')).toContainText('from the preview');

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/is current/i)).toBeVisible({ timeout: 60_000 });

  await page.goto(`/x/${artifactId}`);
  const site = page.frameLocator('[data-kit] iframe');
  await expect(site.locator('h1')).toHaveText('Notes');
  // the same artifact data the preview wrote
  await expect(site.locator('sbx-table')).toContainText('from the preview');

  // the Code tab now opens the published source
  await page.goto(`/x/${artifactId}?tab=code`);
  await expect(page.getByText(/From build/)).toBeVisible();
});
