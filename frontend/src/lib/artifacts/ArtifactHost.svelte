<!--
  THE HOST PAGE of one artifact (docs/plan/artifacts.html §D3) — /x/{id}.

    [◆ Name · build a1B2c3 · 2 hours ago]        [Reload] [Share] [Settings] [⤢]
    ┌───────────────────────────────────────────────────────────────────────┐
    │ <iframe sandbox …  src = the build on the USERCONTENT origin>         │
    └───────────────────────────────────────────────────────────────────────┘

  The artifact is somebody else's code. It runs in a sandboxed iframe WITHOUT
  allow-same-origin — an opaque origin: no cookies, no storage, and above all
  no way to read this page's Firebase session — served from a second hosting
  site with a capability in its URL (§D2). Its only backend is postMessage to
  this page, answered by the broker (./broker), which makes each call as the
  signed-in viewer on a path under THIS artifact's prefix.

  Mounted under {#key artifactId}: one broker, one iframe, one set of timers
  per artifact, all gone on unmount.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { onDestroy, untrack } from 'svelte';
  import { page } from '$app/state';
  import {
    AppWindow,
    Lock,
    Maximize,
    Minimize,
    PackageOpen,
    RotateCw,
    SearchX,
    Settings,
    Share2,
    TriangleAlert,
  } from 'lucide-svelte';
  import { artifactCan, type CommandRes } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { relativeTime } from '$lib/account/format';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { workspaceContext } from '$lib/workspaces/context.svelte';
  import { switcherFor } from '$lib/workspaces/switcherStore';
  import WorkspaceCrumb from '$lib/workspaces/WorkspaceCrumb.svelte';
  import TitleSwitcher from '$lib/workspaces/TitleSwitcher.svelte';
  import { createBroker, type Broker } from './broker';
  import { firebaseBackend } from './firebaseBackend';
  import {
    artifactBuild,
    artifactDoc,
    artifactGlyph,
    firstSettingsSection,
    roleIn,
    shortBuild,
    viewerReadOnly,
  } from './store';

  let { artifactId }: { artifactId: string } = $props();

  // The name is also a switcher, as a board's is (agents.html §AB3): every
  // artifact — or, in a workspace that holds this one, that workspace's
  // boards and artifacts — with "Workspace ›" before it.
  const switchQ = $derived(switcherFor(auth.uid, { artifactId }, workspaceContext.id));
  const workspace = $derived($switchQ.workspace);
  const switchItems = $derived($switchQ.items);

  type Opened = CommandRes<'artifactOpen'>;
  /** Ask for a fresh capability this long before the one we hold expires (§D2). */
  const REFRESH_BEFORE_MS = 5 * 60_000;
  const RETRY_MS = 60_000;

  const uid = $derived(auth.uid);
  const docQ = $derived(artifactDoc(artifactId));
  const art = $derived($docQ.data);
  const role = $derived(roleIn(art, uid));

  /** What the iframe is showing. Replaced only by a reload — never by a refresh. */
  let opened = $state<Opened | null>(null);
  /**
   * The newest capability for the build on screen. Kept for the NEXT reload;
   * it is deliberately not put in the iframe's src, because changing src would
   * reload somebody's dashboard under them once an hour.
   */
  let spare: Opened | null = null;
  let opening = false;
  let failure = $state<{ kind: 'not_found' | 'error'; message?: string } | null>(null);
  /** True once this tab has been let in: losing the role after that is "revoked", not "not found". */
  let wasIn = $state(false);
  let revoked = $state(false);
  let frameEl = $state<HTMLIFrameElement | null>(null);
  /** Bumped by Reload so the same URL still gives a fresh iframe. */
  let generation = $state(0);

  const buildQ = $derived(artifactBuild(wasIn ? artifactId : null, opened?.buildId));
  const newer = $derived(
    !!opened && !!art?.currentBuild && art.currentBuild !== opened.buildId
      ? art.currentBuild
      : null,
  );
  const settingsSection = $derived(firstSettingsSection(role));

  // ── the broker: one for the life of this component ─────────────────────────
  let broker: Broker | null = null;
  let detach: (() => void) | null = null;

  $effect(() => {
    if (!art || !role || !uid || revoked) return;
    const readOnly = viewerReadOnly(art, role);
    untrack(() => {
      if (!broker) {
        broker = createBroker({
          // THE id: from this page's own URL. Nothing the iframe says can change it.
          artifactId,
          uid,
          frame: () => frameEl?.contentWindow ?? null,
          artifact: () => ({ name: art?.name ?? '', buildId: opened?.buildId ?? '' }),
          viewer: () => ({
            name: auth.profile?.name ?? auth.displayName,
            email: auth.user?.email ?? null,
            photoURL: auth.photoURL,
          }),
          role,
          readOnly,
          backend: firebaseBackend(artifactId),
          // §K: live — a grant the owner changes applies to the next call.
          boards: () => art?.boards ?? {},
          origin: window.location.origin,
        });
        detach = broker.attach(window);
      }
      // A role change, the read-only switch, archiving: the artifact hears 'readonly'.
      broker.setAccess(role, readOnly);
    });
  });

  // ── opening, and losing access ─────────────────────────────────────────────
  $effect(() => {
    if ($docQ.loading || revoked) return;
    const inNow = !!art && !!role;
    if (!inNow) {
      // The rules stopped answering (or the document went): if we were in, that is a revocation.
      if (untrack(() => wasIn)) revoke();
      else failure = { kind: 'not_found' };
      return;
    }
    wasIn = true;
    // Shared a moment ago: the first answer was "not found", this one is not.
    if (untrack(() => failure?.kind === 'not_found')) failure = null;
    if (art!.currentBuild && untrack(() => !opened && !failure)) void openBuild();
  });

  function revoke() {
    revoked = true;
    clearTimeout(refreshTimer);
    // Tell the artifact (it may want to say goodbye), then take it off the screen:
    // the broker has already dropped every listener it held.
    broker?.revoke();
    opened = null;
  }

  async function ask(buildId?: string): Promise<Opened> {
    return command(
      'artifactOpen',
      { artifactId, ...(buildId ? { buildId } : {}) },
      { toast: false },
    );
  }

  async function openBuild() {
    if (opening) return;
    opening = true;
    try {
      show(await ask());
    } catch (e) {
      // conflict = nothing published yet: the empty state below already says so.
      if (isAppError(e) && e.code === 'conflict' && !art?.currentBuild) return;
      failure =
        isAppError(e) && (e.code === 'not_found' || e.code === 'forbidden')
          ? { kind: 'not_found' }
          : { kind: 'error', message: e instanceof Error ? e.message : undefined };
    } finally {
      opening = false;
    }
  }

  function show(o: Opened) {
    failure = null;
    spare = null;
    opened = o;
    generation++;
    scheduleRefresh(o.expiresAt);
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleRefresh(expiresAt: number) {
    clearTimeout(refreshTimer);
    const wait = Math.max(expiresAt - Date.now() - REFRESH_BEFORE_MS, 30_000);
    refreshTimer = setTimeout(refresh, wait);
  }
  /** Keep a capability that is still good, for the build on screen (not the newest one). */
  async function refresh() {
    if (!opened || revoked) return;
    try {
      spare = await ask(opened.buildId);
      scheduleRefresh(spare.expiresAt);
    } catch (e) {
      // The build was pruned or access ended: nothing to keep. Anything else
      // (offline, a cold start) is worth another try.
      if (isAppError(e) && ['not_found', 'forbidden', 'conflict'].includes(e.code)) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, RETRY_MS);
    }
  }

  let reloading = $state(false);
  /** The newest build if there is one; otherwise the same build again, on a fresh capability. */
  async function reload() {
    if (reloading || !opened) return;
    reloading = true;
    try {
      if (newer) show(await ask());
      else if (spare && spare.expiresAt - Date.now() > REFRESH_BEFORE_MS) show(spare);
      else show(await ask(opened.buildId));
    } catch (e) {
      failure = { kind: 'error', message: e instanceof Error ? e.message : undefined };
    } finally {
      reloading = false;
    }
  }

  // A new build while this tab is open: the artifact is told once per build,
  // the person gets the bar below. The tab keeps working on the old build —
  // its capability names that build (§D2).
  let announced: string | null = null;
  $effect(() => {
    if (!newer || newer === announced) return;
    announced = newer;
    broker?.announceBuild(newer);
  });

  onDestroy(() => {
    clearTimeout(refreshTimer);
    // Removes the window listener and closes every Firestore / RTDB listener
    // the artifact was holding through us.
    detach?.();
  });

  // ── full screen: no bar, no sidebar — a dashboard on a wall screen ─────────
  // ?full=1 starts that way, so the wall screen's bookmark is enough.
  let full = $state(untrack(() => page.url.searchParams.get('full') === '1'));
  function onKey(e: KeyboardEvent) {
    // Only reaches us while focus is in THIS page; inside the iframe the
    // artifact has the keyboard, which is what the handle below is for.
    if (full && e.key === 'Escape') full = false;
  }

  // The frame fills what is left under the Shell's phone header (and the
  // offline notice): measured, because those come and go.
  let hostEl = $state<HTMLElement | null>(null);
  let top = $state(0);
  function measure() {
    if (hostEl && !full)
      top = Math.max(0, Math.round(hostEl.getBoundingClientRect().top + window.scrollY));
  }
  $effect(() => {
    if (!hostEl) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => ro.disconnect();
  });
</script>

<svelte:window onkeydown={onKey} onresize={measure} />
<svelte:head><title>{art?.name ?? 'Artifact'} — TaskManager</title></svelte:head>

{#if revoked}
  <EmptyState
    icon={Lock}
    title="You no longer have access"
    description="This artifact is no longer shared with you. Ask its owner if you need it back."
  >
    {#snippet action()}<Button href={routes.artifacts()}>Your artifacts</Button>{/snippet}
  </EmptyState>
{:else if failure?.kind === 'not_found'}
  <!-- The app's normal Not found: an id that does not exist and one that is not shared with you look the same. -->
  <EmptyState
    icon={SearchX}
    title="Artifact not found"
    description="It may have been deleted, or it isn't shared with you."
  >
    {#snippet action()}<Button href={routes.artifacts()}>Your artifacts</Button>{/snippet}
  </EmptyState>
{:else if !art || !role}
  <div class="flex flex-col gap-3 p-6">
    <Skeleton height="1.5rem" width="16rem" /><Skeleton lines={4} />
  </div>
{:else}
  <div
    bind:this={hostEl}
    class="flex flex-col bg-bg {full ? 'fixed inset-0 z-40' : ''}"
    style:height={full ? undefined : `calc(100dvh - ${top}px)`}
    data-artifact-host={artifactId}
  >
    {#if !full}
      <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        {#if workspace}<WorkspaceCrumb {workspace} />{/if}
        <TitleSwitcher
          kind="artifact"
          items={switchItems}
          name={art.name}
          glyph={artifactGlyph(art)}
        />
        {#if art.archivedAt != null}
          <span class="shrink-0 rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning"
            >Archived</span
          >
        {/if}
        {#if opened}
          <span
            class="hidden min-w-0 shrink truncate text-xs text-subtle sm:inline"
            title={$buildQ.data?.message ?? `Build ${opened.buildId}`}
            data-build={opened.buildId}
          >
            build {shortBuild(opened.buildId)}{#if $buildQ.data}
              · {relativeTime($buildQ.data.createdAt)}{/if}
          </span>
        {/if}
        <span class="flex-1"></span>
        {#if opened}
          <IconButton
            icon={RotateCw}
            label="Reload the artifact"
            disabled={reloading}
            onclick={() => reload()}
          />
        {/if}
        {#if artifactCan.manage(role)}
          <Button
            size="sm"
            variant="ghost"
            icon={Share2}
            href={routes.artifactSettings(artifactId, 'people')}
            ><span class="hidden sm:inline">Share</span></Button
          >
        {/if}
        {#if settingsSection}
          <IconButton
            icon={Settings}
            label="Artifact settings"
            href={routes.artifactSettings(artifactId, settingsSection)}
          />
        {/if}
        {#if opened}
          <IconButton icon={Maximize} label="Full screen" onclick={() => (full = true)} />
        {/if}
      </header>
    {/if}

    {#if newer && !full}
      <div
        role="status"
        class="flex shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-3 py-1.5 text-sm"
      >
        <span class="min-w-0 flex-1 truncate">A new version of this artifact was published.</span>
        <Button size="sm" variant="primary" loading={reloading} onclick={() => reload()}
          >Reload</Button
        >
      </div>
    {/if}

    {#if failure}
      <EmptyState
        icon={TriangleAlert}
        title="Couldn't open this artifact"
        description={failure.message ??
          'Something went wrong. Check your connection and try again.'}
      >
        {#snippet action()}<Button onclick={() => ((failure = null), openBuild())}>Try again</Button
          >{/snippet}
      </EmptyState>
    {:else if !art.currentBuild}
      <!-- Created, nothing published yet (§A: a build is a folder with an index.html). -->
      <EmptyState
        icon={PackageOpen}
        title="Nothing published yet"
        description={artifactCan.publish(role)
          ? 'An artifact is a static folder with an index.html at its root. Publish one from the SDK, MCP or REST — or drop a zip on the Builds tab. Its backend is one script tag: window.BackendDriver.'
          : 'Its owner has not published a build yet. It will appear here when they do.'}
      >
        {#snippet action()}
          <div class="flex flex-wrap justify-center gap-2">
            {#if artifactCan.publish(role)}
              <Button variant="primary" href={routes.artifactSettings(artifactId, 'builds')}
                >Publish a build</Button
              >
            {/if}
            <!-- Static pages, not SPA routes: a full navigation, in a new tab. -->
            <a
              class="inline-flex h-8 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
              href={routes.integrate()}
              target="_blank"
              rel="noopener">How to publish</a
            >
            <a
              class="inline-flex h-8 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
              href={routes.backendDriver()}
              target="_blank"
              rel="noopener">The BackendDriver</a
            >
          </div>
        {/snippet}
      </EmptyState>
    {:else if !opened}
      <div class="flex flex-1 items-center justify-center text-sm text-muted" aria-busy="true">
        <AppWindow size={16} class="mr-2" aria-hidden="true" /> Opening…
      </div>
    {:else}
      <!--
        THE SANDBOX. No allow-same-origin, ever: with it the artifact would run
        on the usercontent origin proper and could keep state there across
        artifacts; without it the origin is opaque (§D1). The usercontent site
        sends the same list as a CSP header, so opening the file URL directly
        changes nothing.
          allow-scripts    it is an app
          allow-forms      <form> submits handled by its own script
          allow-popups     links out (target=_blank)
          allow-downloads  "export as CSV"
          allow-modals     alert / confirm / prompt
        `allow` is a Permissions Policy: everything powerful is denied outright
        (a cross-origin frame would not get it by default either — this says so);
        only fullscreen and writing to the clipboard ("Copy") are granted.
        no-referrer keeps this page's URL (and so the artifact id) out of the
        requests the artifact makes.
      -->
      {#key generation}
        <iframe
          bind:this={frameEl}
          title={art.name}
          src={opened.contentUrl}
          sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals"
          referrerpolicy="no-referrer"
          allow="fullscreen; clipboard-write; camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; midi 'none'; clipboard-read 'none'; publickey-credentials-get 'none'"
          class="min-h-0 w-full flex-1 border-0 bg-white"
          data-build={opened.buildId}
        ></iframe>
      {/key}
    {/if}

    {#if full}
      <!-- Esc cannot reach us while the artifact has focus, so there is always
           something to press: faint until hovered, and big enough for a thumb. -->
      <button
        type="button"
        class="fixed top-1 left-1/2 z-50 flex h-6 -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-surface/90 px-2.5 text-xs text-muted opacity-25 shadow-pop backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100"
        aria-label="Exit full screen"
        onclick={() => (full = false)}
      >
        <Minimize size={12} aria-hidden="true" /> Exit full screen
      </button>
    {/if}
  </div>
{/if}
