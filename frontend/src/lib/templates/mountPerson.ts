/** h.person(id): the app's own Principal chip, mounted into the renderer's node. */
import { mount, unmount } from 'svelte';
import Principal from '$lib/people/Principal.svelte';
import PrincipalAvatar from '$lib/people/PrincipalAvatar.svelte';

export function mountPerson(
  el: HTMLElement,
  id: string,
  opts: { size: number; showName: boolean },
): () => void {
  if (!id) return () => {};
  const c = opts.showName
    ? mount(Principal, { target: el, props: { id, layout: 'compact', size: opts.size } })
    : mount(PrincipalAvatar, { target: el, props: { id, size: opts.size } });
  return () => void unmount(c);
}
