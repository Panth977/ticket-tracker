import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ linkify: true, breaks: true });

/** Markdown → safe HTML (the host frame is sandboxed too; this is belt and braces). */
export const renderMd = (s: string | null | undefined): string =>
  DOMPurify.sanitize(md.render(s ?? ''), { FORBID_TAGS: ['img', 'iframe', 'style'] });

export function dueLabel(
  iso: string | null,
  now = Date.now(),
): { text: string; late: boolean } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  const days = Math.round((t - now) / 86_400_000);
  const text =
    days === 0
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : days === -1
          ? 'yesterday'
          : days < 0
            ? `${-days}d late`
            : `in ${days}d`;
  return { text, late: t < now };
}

export const initials = (s: string) =>
  s
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';
