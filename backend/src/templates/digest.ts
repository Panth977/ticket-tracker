/**
 * The digest e-mail (digestSend): unread inbox rows grouped by board, plus
 * 'due today' and 'overdue' from My Work. Escaped like every template.
 */
import { esc, type RenderedMail } from './email.js';

export interface DigestInput {
  name: string;
  period: 'hourly' | 'daily';
  boards: { name: string; items: { line: string; url: string }[] }[];
  dueToday: { key: string; title: string; url: string }[];
  overdue: { key: string; title: string; url: string }[];
  inboxUrl: string;
  settingsUrl: string;
}

export function renderDigestMail(d: DigestInput): RenderedMail {
  const unread = d.boards.reduce((n, b) => n + b.items.length, 0);
  const parts: string[] = [];
  if (unread) parts.push(`${unread} unread`);
  if (d.dueToday.length) parts.push(`${d.dueToday.length} due today`);
  if (d.overdue.length) parts.push(`${d.overdue.length} overdue`);
  const subject = `Your ${d.period === 'daily' ? 'daily' : 'hourly'} digest: ${parts.join(', ')}`;

  const text: string[] = [`Hi ${d.name},`, ''];
  const html: string[] = [];
  const section = (title: string, rows: { line: string; url: string }[]) => {
    if (!rows.length) return;
    text.push(title.toUpperCase(), ...rows.map((r) => `- ${r.line}  ${r.url}`), '');
    html.push(
      `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin:20px 0 6px">${esc(title)}</h3>`,
      '<ul style="padding-left:18px;margin:0">',
      ...rows.map(
        (r) =>
          `<li style="margin:4px 0"><a href="${esc(r.url)}" style="color:#1f2937">${esc(r.line)}</a></li>`,
      ),
      '</ul>',
    );
  };
  section(
    'Overdue',
    d.overdue.map((t) => ({ line: `${t.key} ${t.title}`, url: t.url })),
  );
  section(
    'Due today',
    d.dueToday.map((t) => ({ line: `${t.key} ${t.title}`, url: t.url })),
  );
  for (const b of d.boards) section(b.name, b.items);
  text.push(`Inbox: ${d.inboxUrl}`, `Digest settings: ${d.settingsUrl}`);

  return {
    subject,
    text: text.join('\n'),
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:10px;padding:24px">
<p style="margin:0 0 8px">Hi ${esc(d.name)},</p>
${html.join('\n')}
<p style="margin-top:24px"><a href="${esc(d.inboxUrl)}" style="color:#2563eb">Open your inbox</a></p>
</div>
<p style="text-align:center;font-size:12px;color:#9ca3af"><a href="${esc(d.settingsUrl)}" style="color:#6b7280">Digest settings</a></p>
</body></html>`,
  };
}
