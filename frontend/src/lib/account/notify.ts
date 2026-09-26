/**
 * Account › Notifications — pure helpers for the event × channel grid and
 * the rest of the form. EVERYTHING HERE IS THE PERSON'S OWN CHOICE: no board
 * or admin can change it (profileUpdate merges `notify.channels` per event).
 */
import {
  CHANNELS,
  NOTIFY_EVENTS,
  type Channel,
  type ChannelMatrix,
  type NotifyEvent,
  type User,
} from '@tm/shared';

export const EVENT_LABELS: Record<NotifyEvent, { label: string; hint: string }> = {
  assigned: { label: 'Assigned to me', hint: 'Someone makes you an assignee' },
  mentioned: { label: 'Mentioned', hint: '@you in a comment or description' },
  comment: { label: 'New comments', hint: 'On tickets you follow' },
  stage: { label: 'Stage changes', hint: 'A ticket moves, e.g. to QA' },
  updated: { label: 'Other edits', hint: 'Title, priority, fields…' },
  created: { label: 'New tickets', hint: 'Created on boards you follow' },
  dueSoon: { label: 'Due soon', hint: 'Before a due date, by your lead time' },
  overdue: { label: 'Overdue', hint: 'A due date has passed' },
  state: { label: 'Done / reopened', hint: 'Completed, cancelled, reopened' },
  invited: { label: 'Invitations', hint: 'Someone invites you to a board' },
  // Phase 3 (§L1): an agent asked a blocking question and is waiting on you.
  question: {
    label: 'Questions from agents',
    hint: 'An agent needs an answer before it can go on',
  },
  // Phase 3 (§L3): only the agent's owner ever gets this one.
  agentSilence: {
    label: 'An agent went quiet',
    hint: 'Your agent said it was working and stopped reporting',
  },
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  inApp: 'In app',
  push: 'Push',
  email: 'Email',
  whatsapp: 'WhatsApp',
};

export { CHANNELS, NOTIFY_EVENTS };

/** Which channels are set up; one that is not is greyed out in the grid. */
export interface ChannelSetup {
  inApp: boolean;
  push: boolean;
  email: boolean;
  whatsapp: boolean;
}

export function channelSetup(
  profile: Pick<User, 'email' | 'whatsapp'> | null,
  deviceCount: number,
): ChannelSetup {
  return {
    inApp: true,
    push: deviceCount > 0,
    email: !!profile?.email,
    whatsapp: !!profile?.whatsapp?.verifiedAt && profile.whatsapp.optIn,
  };
}

export const SETUP_HINT: Record<Channel, string> = {
  inApp: '',
  push: 'Enable push on a device in Channels first',
  email: 'No sign-in email on this account',
  whatsapp: 'Link WhatsApp in Channels first',
};

/** Turn one cell on/off; returns the new channel list for that event (stable order). */
export function toggleCell(
  matrix: ChannelMatrix,
  event: NotifyEvent,
  channel: Channel,
  on: boolean,
): Channel[] {
  const cur = new Set(matrix[event] ?? []);
  if (on) cur.add(channel);
  else cur.delete(channel);
  return CHANNELS.filter((c) => cur.has(c));
}

/** A whole column on/off — the column header's checkbox. */
export function toggleColumn(
  matrix: ChannelMatrix,
  channel: Channel,
  on: boolean,
): Partial<ChannelMatrix> {
  const out: Partial<ChannelMatrix> = {};
  for (const e of NOTIFY_EVENTS) out[e] = toggleCell(matrix, e, channel, on);
  return out;
}

/** 'all' | 'none' | 'some' for a column header's (indeterminate) checkbox. */
export function columnState(matrix: ChannelMatrix, channel: Channel): 'all' | 'none' | 'some' {
  const n = NOTIFY_EVENTS.filter((e) => matrix[e]?.includes(channel)).length;
  return n === 0 ? 'none' : n === NOTIFY_EVENTS.length ? 'all' : 'some';
}

/** 'Remind me before a due date' choices, 15 min … 3 days (deadlineSweep window is 72h). */
export const LEAD_TIMES: { value: number; label: string }[] = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
  { value: 720, label: '12 hours' },
  { value: 1440, label: '1 day' },
  { value: 2880, label: '2 days' },
  { value: 4320, label: '3 days' },
];

/** Label for any lead time, including one not in the list. */
export function leadLabel(minutes: number): string {
  const hit = LEAD_TIMES.find((l) => l.value === minutes);
  if (hit) return hit.label;
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export const DIGEST_OPTIONS = [
  { value: 'off', label: 'Off — send each email as it happens' },
  { value: 'hourly', label: 'Hourly digest' },
  { value: 'daily', label: 'Daily digest' },
] as const;

export const MODE_OPTIONS = [
  { value: 'all', label: 'Everything', hint: 'Everything on the board' },
  { value: 'mine', label: 'Mine', hint: 'Tickets you are assigned to, created, or watch' },
  { value: 'muted', label: 'Muted', hint: 'Only tickets you watch, and mentions' },
] as const;

/** Quiet hours overnight (22:00 → 07:00) wrap past midnight — say so. */
export function quietHoursSummary(q: { start: string; end: string } | null): string {
  if (!q) return 'Off';
  if (q.start === q.end) return 'All day';
  const overnight = q.end < q.start;
  return `${q.start} – ${q.end}${overnight ? ' (overnight)' : ''}`;
}

export const DELIVERY_STATUS_TONE: Record<
  string,
  'neutral' | 'success' | 'warning' | 'danger' | 'accent'
> = {
  queued: 'neutral',
  sent: 'accent',
  delivered: 'success',
  read: 'success',
  failed: 'danger',
  suppressed: 'warning',
};

/** Plain words for 'why something wasn't sent'. */
export function deliveryExplanation(d: { status: string; error: string | null }): string {
  if (d.status === 'suppressed') {
    const e = d.error ?? '';
    if (/quiet/i.test(e)) return 'Held back by your quiet hours';
    if (/digest/i.test(e)) return 'Folded into your digest';
    if (/bounce|complain/i.test(e)) return 'Your address bounced before — not sent';
    if (/window|template/i.test(e)) return 'Outside WhatsApp’s 24-hour window';
    return e || 'Not sent by your settings';
  }
  if (d.status === 'failed') return d.error || 'The provider refused it';
  return '';
}
