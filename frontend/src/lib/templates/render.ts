/**
 * THE RENDER ENGINE (docs/plan/templates.html §B3) — draws a template's tree
 * in the app's page, on the main thread, and keeps the DOM in step with each
 * new tree by PATCHING it, never by rebuilding it:
 *
 *   - an element keeps its DOM node while its type and position (or `key`)
 *     stay the same, so a focused input stays focused, with its caret, while
 *     the template re-renders around it;
 *   - holes (`cond && h.x(…)` that is false) keep their slot, so a field that
 *     appears never shifts the ones after it into new nodes;
 *   - a controlled input (`value` given) is only written when the worker has
 *     SEEN every keystroke sent from it (`ack`): what you type is never undone
 *     by a render that was computed before your last key arrived.
 *
 * Only the builder's node types exist here — no HTML from the template ever
 * reaches the page; Markdown goes through the app's sanitising renderer.
 */
import { renderMarkdown } from '$lib/editor/markdown';
import { isHandlerRef, type HandlerRef, type VElement, type VSlot } from './protocol';

export interface RenderCtx {
  /** Send an event to the worker; answers its sequence number. Absent = a static tree (cards). */
  dispatch?: (h: string, args: unknown[]) => number;
  /** Draw a person (picture + name) into `el`; answers a cleanup. */
  person?: (el: HTMLElement, id: string, opts: { size: number; showName: boolean }) => () => void;
  /** The app path of a ticket, for h.ticket and #KEY links in Markdown. */
  ticketHref?: (key: string) => string;
  /** Open a ticket in the app (h.ticket clicks). */
  openTicket?: (key: string) => void;
}

type Slot = VSlot;

interface Inst {
  type: string;
  id: string;
  el: Node;
  /** The last vnode drawn into this instance. */
  v: Slot;
  children: Inst[];
  /** Controls: the seq of the newest event this control sent. */
  sent: number;
  cleanup?: () => void;
  /** Composite controls: the parts update() writes to. */
  parts?: Record<string, HTMLElement>;
}

const TONES: Record<string, string> = {
  default: 'text-text',
  muted: 'text-muted',
  subtle: 'text-subtle',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};
const SIZES: Record<string, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
};
const WEIGHTS: Record<string, string> = {
  normal: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold',
};
const BGS: Record<string, string> = {
  surface: 'bg-surface',
  muted: 'bg-surface-2',
  accent: 'bg-accent-soft',
  success: 'bg-success-soft',
  warning: 'bg-warning-soft',
  danger: 'bg-danger-soft',
};
const BADGE_TONES: Record<string, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};
const BUTTONS: Record<string, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-text border-line hover:bg-surface-2',
  ghost: 'bg-transparent text-text border-transparent hover:bg-surface-2',
  danger: 'bg-danger text-white border-transparent hover:opacity-90',
};
const ALIGN: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  baseline: 'baseline',
};
const JUSTIFY: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
};
const CONTROL =
  'w-full rounded-md border border-line bg-surface px-2.5 text-sm text-text placeholder:text-subtle focus:border-accent focus:outline-none aria-invalid:border-danger disabled:opacity-60';
const HEX = /^#[0-9a-fA-F]{3,8}$/;

const str = (v: unknown, fallback = ''): string =>
  v === null || v === undefined ? fallback : String(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Builder units: 1 = 0.25rem, like the app's spacing scale. */
const space = (v: unknown, fallback: number): string => `${(num(v) ?? fallback) * 0.25}rem`;

/** A CSS value a template may set: no url(), expression() or script. */
export function safeStyle(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, raw] of Object.entries(input as Record<string, unknown>)) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    if (!/^-{0,2}[a-z][a-z0-9-]*$/.test(prop) || /behavior|binding/.test(prop)) continue;
    const val = String(raw);
    if (/url\s*\(|expression\s*\(|javascript:|@import|[<>]/i.test(val)) continue;
    out[prop] = val;
  }
  return out;
}

/** http(s), mailto and app paths only. */
export function safeHref(v: unknown): string | null {
  const s = str(v).trim();
  if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s)) return s;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return null;
}
/** https and inline raster images only. */
export function safeImage(v: unknown): string | null {
  const s = str(v).trim();
  if (/^https:\/\//i.test(s)) return s;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(s)) return s;
  return null;
}

/** el(tag) attributes that pass through, beside style / title / class-free styling. */
const EL_ATTRS = new Set(['colspan', 'rowspan', 'open', 'start', 'reversed', 'align']);


/**
 * Mount a renderer into `root`. `update(tree, ack)` patches it to a new tree;
 * `setErrors` shows a refused submit's field errors; `destroy` cleans up.
 */
export function createRenderer(root: HTMLElement, ctx: RenderCtx = {}) {
  let insts: Inst[] = [];
  let ack = 0;
  let errors: Record<string, string> = {};
  let lastTree: Slot[] = [];
  const isStatic = !ctx.dispatch;

  const send = (inst: Inst, ref: unknown, args: unknown[]) => {
    if (!isHandlerRef(ref) || !ctx.dispatch) return;
    inst.sent = ctx.dispatch((ref as HandlerRef).$h, args);
  };

  // ── element helpers ──
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '') => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  };
  const applyStyle = (
    el: HTMLElement,
    inst: Inst,
    p: Record<string, unknown>,
    base: Record<string, string> = {},
  ) => {
    const next = { ...base, ...safeStyle(p.style) };
    const prev = (inst as Inst & { style?: Record<string, string> }).style ?? {};
    for (const k of Object.keys(prev)) if (!(k in next)) el.style.removeProperty(k);
    for (const [k, v] of Object.entries(next)) if (prev[k] !== v) el.style.setProperty(k, v);
    (inst as Inst & { style?: Record<string, string> }).style = next;
    const title = str(p.title);
    if (title) el.title = title;
    else el.removeAttribute('title');
  };
  const textCls = (p: Record<string, unknown>) =>
    [
      TONES[str(p.tone, 'default')] ?? '',
      SIZES[str(p.size)] ?? '',
      WEIGHTS[str(p.weight)] ?? '',
      p.mono ? 'font-mono' : '',
      p.italic ? 'italic' : '',
      p.strike ? 'line-through' : '',
      p.truncate ? 'block truncate' : '',
      p.wrap === false ? 'whitespace-nowrap' : '',
    ]
      .filter(Boolean)
      .join(' ');

  /** Label + control + message, the app's Field. */
  const field = (inst: Inst, control: HTMLElement, p: Record<string, unknown>) => {
    const wrap = make('div', 'flex flex-col gap-1');
    const label = make('label', 'text-xs font-medium text-muted');
    const msg = make('p', 'text-xs');
    const id = `tpl-${Math.random().toString(36).slice(2, 10)}`;
    control.id = id;
    label.htmlFor = id;
    wrap.append(label, control, msg);
    inst.parts = { ...(inst.parts ?? {}), label, msg, control };
    updateField(inst, p);
    return wrap;
  };
  const updateField = (inst: Inst, p: Record<string, unknown>) => {
    const { label, msg, control } = inst.parts!;
    const l = str(p.label);
    label!.textContent = l;
    label!.hidden = !l;
    if (p.required && l) {
      const star = make('span', 'text-danger');
      star.textContent = ' *';
      label!.append(star);
    }
    const name = str(p.name);
    const err = str(p.error) || (name ? (errors[name] ?? '') : '');
    msg!.textContent = err || str(p.hint);
    msg!.className = `text-xs ${err ? 'text-danger' : 'text-subtle'}`;
    msg!.hidden = !(err || p.hint);
    if (err) control!.setAttribute('aria-invalid', 'true');
    else control!.removeAttribute('aria-invalid');
  };
  /** Write a controlled value — only once the worker has seen this control's last event. */
  const writeValue = (
    inst: Inst,
    el: HTMLInputElement | HTMLTextAreaElement,
    p: Record<string, unknown>,
  ) => {
    if (!('value' in p) || inst.sent > ack) return;
    const v = str(p.value);
    if (el.value === v) return;
    const focused = document.activeElement === el;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    el.value = v;
    if (focused && start !== null && end !== null && el.type !== 'number' && el.type !== 'date') {
      try {
        el.setSelectionRange(Math.min(start, v.length), Math.min(end, v.length));
      } catch {
        /* types without a selection */
      }
    }
  };

  type Opt = { value: string; label: string; disabled?: boolean };
  const options = (v: unknown): Opt[] =>
    (Array.isArray(v) ? v : []).map((o) =>
      o && typeof o === 'object'
        ? {
            value: str((o as Opt).value),
            label: str((o as Opt).label, str((o as Opt).value)),
            disabled: !!(o as Opt).disabled,
          }
        : { value: str(o), label: str(o) },
    );

  // ── one function per node type: create the DOM, and update it ──
  type Kind = {
    create: (inst: Inst, p: Record<string, unknown>) => Node;
    update: (inst: Inst, p: Record<string, unknown>) => void;
    /** Where children go (containers only). */
    host?: (inst: Inst) => HTMLElement;
  };

  const box: Kind = {
    create: () => make('div'),
    update: (inst, p) => {
      const el = inst.el as HTMLElement;
      const dir = str(p.dir, 'col');
      const grid = dir === 'grid';
      el.className = [
        grid ? 'grid' : 'flex',
        dir === 'row' ? 'flex-row' : grid ? '' : 'flex-col',
        dir === 'row' && p.wrap !== false ? 'flex-wrap' : '',
        p.border ? 'rounded-md border border-line' : '',
        BGS[str(p.bg)] ?? '',
        p.bg && !p.border ? 'rounded-md' : '',
        textCls({ tone: p.tone ?? 'default', size: p.size, weight: p.weight }),
        'min-w-0',
      ]
        .filter(Boolean)
        .join(' ');
      const base: Record<string, string> = { gap: space(p.gap, dir === 'row' ? 1.5 : 2) };
      if (p.padding !== undefined) base.padding = space(p.padding, 0);
      if (p.align) base['align-items'] = ALIGN[str(p.align)] ?? 'stretch';
      else if (dir === 'row') base['align-items'] = 'center';
      if (p.justify) base['justify-content'] = JUSTIFY[str(p.justify)] ?? 'flex-start';
      if (grid)
        base['grid-template-columns'] =
          `repeat(${Math.max(1, Math.min(12, num(p.cols) ?? 2))}, minmax(0, 1fr))`;
      applyStyle(el, inst, p, base);
    },
    host: (inst) => inst.el as HTMLElement,
  };

  const kinds: Record<string, Kind> = {
    box,
    text: {
      create: (_i, p) => make(p.block ? 'div' : 'span'),
      update: (inst, p) => {
        const el = inst.el as HTMLElement;
        el.className = textCls(p);
        const style: Record<string, string> = {};
        if (typeof p.color === 'string' && HEX.test(p.color)) style.color = p.color;
        applyStyle(el, inst, p, style);
      },
      host: (inst) => inst.el as HTMLElement,
    },
    heading: {
      create: () => make('div'),
      update: (inst, p) => {
        const el = inst.el as HTMLElement;
        const level = Math.max(1, Math.min(4, num(p.level) ?? 3));
        el.setAttribute('role', 'heading');
        el.setAttribute('aria-level', String(level));
        el.className = `font-semibold text-text ${['text-xl', 'text-lg', 'text-base', 'text-sm'][level - 1]}`;
        el.textContent = str(p.text);
        applyStyle(el, inst, p);
      },
    },
    markdown: {
      create: () => make('div', 'tm-prose tm-md text-sm'),
      update: (inst, p) => {
        const el = inst.el as HTMLElement;
        const md = str(p.md);
        if ((inst as Inst & { md?: string }).md === md) return;
        (inst as Inst & { md?: string }).md = md;
        el.innerHTML = renderMarkdown(md, { ticketHref: ctx.ticketHref, breaks: true }).html;
      },
    },
    badge: {
      create: () => make('span'),
      update: (inst, p) => {
        const el = inst.el as HTMLElement;
        const color = typeof p.color === 'string' && HEX.test(p.color) ? p.color : null;
        el.className = `inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium whitespace-nowrap ${color ? '' : (BADGE_TONES[str(p.tone, 'neutral')] ?? BADGE_TONES.neutral)}`;
        el.textContent = str(p.text);
        applyStyle(
          el,
          inst,
          p,
          color
            ? {
                background: `color-mix(in srgb, ${color} 18%, transparent)`,
                color: `color-mix(in srgb, ${color} 75%, var(--tm-text))`,
              }
            : {},
        );
      },
    },
    divider: {
      create: () => make('hr', 'border-line'),
      update: (inst, p) => applyStyle(inst.el as HTMLElement, inst, p),
    },
    link: {
      create: () => make('a', 'text-accent hover:underline'),
      update: (inst, p) => {
        const el = inst.el as HTMLAnchorElement;
        const href = safeHref(p.href);
        el.textContent = str(p.label, str(p.href));
        if (href) {
          el.href = href;
          const ext = !href.startsWith('/');
          if (ext) {
            el.target = '_blank';
            el.rel = 'noopener noreferrer nofollow';
          } else {
            el.removeAttribute('target');
            el.removeAttribute('rel');
          }
        } else el.removeAttribute('href');
        el.onclick = (e) => e.stopPropagation();
        applyStyle(el, inst, p);
      },
    },
    image: {
      create: () => {
        const img = make('img', 'max-w-full');
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        return img;
      },
      update: (inst, p) => {
        const el = inst.el as HTMLImageElement;
        const src = safeImage(p.src);
        if (src && el.getAttribute('src') !== src) el.src = src;
        if (!src) el.removeAttribute('src');
        el.alt = str(p.alt);
        const style: Record<string, string> = {};
        if (num(p.width)) style.width = `${num(p.width)}px`;
        if (num(p.height)) style.height = `${num(p.height)}px`;
        if (num(p.radius) !== null) style['border-radius'] = `${num(p.radius)}px`;
        style['object-fit'] = 'cover';
        applyStyle(el, inst, p, style);
      },
    },
    person: {
      create: () => make('span', 'inline-flex min-w-0'),
      update: (inst, p) => {
        const el = inst.el as HTMLElement;
        const key = `${str(p.id)}|${num(p.size) ?? 20}|${p.showName !== false}`;
        if ((inst as Inst & { pk?: string }).pk === key) return;
        (inst as Inst & { pk?: string }).pk = key;
        inst.cleanup?.();
        el.textContent = '';
        if (ctx.person)
          inst.cleanup = ctx.person(el, str(p.id), {
            size: num(p.size) ?? 20,
            showName: p.showName !== false,
          });
        else el.textContent = str(p.id);
      },
    },
    ticket: {
      create: () =>
        make(
          'a',
          'inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 font-mono text-xs text-accent hover:underline',
        ),
      update: (inst, p) => {
        const el = inst.el as HTMLAnchorElement;
        const key = str(p.key).toUpperCase();
        el.textContent = str(p.label) ? `${key} ${str(p.label)}` : key;
        const href = ctx.ticketHref?.(key);
        if (href) el.href = href;
        el.onclick = (e) => {
          e.stopPropagation();
          if (ctx.openTicket) {
            e.preventDefault();
            ctx.openTicket(key);
          }
        };
      },
    },
    progress: {
      create: () => {
        const outer = make('div', 'h-1.5 w-full overflow-hidden rounded-full bg-surface-2');
        outer.append(make('div', 'h-full rounded-full bg-accent'));
        outer.setAttribute('role', 'progressbar');
        return outer;
      },
      update: (inst, p) => {
        const el = inst.el as HTMLElement;
        const max = num(p.max) ?? 100;
        const value = Math.max(0, Math.min(max, num(p.value) ?? 0));
        const bar = el.firstElementChild as HTMLElement;
        bar.style.width = `${max ? (value / max) * 100 : 0}%`;
        if (typeof p.color === 'string' && HEX.test(p.color)) bar.style.background = p.color;
        el.setAttribute('aria-valuenow', String(value));
        el.setAttribute('aria-valuemax', String(max));
        applyStyle(el, inst, p);
      },
    },
    input: {
      create: (inst, p) => {
        const input = make('input', `h-8 ${CONTROL}`);
        input.autocomplete = 'off';
        const read = () =>
          input.type === 'number' ? (input.value === '' ? null : input.valueAsNumber) : input.value;
        input.addEventListener('input', () =>
          send(inst, (inst.v as VElement).p.onInput, [read(), { name: input.name }]),
        );
        input.addEventListener('change', () =>
          send(inst, (inst.v as VElement).p.onChange, [read(), { name: input.name }]),
        );
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter')
            send(inst, (inst.v as VElement).p.onEnter, [read(), { name: input.name }]);
        });
        return field(inst, input, p);
      },
      update: (inst, p) => {
        const el = inst.parts!.control as HTMLInputElement;
        const TYPES = [
          'text',
          'number',
          'email',
          'url',
          'tel',
          'date',
          'datetime-local',
          'time',
          'password',
          'search',
          'color',
        ];
        const type = TYPES.includes(str(p.type)) ? str(p.type) : 'text';
        if (el.type !== type) el.type = type;
        el.name = str(p.name);
        el.placeholder = str(p.placeholder);
        el.disabled = isStatic || !!p.disabled;
        if (num(p.min) !== null) el.min = String(p.min);
        if (num(p.max) !== null) el.max = String(p.max);
        if (num(p.step) !== null) el.step = String(p.step);
        writeValue(inst, el, p);
        updateField(inst, p);
        applyStyle(inst.el as HTMLElement, inst, p);
      },
    },
    textarea: {
      create: (inst, p) => {
        const ta = make('textarea', `py-1.5 ${CONTROL}`);
        ta.addEventListener('input', () =>
          send(inst, (inst.v as VElement).p.onInput, [ta.value, { name: ta.name }]),
        );
        ta.addEventListener('change', () =>
          send(inst, (inst.v as VElement).p.onChange, [ta.value, { name: ta.name }]),
        );
        return field(inst, ta, p);
      },
      update: (inst, p) => {
        const el = inst.parts!.control as HTMLTextAreaElement;
        el.name = str(p.name);
        el.placeholder = str(p.placeholder);
        el.rows = Math.max(1, Math.min(30, num(p.rows) ?? 3));
        el.disabled = isStatic || !!p.disabled;
        writeValue(inst, el, p);
        updateField(inst, p);
        applyStyle(inst.el as HTMLElement, inst, p);
      },
    },
    select: {
      create: (inst, p) => {
        const sel = make('select', `h-8 ${CONTROL}`);
        sel.addEventListener('change', () => {
          const value = sel.multiple ? [...sel.selectedOptions].map((o) => o.value) : sel.value;
          send(inst, (inst.v as VElement).p.onChange, [value, { name: sel.name }]);
        });
        return field(inst, sel, p);
      },
      update: (inst, p) => {
        const el = inst.parts!.control as HTMLSelectElement;
        el.multiple = !!p.multiple;
        el.className = `${p.multiple ? 'py-1' : 'h-8'} ${CONTROL}`;
        el.name = str(p.name);
        el.disabled = isStatic || !!p.disabled;
        const opts = options(p.options);
        if (p.placeholder !== undefined && !p.multiple)
          opts.unshift({ value: '', label: str(p.placeholder), disabled: false });
        const sig = JSON.stringify(opts);
        if ((inst as Inst & { sig?: string }).sig !== sig) {
          (inst as Inst & { sig?: string }).sig = sig;
          el.textContent = '';
          for (const o of opts) {
            const op = make('option');
            op.value = o.value;
            op.textContent = o.label || ' ';
            op.disabled = !!o.disabled;
            el.append(op);
          }
        }
        if ('value' in p && !(inst.sent > ack)) {
          const want = p.multiple
            ? new Set((Array.isArray(p.value) ? p.value : []).map((x) => str(x)))
            : new Set([str(p.value)]);
          for (const o of el.options) o.selected = want.has(o.value);
          if (!p.multiple && !want.has(el.value)) el.selectedIndex = -1;
        }
        updateField(inst, p);
        applyStyle(inst.el as HTMLElement, inst, p);
      },
    },
    checkbox: {
      create: (inst) => {
        const wrap = make('label', 'flex cursor-pointer items-start gap-2 text-sm select-none');
        const box = make(
          'input',
          'mt-0.5 size-4 shrink-0 cursor-pointer rounded border-line-strong accent-[var(--tm-accent)]',
        );
        box.type = 'checkbox';
        const text = make('span', 'leading-5');
        const msg = make('p', 'text-xs');
        const col = make('span', 'flex flex-col');
        col.append(text, msg);
        wrap.append(box, col);
        box.addEventListener('change', () =>
          send(inst, (inst.v as VElement).p.onChange, [box.checked, { name: box.name }]),
        );
        inst.parts = { control: box, text, msg };
        return wrap;
      },
      update: (inst, p) => {
        const { control, text, msg } = inst.parts! as {
          control: HTMLInputElement;
          text: HTMLElement;
          msg: HTMLElement;
        };
        text.textContent = str(p.label);
        control.name = str(p.name);
        control.disabled = isStatic || !!p.disabled;
        if ('checked' in p && !(inst.sent > ack)) control.checked = !!p.checked;
        const err = str(p.error) || (p.name ? (errors[str(p.name)] ?? '') : '');
        msg.textContent = err || str(p.hint);
        msg.className = `text-xs ${err ? 'text-danger' : 'text-subtle'}`;
        msg.hidden = !(err || p.hint);
        applyStyle(inst.el as HTMLElement, inst, p);
      },
    },
    radio: {
      create: (inst, p) => {
        const group = make('div', 'flex flex-wrap gap-x-4 gap-y-1');
        group.setAttribute('role', 'radiogroup');
        group.addEventListener('change', (e) => {
          const t = e.target as HTMLInputElement;
          if (t.checked)
            send(inst, (inst.v as VElement).p.onChange, [
              t.value,
              { name: str((inst.v as VElement).p.name) },
            ]);
        });
        return field(inst, group, p);
      },
      update: (inst, p) => {
        const group = inst.parts!.control as HTMLElement;
        const opts = options(p.options);
        const sig = JSON.stringify(opts);
        const gname =
          (inst as Inst & { gname?: string }).gname ??
          `tplr-${Math.random().toString(36).slice(2, 10)}`;
        (inst as Inst & { gname?: string }).gname = gname;
        if ((inst as Inst & { sig?: string }).sig !== sig) {
          (inst as Inst & { sig?: string }).sig = sig;
          group.textContent = '';
          for (const o of opts) {
            const l = make('label', 'flex cursor-pointer items-center gap-1.5 text-sm');
            const r = make('input', 'size-4 accent-[var(--tm-accent)]');
            r.type = 'radio';
            r.name = gname;
            r.value = o.value;
            r.disabled = !!o.disabled;
            const s = make('span');
            s.textContent = o.label;
            l.append(r, s);
            group.append(l);
          }
        }
        for (const r of group.querySelectorAll('input')) {
          r.disabled = isStatic || !!p.disabled || r.disabled;
          if ('value' in p && !(inst.sent > ack)) r.checked = r.value === str(p.value);
        }
        updateField(inst, p);
        applyStyle(inst.el as HTMLElement, inst, p);
      },
    },
    button: {
      create: (inst) => {
        const b = make('button');
        b.type = 'button';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          send(inst, (inst.v as VElement).p.onClick, []);
        });
        return b;
      },
      update: (inst, p) => {
        const el = inst.el as HTMLButtonElement;
        const variant = BUTTONS[str(p.variant, 'secondary')] ?? BUTTONS.secondary;
        const size = str(p.size) === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-sm';
        el.className = `inline-flex w-fit items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-50 ${variant} ${size}`;
        el.textContent = str(p.label);
        el.disabled = isStatic || !!p.disabled;
        applyStyle(el, inst, p);
      },
    },
    el: {
      create: (_i, p) => document.createElement(str(p.tag, 'div')),
      update: (inst, p) => {
        const el = inst.el as HTMLElement;
        for (const a of EL_ATTRS) {
          if (a in p && p[a] !== false && p[a] !== null) el.setAttribute(a, str(p[a]));
          else el.removeAttribute(a);
        }
        applyStyle(el, inst, p);
      },
      host: (inst) => inst.el as HTMLElement,
    },
  };

  // ── reconciliation ──
  const typeOf = (v: Slot) =>
    v === null
      ? '#hole'
      : typeof v === 'string'
        ? '#text'
        : v.t === 'el'
          ? `el:${str(v.p.tag)}`
          : v.t;

  function create(v: Slot, id: string): Inst {
    const type = typeOf(v);
    const inst: Inst = { type, id, el: null as unknown as Node, v, children: [], sent: 0 };
    if (v === null) inst.el = document.createComment('');
    else if (typeof v === 'string') inst.el = document.createTextNode(v);
    else {
      const k = kinds[v.t];
      if (!k) {
        const unknown = make('span', 'text-xs text-danger');
        unknown.textContent = `[unknown node ${v.t}]`;
        inst.el = unknown;
        return inst;
      }
      inst.el = k.create(inst, v.p);
      k.update(inst, v.p);
      if (k.host) inst.children = patchChildren(k.host(inst), [], v.c ?? []);
    }
    return inst;
  }

  function patch(inst: Inst, v: Slot) {
    const prev = inst.v;
    inst.v = v;
    if (v === null) return;
    if (typeof v === 'string') {
      if (prev !== v) (inst.el as Text).data = v;
      return;
    }
    const k = kinds[v.t];
    if (!k) return;
    k.update(inst, v.p);
    if (k.host) inst.children = patchChildren(k.host(inst), inst.children, v.c ?? []);
  }

  function destroyInst(inst: Inst) {
    inst.cleanup?.();
    for (const c of inst.children) destroyInst(c);
  }

  function patchChildren(parent: HTMLElement, old: Inst[], next: Slot[]): Inst[] {
    const byId = new Map(old.map((i) => [i.id, i]));
    const out: Inst[] = [];
    next.forEach((v, i) => {
      const id = v && typeof v === 'object' && v.k !== undefined ? `k:${v.k}` : `i:${i}`;
      const have = byId.get(id);
      if (have && have.type === typeOf(v)) {
        byId.delete(id);
        patch(have, v);
        out.push(have);
      } else out.push(create(v, id));
    });
    for (const gone of byId.values()) {
      destroyInst(gone);
      gone.el.parentNode?.removeChild(gone.el);
    }
    // Put each node in place; one already in place is never moved (moving would blur it).
    out.forEach((inst, i) => {
      const at = parent.childNodes[i];
      if (at !== inst.el) parent.insertBefore(inst.el, at ?? null);
    });
    while (parent.childNodes.length > out.length) parent.removeChild(parent.lastChild!);
    return out;
  }

  return {
    /** Patch to `tree`. `ackSeq`: the newest event the worker had seen when it drew it. */
    update(tree: Slot[] | null, ackSeq = ack) {
      ack = Math.max(ack, ackSeq);
      if (tree) lastTree = tree;
      insts = patchChildren(root, insts, lastTree);
    },
    /** A refused submit's field errors (by input name); {} clears them. */
    setErrors(e: Record<string, string>) {
      errors = e;
      insts = patchChildren(root, insts, lastTree);
    },
    destroy() {
      for (const i of insts) destroyInst(i);
      insts = [];
      root.textContent = '';
    },
  };
}
export type Renderer = ReturnType<typeof createRenderer>;
