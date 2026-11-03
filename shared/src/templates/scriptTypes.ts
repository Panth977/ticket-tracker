/**
 * THE BOARD SCRIPT'S TYPES (docs/plan/board-script.html §editor) — a declaration
 * file the Script editor hands to Monaco, so a board admin gets completion,
 * hover docs and errors for every hook, `ui.*`, `h.*`, `dates.*` and `api.*`.
 * The runtime is plain JavaScript; these types only describe it. Keep them in
 * step with frontend/src/lib/templates/worker/runtime.js and ./script.ts (a
 * unit test type-checks the default and generated scripts against them).
 */
export const BOARD_SCRIPT_DTS = `
/** A ticket as the board script sees it. */
interface Ticket {
  id: string;
  key: string;
  title: string;
  /** Plain text of the description ('' when none). */
  description: string;
  stageId: string;
  stage: { id: string; name: string; color: string | null; category: string; description: string | null } | null;
  assigneeUids: string[];
  assignees: Member[];
  priorityId: string | null;
  priority: PickOption | null;
  tagIds: string[];
  tags: PickOption[];
  startAt: number | null;
  dueAt: number | null;
  dueAllDay: boolean;
  estimate: number | null;
  /** Each assignee's commitment date (millis). */
  commitments: Record<string, number | null>;
  /** As stored: settings fields by id (f_xxxxxx) and the script's own values by key. */
  fields: Record<string, any>;
  /** Settings fields by name, readable (option and member names). */
  fieldsByName: Record<string, unknown>;
  reporter: { id: string | null; name: string };
  state: string;
  counts: { messages: number; files: number };
  /** Task lists: done / total, or null. */
  tasks: { done: number; total: number } | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}
interface PickOption { id: string; name: string; color: string | null }
interface Member { id: string; kind: 'user' | 'agent'; name: string; email: string; role: string }
/** The person looking. */
interface Me { id: string; name: string; email: string; role: string }
interface Board {
  id: string;
  key: string;
  name: string;
  description: string | null;
  stages: (PickOption & { category: string; description: string | null })[];
  priorities: PickOption[];
  tags: PickOption[];
  fields: { id: string; name: string; type: string; required: boolean; options: PickOption[] }[];
}
type Filters = Record<string, any>;

/** What onFieldChange / onBulkChange / updateTicket write. */
interface Patch {
  title?: string;
  assigneeUids?: string[];
  priorityId?: string | null;
  tagIds?: string[];
  startAt?: number | null;
  dueAt?: number | null;
  dueAllDay?: boolean;
  estimate?: number | null;
  commitments?: Record<string, number | null>;
  /** Merged per key; null clears one. */
  fields?: Record<string, string | number | boolean | null | string[] | { start: number; end: number }>;
}

// ───────── ui.* : the controls the app draws ─────────
interface SelectOption { value: string; label: string; color?: string | null }
interface ControlBase {
  /** What onFieldChange / the filters get it back as. */
  id: string;
  label?: string;
  disabled?: boolean;
  hidden?: boolean;
  /** A star after the label. */
  required?: boolean;
  /** A tooltip / hint. */
  help?: string;
  placeholder?: string;
}
type Control = ControlBase & { type: string };
declare const ui: {
  /** One line of text; changes on blur or Enter. */
  text(o: ControlBase & { value?: string | null }): Control;
  /** Several lines; changes on blur or Ctrl/⌘+Enter. */
  longText(o: ControlBase & { value?: string | null }): Control;
  number(o: ControlBase & { value?: number | null; min?: number; max?: number; step?: number }): Control;
  toggle(o: ControlBase & { value?: boolean }): Control;
  select(o: ControlBase & { value?: string | null; options: SelectOption[]; clearable?: boolean }): Control;
  multiSelect(o: ControlBase & { value?: string[]; options: SelectOption[] }): Control;
  /** People on the board. value: uids (one uid with multiple: false). */
  people(o: ControlBase & { value?: string[] | string | null; multiple?: boolean; people?: string[]; commitments?: boolean }): Control;
  /** A date (millis). With withTime, onFieldChange gets allDay too. */
  date(o: ControlBase & { value?: number | null; withTime?: boolean; allDay?: boolean }): Control;
  dateRange(o: ControlBase & { value?: { start: number; end: number } | null }): Control;
  /** Markdown text, no value. */
  note(o: { text: string; label?: string; tone?: 'default' | 'subtle' | 'warning' | 'danger' | 'success'; hidden?: boolean }): Control;
};

// ───────── h.* : trees the app draws (cards, cells, previews, forms) ─────────
/** A drawn node. */
interface HNode { readonly $tm: 1 }
type Child = HNode | string | number | null | undefined | false | true | Child[];
interface BoxProps {
  key?: string | number;
  gap?: number;
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  cols?: number;
  padding?: number;
  border?: boolean;
  bg?: 'surface' | 'muted' | 'accent' | 'success' | 'warning' | 'danger';
  style?: Record<string, string>;
  title?: string;
}
interface TextProps {
  key?: string | number;
  tone?: 'default' | 'muted' | 'subtle' | 'accent' | 'success' | 'warning' | 'danger';
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
  mono?: boolean;
  italic?: boolean;
  strike?: boolean;
  truncate?: boolean;
  color?: string;
  title?: string;
}
type Handler<A> = (a: A) => void | Promise<void>;
interface CalendarItem { id: string; title: string; start: number; end?: number | null; allDay?: boolean; color?: string | null }
interface TimelineItem { id: string; title: string; start: number; end?: number | null; color?: string | null; group?: string | null }
declare const h: {
  col(props?: BoxProps | Child, ...children: Child[]): HNode;
  row(props?: BoxProps | Child, ...children: Child[]): HNode;
  grid(props?: BoxProps | Child, ...children: Child[]): HNode;
  div(props?: BoxProps | Child, ...children: Child[]): HNode;
  text(props: TextProps | string | number, ...children: Child[]): HNode;
  heading(o: { text: string; level?: 1 | 2 | 3 | 4; key?: string | number } | string): HNode;
  markdown(o: { md: string; key?: string | number } | string): HNode;
  badge(o: { text: string; tone?: TextProps['tone']; color?: string | null; key?: string | number } | string): HNode;
  divider(o?: { key?: string | number }): HNode;
  link(o: { label: string; href: string; key?: string | number } | string): HNode;
  image(o: { src: string; alt?: string; width?: number; height?: number; radius?: number } | string): HNode;
  /** A board member's picture (and name). */
  person(o: { id: string; size?: number; showName?: boolean; key?: string | number } | string): HNode;
  /** A ticket chip that opens it. */
  ticket(o: { key: string; label?: string } | string): HNode;
  progress(o: { value: number; max?: number; color?: string }): HNode;
  input(o: { label?: string; name?: string; value?: string | number | null; type?: string; placeholder?: string; hint?: string; error?: string; required?: boolean; disabled?: boolean; min?: number; max?: number; step?: number; onInput?: (v: any) => void; onChange?: (v: any) => void; onEnter?: (v: any) => void; key?: string | number }): HNode;
  textarea(o: { label?: string; name?: string; value?: string; rows?: number; placeholder?: string; hint?: string; error?: string; onInput?: (v: string) => void; onChange?: (v: string) => void; key?: string | number }): HNode;
  select(o: { label?: string; name?: string; value?: any; options: (string | { value: string; label: string; disabled?: boolean })[]; placeholder?: string; multiple?: boolean; onChange?: (v: any) => void; key?: string | number }): HNode;
  radio(o: { label?: string; name?: string; value?: string; options: (string | { value: string; label: string })[]; onChange?: (v: string) => void }): HNode;
  checkbox(o: { label?: string; name?: string; checked?: boolean; hint?: string; onChange?: (v: boolean) => void }): HNode;
  button(o: { label: string; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; disabled?: boolean; onClick?: () => void; key?: string | number } | string): HNode;
  el(tag: string, props?: Record<string, unknown> | Child, ...children: Child[]): HNode;
  /** The app's calendar. Drag a chip to another day → onMove (same time of day). */
  calendar(o: {
    items: CalendarItem[];
    view?: 'month' | 'week';
    /** The day it opens on (millis). */
    date?: number;
    weekStartsOn?: number;
    onOpen?: Handler<{ id: string }>;
    onMove?: Handler<{ id: string; start: number; end: number | null }>;
    onDateChange?: Handler<{ date: number; view: 'month' | 'week' }>;
  }): HNode;
  /** The app's Gantt. Drag a bar to move it, its right edge to change the end. */
  timeline(o: {
    items: TimelineItem[];
    date?: number;
    days?: number;
    onOpen?: Handler<{ id: string }>;
    onMove?: Handler<{ id: string; start: number; end: number | null }>;
  }): HNode;
};

// ───────── dates.* : in the viewer's time zone ─────────
declare const dates: {
  now(): number;
  tz(): string;
  startOfDay(o: { ms: number }): number;
  startOfWeek(o: { ms: number; weekStartsOn?: number }): number;
  startOfMonth(o: { ms: number }): number;
  addDays(o: { ms: number; days: number }): number;
  addMonths(o: { ms: number; months: number }): number;
  parts(o: { ms: number }): { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
  format(o: { ms: number; style?: 'date' | 'time' | 'datetime' | 'month' }): string;
};

// ───────── api.* : read-only, as the viewer ─────────
interface Api {
  board(): Promise<Board>;
  me(): Promise<Me>;
  members(): Promise<Member[]>;
  tickets: {
    get(o: { key: string }): Promise<Ticket | null>;
    list(o?: { stage?: string; assignee?: string; tag?: string; priority?: string; text?: string; limit?: number }): Promise<Ticket[]>;
    search(o: { text: string; limit?: number }): Promise<Ticket[]>;
  };
  /** Another board the viewer can read: its active tickets. */
  boards: { tickets(o: { board: string; text?: string; limit?: number }): Promise<Ticket[]> };
  /** This person's small store for this board (JSON). */
  storage: { get(o: { key: string }): Promise<any>; set(o: { key: string; value: any }): Promise<true> };
}
declare const api: Api;

// ───────── the hooks ─────────
interface Who { me: Me; board: Board }
type FormResult =
  | { type: 'valid'; msg: string; data?: unknown }
  | { type: 'valid'; ticket: { title: string; description?: string; stage?: string; priority?: string | null; tags?: string[]; assignees?: string[]; dueAt?: number | string | null; dueAllDay?: boolean; startAt?: number | string | null; estimate?: number | null; fields?: Record<string, unknown> } }
  | { type: 'invalid'; errMsg?: string; error?: Record<string, string> };
interface PreviewArgs<S> extends Who {
  /** The board's tickets after the script's filters. */
  tickets: Ticket[];
  openTicket(o: { id: string }): void;
  updateTicket(o: { id: string; patch: Patch }): void;
  state: S;
  setState(patch: Partial<S> | ((s: S) => Partial<S>)): void;
}
type Preview<S = any> = ((a: PreviewArgs<S>) => HNode | Child) | { state?: (a: Who) => S | Promise<S>; render: (a: PreviewArgs<S>) => HNode | Child };

interface BoardScript {
  /** The filter values a person starts with. */
  filters?(a: Who): Filters;
  /** The Filter menu's controls. */
  filterRender?(a: Who & { filters: Filters }): Control[];
  /** Runs for every ticket, even with no filter set: true = show it. */
  onFilter?(a: Who & { ticket: Ticket; filters: Filters }): boolean | Promise<boolean>;
  /** Like Array.sort's compare; replaces the view's sort. Synchronous. */
  onSort?(a: Who & { a: Ticket; b: Ticket; filters: Filters }): number;
  /** The ticket's fields, under Stage. */
  fieldRender(a: Who & { ticket: Ticket }): Control[] | Promise<Control[]>;
  /** A field changed: the patch to write, or nothing. */
  onFieldChange?(a: Who & { ticket: Ticket; id: string; value: any; allDay?: boolean }): Patch | void | null | Promise<Patch | void | null>;
  /** One card of the Board view (without it: the app's own card). */
  previewTicketCard?(a: Who & { ticket: Ticket }): HNode | Child;
  /** The Table view: columns, and each row's cells (text, h.* or an editable ui.* control). */
  previewTicketTable?(a: Who & { tickets: Ticket[] }): {
    columns: { id: string; label: string; width?: number; align?: 'left' | 'center' | 'right'; open?: boolean }[];
    rows: { id: string; cells: Record<string, string | number | null | HNode | Control> }[];
  };
  /** The bulk bar's controls (rows selected in the Table). */
  bulkRender?(a: Who & { tickets: Ticket[] }): Control[];
  /** One patch for every selected ticket, or { patches: { [ticketId]: patch } }. */
  onBulkChange?(a: Who & { tickets: Ticket[]; id: string; value: any; allDay?: boolean }): Patch | { patches: Record<string, Patch> } | void | null;
  /** Your own views: each key is a tab next to Board and Table. */
  previews?(a: Who): Record<string, Preview>;
  /** Message forms (the composer's 📋) and ticket forms (New ticket). */
  forms?(a: Who): { id: string; kind: 'message' | 'ticket'; name: string; description?: string }[];
  formState?(a: Who & { id: string; ticket: Ticket | null }): any;
  formRender?(a: Who & { id: string; state: any; setState(patch: any): void; ticket: Ticket | null }): HNode | Child;
  formSubmit?(a: Who & { id: string; state: any; ticket: Ticket | null }): FormResult | Promise<FormResult>;
  /** The board's read-only api (also the global 'api'). */
  api?: Api;
}

/**
 * Declares the board script. Every hook's arguments are typed, so the editor
 * completes 'ticket.', 'ui.', 'h.' and 'dates.'.
 */
declare function defineScript<T extends BoardScript>(script: T & ThisType<T & { api: Api }>): T;
`;
