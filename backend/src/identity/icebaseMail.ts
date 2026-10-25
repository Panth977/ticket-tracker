/**
 * The IceBase server's auth emails (TM_PLATFORM=icebase): it makes the sign-in, password-reset,
 * verify and change-e-mail links, and index.ts's `sendAuthEmail` export mails them — with the
 * same words and the same mailer (ports().email) as the VM's own sign-in.
 */
import { ports } from '../adapters/index.js';
import { appName } from '../runtime/brand.js';

export interface AuthEmail {
  kind: 'signIn' | 'resetPassword' | 'verifyEmail' | 'verifyAndChangeEmail' | string;
  to: string;
  link: string;
}

export async function sendAuthEmail(m: AuthEmail): Promise<void> {
  const name = appName();
  const mail =
    m.kind === 'signIn'
      ? { subject: `Sign in to ${name}`, text: `Open this link to sign in (it works once, for one hour):\n\n${m.link}\n\nIf you did not ask for it, ignore this mail.`, tag: 'signin-link' }
      : m.kind === 'verifyAndChangeEmail'
        ? { subject: 'Confirm your new e-mail address', text: `Open this link to make this your ${name} address (it works once, for one hour):\n\n${m.link}\n`, tag: 'email-change' }
        : m.kind === 'resetPassword'
          ? { subject: `Reset your ${name} password`, text: `Open this link to choose a new password (it works once, for one hour):\n\n${m.link}\n\nIf you did not ask for it, ignore this mail.`, tag: 'password-reset' }
          : { subject: `Confirm your ${name} e-mail address`, text: `Open this link to confirm this address:\n\n${m.link}\n`, tag: 'verify-email' };
  await ports().email.send({ to: m.to.toLowerCase(), ...mail });
}
