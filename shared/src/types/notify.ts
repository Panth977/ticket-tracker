/**
 * Provenance and notification vocabulary (app/db.json + platform/db.json `types`).
 */
import { z } from 'zod';

/**
 * WHERE A CHANGE CAME FROM, stamped on every message and activity row:
 * 'Claude moved this via MCP' and 'replied by email' are facts, not guesses.
 */
export const VIAS = [
  'app',
  'api',
  'mcp',
  'email',
  'whatsapp',
  'intake',
  'integration',
  'system',
] as const;
export const ViaSchema = z.enum(VIAS);
export type Via = z.infer<typeof ViaSchema>;

export const NOTIFY_EVENTS = [
  'assigned',
  'mentioned',
  'comment',
  'stage',
  'updated',
  'created',
  'dueSoon',
  'overdue',
  'state',
  'invited',
  /**
   * Phase 3 (§L1): an agent asked a blocking question — the people it names
   * (or the assignees and watchers) hear about it through their normal
   * channels. Added after phase 1, so stored notify matrices may not have it
   * (see ChannelMatrixSchema).
   */
  'question',
  /**
   * Phase 3 (§L3): an agent that said it was working stopped beating.
   * agentSilenceSweep tells its OWNER, once per silence — nobody else is
   * watching for a dead orchestrator. Added after phase 1 (see LATER_EVENTS).
   */
  'agentSilence',
] as const;
export const NotifyEventSchema = z.enum(NOTIFY_EVENTS);
export type NotifyEvent = z.infer<typeof NotifyEventSchema>;

export const CHANNELS = ['inApp', 'push', 'email', 'whatsapp'] as const;
export const ChannelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof ChannelSchema>;

/**
 * Set by the person themselves, per board:
 *   all    — everything on the board
 *   mine   — tickets I'm assigned to, created, or watch
 *   muted  — only tickets I explicitly watch, and mentions
 */
export const NOTIFY_MODES = ['all', 'mine', 'muted'] as const;
export const BoardNotifyPrefSchema = z.object({
  mode: z.enum(NOTIFY_MODES),
  /** Absent = every event. */
  events: z.array(NotifyEventSchema).optional(),
  /** 'stage' events: only into these stages. */
  stageIds: z.array(z.string()).optional(),
});
export type BoardNotifyPref = z.infer<typeof BoardNotifyPrefSchema>;

/** Events added after phase 1: stored matrices predate them, so they default. */
const LATER_EVENTS: readonly NotifyEvent[] = ['question', 'agentSilence'];
/** The channels a loud event uses out of the box. */
const LOUD_CHANNELS: readonly Channel[] = ['inApp', 'push', 'email'];

/**
 * WHICH CHANNELS AN EVENT USES — chosen by each person, and by nobody else.
 * An event this vocabulary gained later (LATER_EVENTS) is optional on the way
 * IN and filled with its default, so a matrix written before phase 3 still
 * parses; every event is present on the way out.
 */
export const ChannelMatrixSchema = z.object(
  Object.fromEntries(
    NOTIFY_EVENTS.map((e) => [
      e,
      LATER_EVENTS.includes(e)
        ? z.array(ChannelSchema).default(() => [...LOUD_CHANNELS])
        : z.array(ChannelSchema),
    ]),
  ) as unknown as Record<NotifyEvent, z.ZodArray<typeof ChannelSchema>>,
);
export type ChannelMatrix = Record<NotifyEvent, Channel[]>;

/**
 * Defaults for a new account:
 *   mentioned, assigned, invited  → inApp, push, email
 *   question (phase 3)            → inApp, push, email
 *   dueSoon, overdue              → inApp, push, email
 *   everything else               → inApp
 * WhatsApp is off for every event until the person ticks it.
 */
export function defaultChannelMatrix(): ChannelMatrix {
  const m = {} as ChannelMatrix;
  for (const e of NOTIFY_EVENTS) {
    // 'question' is loud: somebody is waiting on the answer before work
    // continues. 'agentSilence' is loud too: the work has stopped and only the
    // agent's owner is told.
    m[e] = [
      'mentioned',
      'assigned',
      'invited',
      'dueSoon',
      'overdue',
      'question',
      'agentSilence',
    ].includes(e)
      ? [...LOUD_CHANNELS]
      : ['inApp'];
  }
  return m;
}

/** Out-of-app delivery channels (platform/db.json). */
export const DELIVERY_CHANNELS = ['push', 'email', 'whatsapp', 'slack'] as const;
export const DeliveryChannelSchema = z.enum(DELIVERY_CHANNELS);
export type DeliveryChannel = z.infer<typeof DeliveryChannelSchema>;
