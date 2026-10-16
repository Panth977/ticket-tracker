/**
 * THE TEMPLATE WIRE (docs/plan/templates.html §B) — what the app's page and a
 * template's worker say to each other. The worker (./worker/runtime.js) runs
 * the board's code; the page (./host.ts) draws trees and answers `api` calls.
 * Nothing but these plain, structured-clonable messages crosses.
 */
import type { TemplateKind } from '@tm/shared';

/** A drawn node: a string is text; an object is one of the builder's node types. */
export type VNode = string | VElement;
/** A child slot: null is a hole (`cond && h.x()` that was false) and keeps its place. */
export type VSlot = VNode | null;
export interface VElement {
  /** Node type — see NODE_TYPES. */
  t: string;
  /** `key` from the template: keeps an element (and its focus) across re-renders. */
  k?: string | number;
  p: Record<string, unknown>;
  c?: VSlot[];
}
/** A handler reference: functions stay in the worker; the tree names them. */
export interface HandlerRef {
  $h: string;
}
export const isHandlerRef = (v: unknown): v is HandlerRef =>
  !!v && typeof v === 'object' && typeof (v as HandlerRef).$h === 'string';

/** The builder's node types — the renderer draws exactly these. */
export const NODE_TYPES = [
  'box',
  'text',
  'heading',
  'markdown',
  'badge',
  'divider',
  'link',
  'image',
  'person',
  'ticket',
  'progress',
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'button',
  'el',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Page → worker. */
export type ToWorker =
  | { type: 'load'; code: string; kind: TemplateKind; ctx: unknown }
  | { type: 'event'; seq: number; h: string; args: unknown[] }
  | { type: 'submit'; id: number }
  | { type: 'cards'; id: number; items: { id: string; ctx: unknown }[] }
  | { type: 'apiResult'; id: number; ok: boolean; value?: unknown; error?: string }
  | { type: 'ping'; n: number };

/** Worker → page. */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'loaded' }
  | { type: 'render'; tree: VSlot[] | null; ack: number }
  | { type: 'error'; phase: string; message: string; line?: number }
  | { type: 'submitted'; id: number; result?: unknown; error?: string; line?: number }
  | {
      type: 'cards';
      id: number;
      results: { id: string; tree?: VSlot[]; error?: string; line?: number }[];
    }
  | { type: 'api'; id: number; method: string; args: unknown[] }
  | { type: 'log'; level: 'log' | 'warn' | 'error'; text: string }
  | { type: 'pong'; n: number };
