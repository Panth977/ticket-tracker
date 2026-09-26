// /b/KEY/analytics moved into board settings (§Y3); links people already have keep working.
import { redirect } from '@sveltejs/kit';
import { routes } from '$lib/layout/routes';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  redirect(307, routes.boardAnalytics(params.boardKey));
};
