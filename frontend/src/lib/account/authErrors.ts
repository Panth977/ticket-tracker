/** Firebase Auth error codes → something a person can act on. null = say nothing (they cancelled). */
export function authErrorMessage(e: unknown): string | null {
  const code = (e as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return null;
    case 'auth/popup-blocked':
      return 'The sign-in window was blocked — allow pop-ups for this site and try again.';
    case 'auth/account-exists-with-different-credential':
      return 'This email already signs in another way — use that method, or an email link.';
    case 'auth/invalid-email':
      return 'That email address doesn’t look right.';
    case 'auth/invalid-action-code':
    case 'auth/expired-action-code':
      return 'This sign-in link has expired or was already used — send yourself a new one.';
    case 'auth/network-request-failed':
      return 'Could not reach the sign-in service — check your connection.';
    case 'auth/too-many-requests':
      return 'Too many attempts — wait a minute and try again.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled.';
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'That password is not right.';
    case 'auth/requires-recent-login':
      return 'For your security, sign in again first.';
    case 'auth/email-already-in-use':
      return 'Another account already uses that address.';
    case 'auth/weak-password':
      return 'Use a longer password (at least 8 characters).';
    default:
      return e instanceof Error && e.message ? e.message : 'Something went wrong — try again.';
  }
}
