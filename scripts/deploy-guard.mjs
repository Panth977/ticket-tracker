#!/usr/bin/env node
/**
 * predeploy guard in firebase.json (functions + hosting): the dev config
 * deploys the WRONG things — functions from backend/ (a pnpm workspace
 * package Cloud Build cannot install) and hosting rewrites to us-central1.
 * Production deploys go through `pnpm deploy:prod`, which uses the generated
 * firebase.deploy.json (no guard). Emulators never run predeploy hooks.
 */
console.error(
  '\n  ✖ Do not deploy with firebase.json — it is the emulator/dev config.\n' +
    '    Use:  pnpm deploy:prod            (everything)\n' +
    '          pnpm deploy:prod --only functions   (any firebase --only list)\n' +
    '    or:   node scripts/deploy-functions.mjs && firebase deploy --config firebase.deploy.json --project <id>\n',
);
process.exit(1);
