/**
 * Notification e-mail: one HTML layout with a kicker and accent per event
 * (the reference's look), plus the plain-text twin every mail carries.
 * Everything user-supplied is escaped here — titles, names and comment text
 * are untrusted.
 */
import type { NotifyEvent } from '@tm/shared';
import { EVENT_STYLE } from '../notify/summary.js';

export const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface NotifyMailInput {
  event: NotifyEvent;
  /** 'Priya Shah' or null (deadline reminders have no actor). */
  actorName: string | null;
  summary: string;
  count: number;
  ticketKey: string | null;
  ticketTitle: string | null;
  boardName: string;
  /** Deep link: the ticket (or the inbox for invitations). */
  url: string;
  /** Account › Notifications. */
  settingsUrl: string;
  /** Replying to this mail posts to the thread. */
  replyable: boolean;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The subject is THE SAME for every mail about one ticket, so clients that
 * thread by subject agree with the ones that follow In-Reply-To.
 */
export function notifySubject(
  i: Pick<NotifyMailInput, 'event' | 'ticketKey' | 'ticketTitle' | 'actorName' | 'boardName'>,
): string {
  if (i.ticketKey) return `[${i.ticketKey}] ${i.ticketTitle ?? ''}`.trim();
  if (i.event === 'invited') return `${i.actorName ?? 'Someone'} invited you to ${i.boardName}`;
  return i.boardName;
}

export function headline(i: Pick<NotifyMailInput, 'actorName' | 'summary' | 'count'>): string {
  const who = i.actorName ? `${i.actorName} ` : '';
  const more = i.count > 1 ? ` (${i.count} updates)` : '';
  return `${who}${i.summary}${more}`;
}

export function renderNotifyMail(i: NotifyMailInput): RenderedMail {
  const style = EVENT_STYLE[i.event];
  const line = headline(i);
  const subject = notifySubject(i);
  const cta = i.ticketKey
    ? `Open ${i.ticketKey}`
    : i.event === 'invited'
      ? 'See the invitation'
      : 'Open';
  const replyNote = i.replyable ? 'Reply to this email to comment on the ticket.' : '';

  const text = [
    `${style.kicker.toUpperCase()} · ${i.boardName}`,
    '',
    i.ticketKey ? `${i.ticketKey} ${i.ticketTitle ?? ''}`.trim() : null,
    line,
    '',
    `${cta}: ${i.url}`,
    '',
    replyNote || null,
    `Notification settings: ${i.settingsUrl}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;border-top:4px solid ${style.accent};padding:24px">
<tr><td style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${style.accent};font-weight:600">${esc(style.kicker)} · ${esc(i.boardName)}</td></tr>
${
  i.ticketKey
    ? `<tr><td style="padding-top:8px;font-size:18px;font-weight:600"><span style="color:#6b7280">${esc(i.ticketKey)}</span> ${esc(i.ticketTitle ?? '')}</td></tr>`
    : ''
}
<tr><td style="padding-top:12px;font-size:15px;line-height:1.5">${esc(line)}</td></tr>
<tr><td style="padding-top:20px"><a href="${esc(i.url)}" style="display:inline-block;background:${style.accent};color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600;font-size:14px">${esc(cta)}</a></td></tr>
${replyNote ? `<tr><td style="padding-top:16px;font-size:13px;color:#6b7280">${esc(replyNote)}</td></tr>` : ''}
</table>
<p style="font-size:12px;color:#9ca3af;margin-top:16px">You get this because of your notification settings. <a href="${esc(i.settingsUrl)}" style="color:#6b7280">Change them</a>.</p>
</td></tr></table>
</body></html>`;
  return { subject, html, text };
}
