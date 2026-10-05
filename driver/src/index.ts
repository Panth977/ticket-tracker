/**
 * The ES module entry (driver.mjs):
 *
 *   import db from 'https://…/backend-driver/v1/driver.mjs';
 *   import { BackendDriver } from 'https://…/backend-driver/v1/driver.mjs';
 *
 * ONE driver per window: the script tag and the module may both be on a page
 * (a template's index.html has the tag; a component imports the module), and
 * two drivers would mean two handshakes and two sets of listeners.
 */
import type { BackendDriver as BackendDriverApi } from './api.js';
import { createDriver } from './driver.js';
import type { WindowLike } from './transport.js';

type Holder = { BackendDriver?: BackendDriverApi };
const win = typeof window === 'undefined' ? undefined : (window as unknown as WindowLike & Holder);

export const BackendDriver: BackendDriverApi = win?.BackendDriver ?? createDriver(win);
if (win) win.BackendDriver = BackendDriver;

export default BackendDriver;
