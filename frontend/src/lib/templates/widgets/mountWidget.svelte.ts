/**
 * h.calendar / h.timeline (docs/plan/board-script.html §previews): the renderer's
 * `widget` hook. Mounts the app's component once and feeds it each new render's
 * props; handler props (onOpen, onMove, onDateChange) become `send(prop, args)`.
 */
import { mount, unmount } from 'svelte';
import { browserTimeZone } from '$lib/ui/calendar';
import ScriptCalendar from './ScriptCalendar.svelte';
import ScriptTimeline from './ScriptTimeline.svelte';

const has = (p: Record<string, unknown>, k: string) =>
  !!p[k] && typeof p[k] === 'object' && typeof (p[k] as { $h?: unknown }).$h === 'string';

export function widgetMounter(tz: string = browserTimeZone()) {
  return (
    el: HTMLElement,
    type: 'calendar' | 'timeline',
    props: Record<string, unknown>,
    send: (prop: string, args: unknown[]) => void,
  ) => {
    const live = $state({ p: props });
    const view = {
      get items() {
        return Array.isArray(live.p.items) ? (live.p.items as never[]) : [];
      },
      get date() {
        return typeof live.p.date === 'number' ? live.p.date : null;
      },
      get can() {
        return {
          open: has(live.p, 'onOpen'),
          move: has(live.p, 'onMove'),
          date: has(live.p, 'onDateChange'),
        };
      },
    };
    const c =
      type === 'calendar'
        ? mount(ScriptCalendar, {
            target: el,
            props: {
              get items() {
                return view.items;
              },
              get view() {
                return live.p.view === 'week' ? ('week' as const) : ('month' as const);
              },
              get date() {
                return view.date;
              },
              get weekStartsOn() {
                return typeof live.p.weekStartsOn === 'number' ? live.p.weekStartsOn : 1;
              },
              tz,
              get can() {
                return view.can;
              },
              send,
            },
          })
        : mount(ScriptTimeline, {
            target: el,
            props: {
              get items() {
                return view.items;
              },
              get date() {
                return view.date;
              },
              get days() {
                return typeof live.p.days === 'number' ? live.p.days : 42;
              },
              tz,
              get can() {
                return view.can;
              },
              send,
            },
          });
    return {
      update: (p: Record<string, unknown>) => {
        live.p = p;
      },
      destroy: () => void unmount(c),
    };
  };
}
