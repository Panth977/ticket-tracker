/**
 * The auth store: who is signed in, and their users/{uid} profile, as runes.
 *
 *   import { auth } from '$lib/firebase/auth.svelte';
 *   auth.status   'loading' | 'signedOut' | 'signedIn'
 *   auth.user     { uid, email, emailVerified, displayName, photoURL } | null
 *   auth.profile  WithId<User> | null           (live users/{uid})
 *   auth.profileStatus  'loading' | 'missing' | 'new' | 'ready'
 *   auth.uid      the signed-in uid — or, while auth is still restoring, the
 *                 REMEMBERED one, so the app's queries start on the first frame
 *   auth.presumedSignedIn  true while we are drawing a remembered session
 *
 * LOCAL FIRST (§T). Firebase Auth takes a few hundred milliseconds to read its
 * own IndexedDB on a reload; the device already knew the answer. So the last
 * principal is mirrored to localStorage (lib/boot/session — uid, name, photo,
 * theme, never a token) and read synchronously at start(): the shell, the
 * sidebar and the board draw immediately, the profile and the pointer's
 * listeners open at once, and auth restores underneath. If it comes back
 * signed OUT the memory is dropped, the Firestore cache with it, and the guard
 * redirects exactly as it did before.
 *
 * Sign-in: Google / Microsoft popup, or an email link. There is no gate:
 * anyone may sign up (onUserCreated makes users/{uid}); a first sign-in goes
 * through /welcome, which calls `finishWelcome()` when done.
 */
import {
  GoogleAuthProvider,
  OAuthProvider,
  getAdditionalUserInfo,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signInWithPopup,
  signOut as fbSignOut,
  type User as FbUser,
  type UserCredential,
} from 'firebase/auth';
import { paths, type Theme, type User } from '@tm/shared';
import { clearPersistentCache, getAuthClient } from './client';
import { forgetSentNotifications } from '$lib/notifications/autoRead';
import {
  forgetPointer,
  forgetSession,
  prewarm,
  readSession,
  rememberSession,
  stopPrewarm,
  trackPlace,
} from '$lib/boot';
import { docStore, registry, type WithId } from '$lib/stores/live';
import type { AuthStatus, ProfileStatus } from './guard';

export interface AuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
}

const EMAIL_KEY = 'tm.emailForSignIn';
const WELCOME_KEY = 'tm.welcomePending';

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

class AuthState {
  status = $state<AuthStatus>('loading');
  user = $state<AuthUser | null>(null);
  profile = $state<WithId<User> | null>(null);
  /** users/{uid} snapshot state. */
  private profileLoaded = $state(false);
  private welcomePending = $state(false);
  profileError = $state<Error | null>(null);
  /**
   * §T — the principal read out of localStorage at boot, kept until auth has
   * spoken. Dropped the moment auth disagrees (signed out, or someone else).
   */
  remembered = $state<{
    uid: string;
    displayName: string | null;
    photoURL: string | null;
    theme: Theme;
  } | null>(null);
  /**
   * §T — this boot painted the app from memory. It stays true once auth
   * confirms the same person, so the guard never drops a drawn app back to a
   * splash while users/{uid} is still arriving: no layout shift, and the top
   * progress bar (§K) remains the only sign that a refresh is in flight.
   */
  private painted = $state(false);

  /** The signed-in uid, or the remembered one while auth is still restoring. */
  get uid(): string | null {
    return this.user?.uid ?? this.remembered?.uid ?? null;
  }

  /** Draw the app? True for a remembered session auth has not yet contradicted. */
  get presumedSignedIn(): boolean {
    return this.status === 'signedIn' || (this.status === 'loading' && !!this.remembered);
  }

  /** The guard's §T input: something is already on screen from memory. */
  get fromMemory(): boolean {
    return this.painted;
  }

  /** The best name/photo we have — the remembered one until the profile lands. */
  get displayName(): string | null {
    return this.profile?.name ?? this.user?.displayName ?? this.remembered?.displayName ?? null;
  }
  get photoURL(): string | null {
    return this.user?.photoURL ?? this.remembered?.photoURL ?? null;
  }

  get profileStatus(): ProfileStatus {
    if (this.status === 'signedOut') return 'loading';
    if (this.status === 'loading' && !this.remembered) return 'loading';
    if (!this.profileLoaded) return 'loading';
    if (!this.profile) return 'missing';
    if (this.welcomePending) return 'new';
    return 'ready';
  }

  private started = false;
  private offProfile: (() => void) | null = null;
  private offTrack: (() => void) | null = null;
  private fbUser: FbUser | null = null;

  /** Called once by the root layout. */
  start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.welcomePending = storage('session')?.getItem(WELCOME_KEY) === '1';

    // §T — synchronous, before anything is awaited: this is the whole point.
    const remembered = readSession();
    if (remembered) {
      this.remembered = remembered;
      this.painted = true;
      this.watchProfile(remembered.uid);
      // The listeners this account ended its last visit on, opened now so the
      // components that are about to mount find them already holding data.
      prewarm(remembered.uid);
    }
    this.offTrack = trackPlace(() => this.uid);

    onAuthStateChanged(getAuthClient(), (u) => this.onUser(u));
  }

  private watchProfile(uid: string) {
    this.offProfile?.();
    this.offProfile = docStore<User>(paths.user(uid)).subscribe((s) => {
      // loading here means 'nothing to show yet' (§T): a cached profile
      // resolves on the first frame and the server's copy patches it.
      if (s.loading) return;
      this.profile = s.data;
      this.profileError = s.error;
      this.profileLoaded = true;
      if (s.data) this.remember(uid, s.data.theme);
    });
  }

  /** Mirror what a reload needs to paint. Never a token (lib/boot/session). */
  private remember(uid: string, theme?: Theme | null) {
    rememberSession({
      uid,
      displayName:
        this.profile?.name ?? this.user?.displayName ?? this.remembered?.displayName ?? null,
      photoURL: this.user?.photoURL ?? this.remembered?.photoURL ?? null,
      theme: theme ?? this.profile?.theme ?? this.remembered?.theme ?? 'system',
    });
  }

  private onUser(u: FbUser | null) {
    this.fbUser = u;
    if (!u) {
      // Auth has spoken: whatever we were drawing from memory is not ours.
      this.offProfile?.();
      this.offProfile = null;
      this.profile = null;
      this.profileLoaded = false;
      this.profileError = null;
      this.remembered = null;
      this.painted = false;
      forgetSession();
      stopPrewarm();
      this.user = null;
      this.status = 'signedOut';
      registry.closeAll();
      return;
    }
    // A remembered session that turns out to be someone else's: drop every
    // listener it opened before the new principal's queries start.
    const wrongPerson = this.remembered && this.remembered.uid !== u.uid;
    if (wrongPerson) {
      this.painted = false;
      stopPrewarm();
      registry.closeAll();
      this.offProfile?.();
      this.offProfile = null;
      this.profile = null;
      this.profileLoaded = false;
    }
    this.remembered = null;
    this.profileError = null;
    this.user = {
      uid: u.uid,
      email: u.email,
      emailVerified: u.emailVerified,
      displayName: u.displayName,
      photoURL: u.photoURL,
    };
    this.status = 'signedIn';
    this.remember(u.uid);
    // Already watching this uid from the remembered boot? Keep that listener:
    // re-subscribing would throw the profile back to 'loading' for a frame.
    if (!this.offProfile) this.watchProfile(u.uid);
    prewarm(u.uid);
  }

  /**
   * Fresh ID token for /api calls (null when signed out). §T paints a
   * remembered session before Firebase has restored it, so a call made on
   * mount (the OAuth consent screen's) waits for that restore rather than
   * reading "no user" and failing as if signed out.
   */
  async idToken(forceRefresh = false): Promise<string | null> {
    if (!this.fbUser) await getAuthClient().authStateReady();
    const u = this.fbUser ?? getAuthClient().currentUser;
    return u ? u.getIdToken(forceRefresh) : null;
  }

  private afterSignIn(cred: UserCredential) {
    if (getAdditionalUserInfo(cred)?.isNewUser) {
      storage('session')?.setItem(WELCOME_KEY, '1');
      this.welcomePending = true;
    }
  }

  async signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    this.afterSignIn(await signInWithPopup(getAuthClient(), provider));
  }

  async signInWithMicrosoft() {
    this.afterSignIn(await signInWithPopup(getAuthClient(), new OAuthProvider('microsoft.com')));
  }

  /** Emails a sign-in link that returns to /login?next=… to finish. */
  async sendEmailLink(email: string, next = '/') {
    const url = new URL('/login', window.location.origin);
    url.searchParams.set('next', next);
    await sendSignInLinkToEmail(getAuthClient(), email, {
      url: url.toString(),
      handleCodeInApp: true,
    });
    storage('local')?.setItem(EMAIL_KEY, email);
  }

  /** Is this URL an email sign-in link? */
  isEmailLink(href = window.location.href): boolean {
    return isSignInWithEmailLink(getAuthClient(), href);
  }

  /**
   * Finish an email-link sign-in. Returns 'needEmail' when opened on another
   * device (the address must be typed again); pass it as `email`.
   */
  async completeEmailLink(
    href = window.location.href,
    email?: string,
  ): Promise<'ok' | 'needEmail'> {
    const addr = email ?? storage('local')?.getItem(EMAIL_KEY) ?? null;
    if (!addr) return 'needEmail';
    this.afterSignIn(await signInWithEmailLink(getAuthClient(), addr, href));
    storage('local')?.removeItem(EMAIL_KEY);
    return 'ok';
  }

  /** The Welcome screen calls this when the person is done. */
  finishWelcome() {
    storage('session')?.removeItem(WELCOME_KEY);
    this.welcomePending = false;
  }

  /**
   * §T — a shared device must not keep the previous account. Sign-out drops
   * the remembered session and the pointer AND Firestore's persistent cache,
   * so the documents themselves leave with them.
   */
  async signOut() {
    const uid = this.uid;
    storage('session')?.removeItem(WELCOME_KEY);
    this.welcomePending = false;
    stopPrewarm();
    forgetSession();
    forgetPointer(uid);
    forgetSentNotifications(); // the next account's inbox ids are not this one's
    await fbSignOut(getAuthClient()); // → onUser(null): closes every listener
    await clearPersistentCache();
  }

  /** Tests: undo start(). */
  _stop() {
    this.offTrack?.();
    this.offTrack = null;
    this.offProfile?.();
    this.offProfile = null;
    stopPrewarm();
    this.started = false;
  }
}

export const auth = new AuthState();
