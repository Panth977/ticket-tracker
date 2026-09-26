/**
 * PHASE 4 END TO END (docs/plan/agents.html §M): a real orchestrator, written
 * with nothing but the hosted SDK, driving a ticket while a person watches it
 * happen in the browser.
 *
 * The orchestrator is not written here. It is qaqc/orch-sample — a project of
 * its own that installs the npm tarball from sdk/dist, exactly as a consumer
 * outside this repo does — and this test spawns that compiled file with a
 * token and an emulator URL, nothing else:
 *
 *   UI   Ada assigns her agent → the inbox event wakes tm.work()
 *   SDK  tm.tasklists.set → the plan appears in the right pane, live
 *   SDK  heartbeat → 🟢 Working, then 🟡 Idle while it waits for the answer
 *   SDK  tm.questions.ask(blocking) → the form card in the thread
 *   UI   Ada answers it in the browser
 *   SDK  waitForAnswer resolves → report.md + report.html uploaded, posted as
 *        one message, the ticket moved because the answer asked for it
 *   UI   both documents preview in the thread; the plan reads 4 / 4; ⚪ Finished
 *   ——   and the process exits 0 with { handled: 1, failed: 0 }
 *
 * Everything asserted on the screen is the app's own live listeners: the page
 * is opened BEFORE the orchestrator starts and never reloaded.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { SCOPE_PRESETS } from '@tm/shared';
import { API_URL, call, eventually, newBoard, newPerson, stage, text } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SAMPLE = `${REPO}qaqc/orch-sample`;

/** One line of the orchestrator's JSON log. */
interface Step {
  step: string;
  [k: string]: unknown;
}

/** The sample orchestrator, running as its own process against the emulators. */
class Orchestrator {
  readonly steps: Step[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<number>;
  private rest = '';
  /** Everything it printed, for a failure message worth reading. */
  private log = '';

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [`${SAMPLE}/dist/orchestrator.js`], {
      cwd: SAMPLE,
      env: { ...process.env, ...env },
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.log += chunk;
      this.rest += chunk;
      const lines = this.rest.split('\n');
      this.rest = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.steps.push(JSON.parse(line) as Step);
        } catch {
          /* anything that is not a JSON line is just output */
        }
      }
    });
    this.child.stderr.on('data', (chunk: string) => (this.log += chunk));
    this.exited = new Promise((resolve) => this.child.on('close', (code) => resolve(code ?? -1)));
  }

  /** Wait for a step the orchestrator prints, and answer with it. */
  async step(name: string, timeoutMs = 60_000): Promise<Step> {
    return eventually(
      `the orchestrator to log "${name}"\n${this.log}`,
      async () => this.steps.find((s) => s.step === name) ?? null,
      timeoutMs,
    );
  }

  async exitCode(timeoutMs = 60_000): Promise<number> {
    const done = await Promise.race([
      this.exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs)),
    ]);
    if (done === 'timeout') {
      this.child.kill('SIGKILL');
      throw new Error(`the orchestrator did not exit within ${timeoutMs} ms\n${this.log}`);
    }
    return done;
  }

  stop(): void {
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

/** A screenshot in the report — §M asked for the loop to be seen, not just passed. */
async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test.describe('§M · the hosted SDK', () => {
  // Building the sample (npm install of the tarball + tsc) happens once.
  test.beforeAll(async () => {
    const built = await new Promise<{ code: number; out: string }>((resolve) => {
      const p = spawn(
        process.execPath,
        [`${SAMPLE}/check.mjs`, '--if-needed', '--build', '--quiet'],
        { cwd: REPO },
      );
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code: code ?? -1, out }));
    });
    expect(built.code, `qaqc/orch-sample did not build:\n${built.out}`).toBe(0);
  });

  test('an orchestrator written on the SDK drives a ticket end to end', async ({ page }) => {
    const ada = await newPerson('Ada', 'Lovelace');
    const b = await newBoard(ada, { name: 'SDK orchestrator' });

    // ── the orchestrator's credentials: an agent, on the board, with a token ──
    const { agentId } = await call(ada, 'agentCreate', {
      name: 'Builder',
      description: 'Implements tickets and reports back',
      systemPrompt: '# You are Builder\n\nAsk before guessing.',
    });
    await call(ada, 'boardAgentSet', { boardId: b.id, agentId, role: 'editor' });
    const { key: token } = await call(ada, 'apiKeyCreate', {
      name: 'orch-sample',
      boardId: b.id,
      actsAs: { kind: 'agent', id: agentId },
      scopes: [...SCOPE_PRESETS.worker],
    });

    const t = await call(ada, 'ticketCreate', {
      boardId: b.id,
      title: 'Add CSV export',
      description: text('The board wants a CSV button on the ticket list.'),
      stageId: stage(b, 'To do'),
    });

    // Ada is watching the ticket before anything happens: every assertion below
    // is the app's live listeners, never a reload.
    await signIn(page, ada.email, `/t/${t.key}`);
    // The drawer's title is the editable field, not a heading.
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Add CSV export');

    // ── the event that wakes it: Ada assigns the agent (§D) ──────────────────
    await call(ada, 'ticketUpdate', {
      boardId: b.id,
      ticketId: t.ticketId,
      patch: { assigneeUids: [agentId] },
    });

    const orch = new Orchestrator({
      TM_TOKEN: token,
      TM_BASE_URL: API_URL,
      TM_MAX_EVENTS: '1',
      TM_ANSWER_POLL_MS: '1000',
      TM_ANSWER_TIMEOUT_MS: '120000',
      // Faster than the 60 s of production so a whole run has several beats.
      TM_HEARTBEAT_MS: '5000',
    });

    try {
      const hello = await orch.step('hello');
      expect(hello.kind).toBe('agent');
      expect(hello.board).toBe(b.key);
      expect(hello.hasSystemPrompt).toBe(true);

      const picked = await orch.step('picked-up');
      expect(picked).toMatchObject({ event: 'assigned', ticket: t.key });

      // ── 1 · the plan, and the dot, without touching the page (§L2 · §L3) ───
      const list = page.locator('[data-tasklist]').first();
      await expect(list).toBeVisible();
      await expect(list).toContainText('Plan: Add CSV export');
      await expect(list.locator('[data-progress]')).toHaveText('1 / 4');
      await expect(list.locator('[data-item-status="doing"]')).toContainText(
        'Ask how the report should look',
      );

      const health = page.locator('header [data-health]').first();
      await expect(health).toHaveAttribute('data-health', /working|idle/);
      await shot(page, 'plan-and-heartbeat');

      // ── 2 · the question it cannot go on without (§L1) ─────────────────────
      await orch.step('asked');
      const card = page.locator('[data-question]').first();
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('data-question-status', 'open');
      await expect(
        card.getByRole('heading', { name: `How should the report for ${t.key} look?` }),
      ).toBeVisible();
      await expect(card).toContainText('I can write the headlines');
      // A blocking question puts the badge on the header (§L1) …
      await expect(page.locator('[data-waiting]').first()).toBeVisible();
      // … and while it waits the agent says idle, not working (§L3).
      await expect(health).toHaveAttribute('data-health', 'idle');
      await shot(page, 'question-open');

      // ── 3 · Ada answers it, in the browser ─────────────────────────────────
      await card.getByRole('radio', { name: /Full detail/ }).check();
      await card
        .getByRole('group')
        .filter({ hasText: 'Move it to Review' })
        .getByRole('button', { name: 'Yes' })
        .click();
      await card.getByLabel('Anything else?').fill('include the thread, please');
      await card.getByRole('button', { name: 'Submit' }).click();
      await expect(card).toHaveAttribute('data-question-status', 'answered');
      await expect(card).toContainText(`Answered by ${ada.name}`);

      const answered = await orch.step('answered');
      expect(answered.values).toEqual({ format: 'full', ship: true });
      expect(answered.comment).toBe('include the thread, please');

      // ── 4 · the two documents, posted as one message (§I) ──────────────────
      await orch.step('finished');
      const thread = page.getByRole('region', { name: 'Thread' });
      const message = thread.getByRole('article', { name: 'Message from Builder' }).last();
      await expect(message).toBeVisible();
      await expect(message.getByRole('heading', { name: 'Report ready' })).toBeVisible();
      await expect(message).toContainText('via token orch-sample');
      await expect(message.locator('[data-kind="markdown"]')).toContainText(`Report · ${t.key}`);
      await expect(message.locator('[data-kind="html"]')).toBeVisible();
      await expect(message.getByTitle('Preview of report.html')).toBeVisible();

      // The Markdown document asked for the full thread, so it has the table.
      await message.getByRole('button', { name: 'Open report.md' }).click();
      const viewer = page.getByRole('dialog', { name: 'Viewing report.md' });
      await expect(viewer.getByRole('heading', { name: `Report · ${t.key}` })).toBeVisible();
      await expect(viewer).toContainText('include the thread, please');
      await page.keyboard.press('Escape');
      await expect(viewer).toBeHidden();

      // ── 5 · the plan finished, the ticket moved because the answer said so ──
      await expect(list.locator('[data-progress]')).toHaveText('4 / 4');
      await expect(page.getByRole('complementary', { name: 'Details' })).toContainText('Review');
      // The last beat: ⚪ Finished, nothing running on this ticket (§L3).
      await expect(health).toHaveAttribute('data-health', 'done');
      await expect(page.locator('[data-waiting]')).toHaveCount(0);
      await shot(page, 'report-posted');

      // ── 6 · and the process itself ─────────────────────────────────────────
      const summary = await orch.step('summary');
      expect(summary).toMatchObject({ handled: 1, failed: 0 });
      expect(await orch.exitCode()).toBe(0);
    } finally {
      orch.stop();
    }
  });
});
