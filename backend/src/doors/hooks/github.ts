/**
 * POST /hooks/github (platform/backend.json services.githubHook), trusted by
 * X-Hub-Signature-256 = 'sha256=' + hex(HMAC(GITHUB_WEBHOOK_SECRET, body)).
 * Under the emulators a fixed dev secret is used when the env var is unset;
 * in production an unset secret refuses everything. A mismatch → 401 and the
 * body is never logged.
 *
 *   pull_request, push, issue_comment
 *   keys found in the branch name, PR title, commit messages, comment body:
 *     /\b[A-Z][A-Z0-9]{1,5}-\d+\b/   (branch names upper-cased first: 'eng-42-fix')
 *   for each key whose board LINKED THIS REPO (integrations/github config.repos):
 *     a system line in the thread — 'PR #812 opened by octocat: …' with the link
 *     merged && repo.moveOnMerge → ticketUpdate(stage) via 'integration', acting
 *     as the person who connected GitHub
 *
 * Also mounts the /integrations/{provider}/connect|callback routes
 * (platform/integrations.ts) — this is the platform's integrations door.
 */
import { errors, paths, type Integration, type PMNode, type Ticket } from '@tm/shared';
import { ports } from '../../adapters/index.js';
import { door } from '../../http/mounts.js';
import { hmacHex, safeEqual, sha256hex } from '../../platform/crypto.js';
import { registerIntegrationRoutes } from '../../platform/integrations.js';
import { invoke } from '../../platform/ops.js';
import { makeCtx } from '../../runtime/context.js';
import { db, isEmulated } from '../../runtime/firebase.js';
import { openTicket } from '../../tickets/doc.js';
import { richFromInline, systemMessage } from '../../tickets/writes.js';
import type { KeyIndex } from '@tm/shared';

export const DEV_GITHUB_SECRET = 'tm-dev-github-webhook-secret';
const MAX_BODY = 5 * 1024 * 1024;
const KEY_RE = /\b[A-Z][A-Z0-9]{1,5}-\d+\b/g;

export function githubSecret(): string | null {
  return process.env.GITHUB_WEBHOOK_SECRET || (isEmulated() ? DEV_GITHUB_SECRET : null);
}

export function findKeys(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').toUpperCase().matchAll(KEY_RE)) out.add(m[0]);
  return [...out];
}

interface Mention {
  keys: string[];
  repo: string;
  /** The thread line: text before the link, link text, href, text after. */
  line: { before: string; link: string; href: string; after: string };
  merged: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub payloads are large; we read a handful of fields. */
function interpret(event: string, p: any): Mention | null {
  const repo: string | undefined = p?.repository?.full_name;
  if (!repo) return null;
  if (event === 'pull_request') {
    const pr = p.pull_request;
    const action: string = p.action;
    if (!pr || !['opened', 'reopened', 'closed', 'ready_for_review'].includes(action)) return null;
    const merged = action === 'closed' && pr.merged === true;
    const verb = merged
      ? 'merged'
      : action === 'closed'
        ? 'closed'
        : action === 'ready_for_review'
          ? 'marked ready'
          : action;
    const who = (merged ? pr.merged_by?.login : p.sender?.login) ?? pr.user?.login ?? 'someone';
    return {
      keys: findKeys(pr.head?.ref, pr.title, pr.body),
      repo,
      line: {
        before: '',
        link: `PR #${pr.number}`,
        href: pr.html_url,
        after: ` ${verb} by ${who}: ${pr.title}`,
      },
      merged,
    };
  }
  if (event === 'push') {
    const commits: any[] = Array.isArray(p.commits) ? p.commits : [];
    if (p.deleted || !commits.length) return null;
    const branch = String(p.ref ?? '').replace(/^refs\/heads\//, '');
    const first = String(commits[commits.length - 1]?.message ?? '').split('\n')[0];
    return {
      keys: findKeys(branch, ...commits.map((c) => c.message)),
      repo,
      line: {
        before: `${commits.length} commit${commits.length === 1 ? '' : 's'} pushed to `,
        link: branch,
        href: p.compare ?? `https://github.com/${repo}/tree/${branch}`,
        after: ` by ${p.pusher?.name ?? p.sender?.login ?? 'someone'}: ${first}`,
      },
      merged: false,
    };
  }
  if (event === 'issue_comment') {
    if (p.action !== 'created' || !p.comment) return null;
    const isPr = !!p.issue?.pull_request;
    return {
      keys: findKeys(p.issue?.title, p.comment.body),
      repo,
      line: {
        before: `${p.comment.user?.login ?? 'someone'} commented on `,
        link: `${isPr ? 'PR' : 'issue'} #${p.issue?.number}`,
        href: p.comment.html_url,
        after: '',
      },
      merged: false,
    };
  }
  return null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function linkedRepo(boardId: string, repo: string) {
  const s = await db().doc(paths.integration(boardId, 'github')).get();
  const it = s.exists ? (s.data() as Integration) : undefined;
  if (!it || it.status !== 'active') return null;
  const r = it.config.repos?.find((x) => x.fullName.toLowerCase() === repo.toLowerCase());
  return r ? { integration: it, repo: r } : null;
}

export async function handleGithubEvent(
  event: string,
  delivery: string,
  payload: unknown,
): Promise<{ touched: string[] }> {
  const m = interpret(event, payload);
  if (!m || !m.keys.length) return { touched: [] };
  const now = ports().clock.now();
  const touched: string[] = [];
  for (const key of m.keys.slice(0, 20)) {
    const ks = await db().doc(paths.key(key)).get();
    const k = ks.exists ? (ks.data() as KeyIndex) : undefined;
    if (!k || k.deleted) continue;
    const link = await linkedRepo(k.boardId, m.repo);
    if (!link) continue; // only boards that linked this repo hear about it

    const content: PMNode[] = [
      ...(m.line.before ? [{ type: 'text', text: m.line.before }] : []),
      { type: 'text', text: m.line.link, marks: [{ type: 'link', attrs: { href: m.line.href } }] },
      ...(m.line.after ? [{ type: 'text', text: m.line.after.slice(0, 300) }] : []),
    ];
    // One line per (delivery, ticket): GitHub redelivers, we do not repeat.
    const msgId = `gh_${sha256hex(`${delivery}:${k.ticketId}`).slice(0, 24)}`;
    // §W: the line and the ticket's counters are one write. The dedupe reads
    // the ticket's inline thread — a redelivery arrives within minutes, long
    // before anything that recent could spill into a data page.
    const wrote = await db().runTransaction(async (tx) => {
      const w = await openTicket(tx, { now, ids: ports().ids }, k.boardId, k.ticketId).catch(
        () => null,
      );
      if (!w || w.find(msgId)) return false;
      w.addMessage(
        msgId,
        systemMessage({ via: 'integration', now }, 'GitHub', richFromInline(content)),
      );
      w.touch(now);
      w.commit();
      return true;
    });
    if (!wrote) continue;
    touched.push(key);

    if (m.merged && link.repo.moveOnMerge) {
      const t = (await db().doc(paths.ticket(k.boardId, k.ticketId)).get()).data() as
        Ticket | undefined;
      if (t && t.state === 'active' && t.stageId !== link.repo.moveOnMerge) {
        const ctx = makeCtx({
          actor: link.integration.connectedBy,
          via: 'integration',
          // moveOnMerge only changes the stage; the phase-2 scope for that is tickets:move.
          scopes: ['tickets:read', 'tickets:move'],
          boardIds: [k.boardId],
          clientName: 'GitHub',
        });
        try {
          await invoke(
            'ticketUpdate',
            { boardId: k.boardId, ticketId: k.ticketId, patch: { stageId: link.repo.moveOnMerge } },
            ctx,
            null,
          );
        } catch (e) {
          console.warn(`[github] moveOnMerge ${key} refused:`, (e as Error).message);
        }
      }
    }
  }
  return { touched };
}

const hooks = door('hooks');

hooks.post('/github', async (c) => {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > MAX_BODY) throw errors.too_large('Payload too large');
  const secret = githubSecret();
  if (!secret) throw errors.unauthenticated('GitHub webhooks are not configured');
  const sig = c.req.header('x-hub-signature-256') ?? '';
  if (!safeEqual(sig, `sha256=${hmacHex(secret, raw)}`))
    throw errors.unauthenticated('Bad webhook signature');
  const event = c.req.header('x-github-event') ?? '';
  if (event === 'ping') return c.json({ ok: true, pong: true });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw errors.invalid('Body is not valid JSON');
  }
  const delivery = c.req.header('x-github-delivery') ?? sha256hex(raw);
  const res = await handleGithubEvent(event, delivery, payload);
  return c.json({ ok: true, ...res });
});

registerIntegrationRoutes(door('integrations'));
