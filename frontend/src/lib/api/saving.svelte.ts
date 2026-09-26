/** 'Saving…' — true while at least one command has been in flight for 250 ms. */
class Saving {
  count = $state(0);
  get active() {
    return this.count > 0;
  }
  bump(delta: 1 | -1) {
    this.count = Math.max(0, this.count + delta);
  }
}
export const saving = new Saving();
