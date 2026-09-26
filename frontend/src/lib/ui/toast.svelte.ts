/**
 * Toasts: `toast.error('Could not save')`, `toast.success('Board created')`,
 * `toast.show({ message, action: { label: 'Undo', run } })`.
 * Rendered by <Toaster/> (mounted once in the root layout).
 */
export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: { label: string; run: () => void };
  /** Several buttons (e.g. a failed write's Open · Cancel). Each dismisses the toast. */
  actions?: { label: string; run: () => void; tone?: 'accent' | 'muted' }[];
  /** Identifies the toast so its owner can dismiss it (toast.dismissKey). A new toast with the same key replaces it. */
  key?: string;
  /** Called when the × is pressed (not when an action runs). */
  ondismiss?: () => void;
  /** ms; 0 = sticky */
  duration: number;
}

class Toasts {
  items = $state<ToastItem[]>([]);
  private next = 1;

  show(t: Partial<Omit<ToastItem, 'id'>> & { message: string }): number {
    const id = this.next++;
    const item: ToastItem = { kind: 'info', duration: t.kind === 'error' ? 6000 : 4000, ...t, id };
    const rest = item.key ? this.items.filter((x) => x.key !== item.key) : this.items;
    this.items = [...rest.slice(-4), item];
    if (item.duration > 0 && typeof setTimeout !== 'undefined')
      setTimeout(() => this.dismiss(id), item.duration);
    return id;
  }
  info(message: string, detail?: string) {
    return this.show({ kind: 'info', message, detail });
  }
  success(message: string, detail?: string) {
    return this.show({ kind: 'success', message, detail });
  }
  error(message: string, detail?: string) {
    return this.show({ kind: 'error', message, detail });
  }
  update(id: number, p: Partial<Omit<ToastItem, 'id'>>) {
    this.items = this.items.map((t) => (t.id === id ? { ...t, ...p } : t));
  }
  has(id: number) {
    return this.items.some((t) => t.id === id);
  }
  dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }
  dismissKey(key: string) {
    if (this.items.some((t) => t.key === key)) this.items = this.items.filter((t) => t.key !== key);
  }
  clear() {
    this.items = [];
  }
}

export const toast = new Toasts();
