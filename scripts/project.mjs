/**
 * Which Firebase project is "production"? Never a value in the source: the
 * `prod` alias in .firebaserc (`firebase use --add`), or --project / the
 * TM_DEPLOY_PROJECT environment variable on the command line.
 *
 * PLACEHOLDER_PROJECT names the project the COMMITTED artefacts are generated
 * for (frontend/static/integrate*, llms*.txt, the SDK's default base URL). A
 * deploy regenerates them for the real project, so what is in git never has
 * to change when the project does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const PLACEHOLDER_PROJECT = 'taskmanager-example';

/** The `prod` alias in .firebaserc, or null when there is none yet. */
export function prodProject() {
  const rc = join(ROOT, '.firebaserc');
  if (!existsSync(rc)) return null;
  try {
    const p = JSON.parse(readFileSync(rc, 'utf8')).projects?.prod;
    return typeof p === 'string' && p && !p.startsWith('demo-') ? p : null;
  } catch {
    return null;
  }
}

/** What the deploy scripts use when nothing names a project. */
export const DEFAULT_PROJECT = prodProject() ?? PLACEHOLDER_PROJECT;

export const isPlaceholder = (project) => project === PLACEHOLDER_PROJECT;
