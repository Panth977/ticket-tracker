import { createHash } from 'node:crypto';

/** A Cloud Tasks-safe id for a logical task name (stable: same name → same id). */
export function taskId(name: string): string {
  if (/^[A-Za-z0-9_-]{1,400}$/.test(name)) return name;
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return `${safe}-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
}
