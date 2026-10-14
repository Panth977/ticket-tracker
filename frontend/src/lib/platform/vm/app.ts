/**
 * `firebase/app` FOR THE VM BUILD — there is no Firebase project on a VM; the
 * "app" is only the handle the other shims are asked for.
 */
export interface FirebaseApp {
  name: string;
  options: Record<string, unknown>;
}
let app: FirebaseApp | undefined;
export function initializeApp(options: Record<string, unknown> = {}, name = '[DEFAULT]'): FirebaseApp {
  app ??= { name, options };
  return app;
}
export const getApps = (): FirebaseApp[] => (app ? [app] : []);
export const getApp = (): FirebaseApp => app ?? initializeApp();
export const deleteApp = async (_a: FirebaseApp) => {
  app = undefined;
};
export const registerVersion = (..._a: unknown[]) => {};
export class FirebaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FirebaseError';
  }
}
