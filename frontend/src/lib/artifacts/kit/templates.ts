/**
 * Starters for the Code tab: a kit artifact in plain TypeScript, React or Svelte.
 * Each one shows the parts that matter — the UI kit, the viewer, a live
 * collection of the artifact's own data, the boards it was granted.
 */
import type { SourceFiles } from './build';

export interface KitTemplate {
  id: string;
  label: string;
  description: string;
  files: SourceFiles;
}

const manifest = (name: string, deps: Record<string, string> = {}) =>
  JSON.stringify({ name, dependencies: deps, network: [] }, null, 2) + '\n';

const VANILLA = `import { host } from "@panth977/sandbox/artifact";
import { toast } from "@panth977/sandbox/ui";

const root = document.getElementById("root")!;
root.innerHTML = \`
  <main class="sbx-page sbx-stack">
    <div class="sbx-row sbx-row--between">
      <h1 style="margin:0">Notes</h1>
      <span class="sbx-badge sbx-badge--accent" id="who"></span>
    </div>
    <form class="sbx-row" id="add">
      <input class="sbx-input" name="text" placeholder="Write a note…" style="flex:1" required />
      <button class="sbx-btn sbx-btn--primary">Add</button>
    </form>
    <sbx-table id="notes" empty="No notes yet"></sbx-table>
  </main>\`;

const me = await host.me();
document.getElementById("who")!.textContent = me.name ?? me.email ?? "you";

const table = document.getElementById("notes") as any;
table.columns = [
  { key: "text", label: "Note" },
  { key: "by", label: "By" },
  { key: "at", label: "When", format: (v: Date | null) => (v ? new Date(v).toLocaleString() : "") },
];

document.getElementById("add")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const text = String(new FormData(form).get("text") ?? "").trim();
  if (!text) return;
  try {
    await host.db.add("/notes", { text, by: me.name ?? me.email, at: await host.db.serverTime() });
    form.reset();
  } catch (err: any) {
    toast(err.message, "error");
  }
});

// Live: every change to /notes, from anyone.
for await (const docs of host.db.watchList("/notes", { orderBy: ["at", "desc"], limit: 100 })) {
  table.rows = docs.map((d) => d.data);
}
`;

const REACT_INDEX = `import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
`;

const REACT_APP = `import { useEffect, useState } from "react";
import { host } from "@panth977/sandbox/artifact";

type Ticket = Awaited<ReturnType<typeof host.tickets.list>>[number];

export function App() {
  const [boards, setBoards] = useState<{ key: string; name: string }[]>([]);
  const [board, setBoard] = useState<string>();
  const [tickets, setTickets] = useState<Ticket[]>([]);

  useEffect(() => {
    host.tickets.boards().then((b) => {
      setBoards(b);
      setBoard(b[0]?.key);
    });
  }, []);

  useEffect(() => {
    if (!board) return;
    let stop = false;
    (async () => {
      for await (const list of host.tickets.watchList(board, { limit: 200 })) {
        if (stop) break;
        setTickets(list);
      }
    })();
    return () => void (stop = true);
  }, [board]);

  const byStage = Object.entries(
    tickets.reduce<Record<string, number>>((m, t) => ((m[t.stage.name] = (m[t.stage.name] ?? 0) + 1), m), {}),
  ).map(([stage, n]) => ({ stage, n }));

  if (!boards.length)
    return (
      <main className="sbx-page">
        <div className="sbx-empty">
          <strong>No boards granted</strong>
          Grant this artifact a board in Settings › General to see its tickets here.
        </div>
      </main>
    );

  return (
    <main className="sbx-page sbx-stack">
      <div className="sbx-row sbx-row--between">
        <h1 style={{ margin: 0 }}>Tickets by stage</h1>
        <sbx-select
          value={board}
          options={boards.map((b) => ({ label: b.name, value: b.key }))}
          onchange={(e: CustomEvent) => setBoard(e.detail.value)}
        />
      </div>
      <div className="sbx-grid">
        <div className="sbx-stat">
          <span className="sbx-stat__label">Open tickets</span>
          <span className="sbx-stat__value">{tickets.length}</span>
        </div>
      </div>
      <div className="sbx-card sbx-card--pad">
        <sbx-chart type="bar" data={byStage} x="stage" y="n" height={240} />
      </div>
    </main>
  );
}
`;

const SVELTE_INDEX = `import { mount } from "svelte";
import App from "./App.svelte";

mount(App, { target: document.getElementById("root")! });
`;

const SVELTE_APP = `<script lang="ts">
  import { host } from "@panth977/sandbox/artifact";
  import { stream } from "@panth977/sandbox/stores";

  let count = $state(0);
  // Live value in this artifact's Realtime Database, shared by everyone who opens it.
  const clicks = stream(() => host.rtdb.watch("/clicks"));

  async function click() {
    count++;
    await host.rtdb.set("/clicks", Number($clicks.latest ?? 0) + 1);
  }
</script>

<main class="sbx-page sbx-stack">
  <h1>Clicks</h1>
  <p class="sbx-muted">You clicked {count} times. Everyone: {$clicks.latest ?? 0}.</p>
  <div><button class="sbx-btn sbx-btn--primary" onclick={click}>Click</button></div>
</main>
`;

export const KIT_TEMPLATES: readonly KitTemplate[] = [
  {
    id: 'vanilla',
    label: 'TypeScript',
    description: 'No framework: the UI kit and a live list of notes.',
    files: { '/manifest.json': manifest('Notes'), '/index.ts': VANILLA },
  },
  {
    id: 'react',
    label: 'React',
    description: 'React + TSX: tickets of a granted board, live, as a chart.',
    files: {
      '/manifest.json': manifest('Tickets by stage', { react: '19', 'react-dom': '19' }),
      '/index.tsx': REACT_INDEX,
      '/App.tsx': REACT_APP,
    },
  },
  {
    id: 'svelte',
    label: 'Svelte',
    description: 'Svelte 5: a shared live counter in the artifact’s RTDB.',
    files: {
      '/manifest.json': manifest('Clicks', { svelte: '5' }),
      '/index.ts': SVELTE_INDEX,
      '/App.svelte': SVELTE_APP,
    },
  },
];
