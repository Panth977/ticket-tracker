/**
 * whatsappLink — link a WhatsApp number by OTP (app/backend.json services.whatsappLink).
 *
 *   send:   a 6-digit code via the WhatsApp 'otp' template; only its HMAC is
 *           stored, for 10 minutes; at most 5 sends per hour
 *   verify: 5 attempts; then users/{uid}.whatsapp = { number, verifiedAt, optIn: true }
 *           and whatsappSessions/{number} → this person (a number is one
 *           person's: whoever had it before loses the link)
 *
 * OPT-IN IS EXPLICIT AND RECORDED. Meta requires it before any
 * business-initiated template, and it is the only defence when a number is
 * reported. The pending code lives in _whatsappOtp/{uid} — server-only, like
 * every '_' collection (rules deny it).
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { errors, paths, type User, type WhatsappSession } from '@tm/shared';
import { isNotConfigured, ports, whatsappConfigured } from '../adapters/index.js';
import { hmac } from '../notify/config.js';
import { db } from '../runtime/firebase.js';
import { runTx, txGet, typedDoc } from '../runtime/index.js';
import { defineCommand } from './_registry.js';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS_PER_HOUR = 5;
const HOUR = 60 * 60 * 1000;

export const otpPath = (uid: string) => `_whatsappOtp/${uid}`;

interface OtpDoc {
  number: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  /** Send times in the last hour (rate limit). */
  sends: number[];
}

const codeHash = (uid: string, number: string, code: string) =>
  hmac(`otp:${uid}:${number}:${code}`);

export default defineCommand('whatsappLink', async (ctx, input) => {
  const userRef = typedDoc('users', paths.user(ctx.actor));
  const user = (await userRef.get()).data();
  if (!user || user.deletedAt) throw errors.forbidden('No profile to link a number to');
  const otpRef = db().doc(otpPath(ctx.actor));

  if (input.step === 'send') {
    // Production without Meta credentials: the UI greys WhatsApp out; say so here too.
    if (!whatsappConfigured())
      throw errors.unavailable('WhatsApp is not available on this server yet');
    const prev = (await otpRef.get()).data() as OtpDoc | undefined;
    const sends = (prev?.sends ?? []).filter((t) => ctx.now - t < HOUR);
    if (sends.length >= OTP_MAX_SENDS_PER_HOUR) {
      const retryAfter = Math.ceil((sends[0]! + HOUR - ctx.now) / 1000);
      throw errors.rate_limited('Too many codes — try again later', { retryAfter });
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // Store first: a code that was sent must be verifiable.
    const doc: OtpDoc = {
      number: input.number,
      codeHash: codeHash(ctx.actor, input.number, code),
      expiresAt: ctx.now + OTP_TTL_MS,
      attempts: 0,
      sends: [...sends, ctx.now],
    };
    await otpRef.set(doc);
    try {
      await ports().whatsapp.sendTemplate(input.number, 'otp', [code]);
    } catch (e) {
      if (isNotConfigured(e)) {
        throw errors.unavailable('WhatsApp is not available on this server yet');
      }
      console.error('[whatsappLink] otp send failed', e);
      throw errors.unavailable(
        'Could not send the code on WhatsApp — check the number and try again',
      );
    }
    return { ok: true as const };
  }

  // verify
  const outcome = await runTx(async (tx) => {
    const snap = await tx.get(otpRef);
    const otp = snap.exists ? (snap.data() as OtpDoc) : undefined;
    if (!otp) return { err: errors.gone('No code is pending — send a new one') };
    if (otp.expiresAt <= ctx.now) return { err: errors.gone('The code expired — send a new one') };
    if (otp.attempts >= OTP_MAX_ATTEMPTS)
      return { err: errors.gone('Too many wrong codes — send a new one') };

    const want = Buffer.from(otp.codeHash);
    const got = Buffer.from(codeHash(ctx.actor, otp.number, input.code));
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      tx.update(otpRef, { attempts: otp.attempts + 1 });
      return {
        err: errors.invalid('Wrong code', { attemptsLeft: OTP_MAX_ATTEMPTS - otp.attempts - 1 }),
      };
    }

    const sessionRef = typedDoc('whatsappSessions', paths.whatsappSession(otp.number));
    const session = await txGet(tx, sessionRef);
    const prevOwner =
      session && session.uid !== ctx.actor
        ? await txGet(tx, typedDoc('users', paths.user(session.uid)))
        : undefined;
    // Old number of this person: its session no longer points here.
    const oldNumber = user.whatsapp?.number !== otp.number ? user.whatsapp?.number : undefined;
    const oldSessionRef = oldNumber
      ? typedDoc('whatsappSessions', paths.whatsappSession(oldNumber))
      : undefined;
    const oldSession = oldSessionRef ? await txGet(tx, oldSessionRef) : undefined;

    const whatsapp: NonNullable<User['whatsapp']> = {
      number: otp.number,
      verifiedAt: ctx.now,
      optIn: true,
    };
    tx.update(typedDoc('users', paths.user(ctx.actor)), { whatsapp });
    const fresh: WhatsappSession = {
      uid: ctx.actor,
      lastInboundAt: session?.uid === ctx.actor ? session.lastInboundAt : null,
      contextTicketId: null,
      contextExpiresAt: ctx.now,
    };
    tx.set(sessionRef, fresh);
    if (session && prevOwner && prevOwner.whatsapp?.number === otp.number) {
      tx.update(typedDoc('users', paths.user(session.uid)), { whatsapp: null });
    }
    if (oldSessionRef && oldSession?.uid === ctx.actor) tx.delete(oldSessionRef);
    tx.delete(otpRef);
    return { err: null };
  });
  if (outcome.err) throw outcome.err;
  return { ok: true as const };
});
