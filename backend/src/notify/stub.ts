/**
 * No-op notify(), matching the shared NotifyFn signature. Commands import
 * `notify` from './index.js' (never from this file); the notify step replaces
 * the implementation behind that index, not the import path.
 */
import type { NotifyFn } from '@tm/shared';

export const notifyStub: NotifyFn = async () => {};
