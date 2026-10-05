// Publish dist/ as a new build, with this folder as its source.
//
//   export TM_TOKEN='tm_live_…'          an account token with artifacts:write, or the token of an agent with `build` here
//   npm run publish:artifact              first time: creates the artifact and prints its id
//   TM_ARTIFACT=<id> npm run publish:artifact
import { createClient } from '@tm/sdk';

const tm = createClient({ token: process.env.TM_TOKEN, baseUrl: 'https://taskmanager-example.web.app' });

let id = process.env.TM_ARTIFACT;
if (!id) {
  const art = await tm.artifacts.create({ name: 'My artifact' });
  id = art.id;
  console.log(`created ${id} — set TM_ARTIFACT=${id} for the next publish`);
}

// './dist' is walked and zipped; './' goes up beside it as the source (without
// node_modules, .git, dist and .env files), so the next author can carry on.
const build = await tm.artifacts.publish(id, './dist', { source: './', message: process.argv[2] ?? 'publish' });
for (const w of build.warnings) console.warn(`warning: ${w}`);

const art = await tm.artifacts.get(id);
console.log(`build ${build.id} is live: ${build.files} files, ${build.bytes} bytes`);
console.log(`open   ${art.url}`);
