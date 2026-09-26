import { redirect } from '@sveltejs/kit';
import { routes } from '$lib/layout/routes';

// /account → the first section.
export function load() {
  redirect(307, routes.account('profile'));
}
