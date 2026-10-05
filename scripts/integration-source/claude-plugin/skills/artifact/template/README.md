# Artifact template (Vite)

A starting point for a TaskManager artifact built with Vite. Copy this folder, then:

```bash
npm install
npm run dev                    # http://localhost:5173 — the driver switches to its mock backend
npm run types                  # optional: src/backend-driver.d.ts, for editor types
export TM_TOKEN='tm_live_…'    # an account token with artifacts:write, or an agent's token (it needs `build`)
npm run publish:artifact       # vite build, then publish dist/ (creates the artifact the first time)
```

What is already right in here, and must stay right:

- `vite.config.js` sets `base: './'` — asset paths must be relative.
- `index.html` loads `{{url:driver.js}}` before the app module.
- `src/main.js` routes on `location.hash`, and keeps no state in `localStorage` (an artifact has none: use
  `db.kv`).

While developing, add `?role=viewer`, `?readonly=1` or `?mock=1` to the dev URL to be someone else. The mock
keeps its data in this browser's `localStorage`; nothing reaches TaskManager until you publish.
