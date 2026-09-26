/**
 * Principals — people and agents — as every screen shows them (agents.html §A).
 *   import { Principal, PrincipalAvatar, person } from '$lib/people';
 */
export { default as Principal } from './Principal.svelte';
export { default as PrincipalAvatar } from './PrincipalAvatar.svelte';
export { default as PrincipalName } from './PrincipalName.svelte';
export { default as AgentBadge } from './AgentBadge.svelte';
export { default as OwnerName } from './OwnerName.svelte';
export { person, principal, avatarUrl, noteBoardMembers, toPerson } from './person';
export type { PersonState } from './person';
export * from './principal';
export { principalChoices, principalSuggestItems } from './pickers';
export type { PrincipalSuggestItem } from './pickers';
