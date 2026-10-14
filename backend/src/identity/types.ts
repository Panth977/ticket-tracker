/**
 * THE IDENTITY PORT — who a caller is, and the accounts behind it.
 *
 * Shaped like the Firebase Admin Auth API (the subset the code uses), for
 * the same reason the database port is Firestore-shaped: the backend was
 * written against it. Two adapters:
 *
 *   firebase  Firebase Auth itself (getAuth()), no wrapper
 *   local     accounts in the database port, HS256 ID tokens signed with
 *             the server key, refresh sessions, password / e-mail link /
 *             OpenID Connect sign-in (identity/local)
 *
 * Code above the port gets it with identity() from 'src/identity/index.js',
 * never auth() from firebase-admin.
 */

export interface DecodedIdToken {
  uid: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  /** Seconds. */
  iat: number;
  exp: number;
  auth_time: number;
  firebase: { sign_in_provider: string; [k: string]: unknown };
  [claim: string]: unknown;
}

export interface UserInfo {
  providerId: string;
  uid: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
}

export interface UserMetadata {
  creationTime: string;
  /** '' when the account never signed in. */
  lastSignInTime: string;
}

export interface UserRecord {
  uid: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  photoURL?: string;
  disabled: boolean;
  metadata: UserMetadata;
  providerData: UserInfo[];
  tokensValidAfterTime?: string;
  customClaims?: Record<string, unknown>;
}

export interface CreateRequest {
  uid?: string;
  email?: string;
  emailVerified?: boolean;
  password?: string;
  displayName?: string | null;
  photoURL?: string | null;
  disabled?: boolean;
}
export type UpdateRequest = Omit<CreateRequest, 'uid'>;

export type UserIdentifier = { uid: string } | { email: string };

export interface GetUsersResult {
  users: UserRecord[];
  notFound: UserIdentifier[];
}

export interface Identity {
  /** Verify an ID token; with checkRevoked, also refuse revoked / disabled accounts. */
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
  getUser(uid: string): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord>;
  getUsers(identifiers: UserIdentifier[]): Promise<GetUsersResult>;
  createUser(properties: CreateRequest): Promise<UserRecord>;
  updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
  deleteUser(uid: string): Promise<void>;
  /** Every session and ID token issued before now stops working. */
  revokeRefreshTokens(uid: string): Promise<void>;
  /** A token a client exchanges for a session as `uid` (agents' live stream). */
  createCustomToken(uid: string, developerClaims?: Record<string, unknown>): Promise<string>;
}

/** An error shaped like firebase-admin's (callers test `code === 'auth/user-not-found'`). */
export class IdentityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}
