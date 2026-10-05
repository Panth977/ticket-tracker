// Types in an editor or a TypeScript project: `npm run types` downloads
// src/backend-driver.d.ts, which declares window.BackendDriver.
const db = window.BackendDriver;
const app = document.getElementById('app');

await db.ready;

// ROUTING: use the hash ('#/settings'), never the History API. The page lives
// at an opaque, changing URL inside a sandboxed frame; location.hash is yours.
const route = () => location.hash.replace(/^#/, '') || '/';

let notes = [];

function render() {
  app.replaceChildren();
  const h = document.createElement('h1');
  h.textContent = `${db.artifact.name} — ${route()}`;
  const who = document.createElement('p');
  who.textContent = `${db.me.name ?? db.me.email} (${db.me.role}${db.me.readOnly ? ', read-only' : ''})${db.mock ? ' · MOCK backend' : ''}`;
  const list = document.createElement('ul');
  for (const n of notes) {
    const li = document.createElement('li');
    li.textContent = n.data.text;
    list.append(li);
  }
  const add = document.createElement('button');
  add.textContent = 'Add a note';
  add.hidden = db.me.readOnly;
  add.onclick = () =>
    db.firestore.add('/notes', { text: `Note ${notes.length + 1}`, at: db.serverTime }).catch((e) => alert(e.message));
  app.append(h, who, list, add);
}

// Live: now, and on every change by anyone this artifact is shared with.
db.firestore.onList('/notes', { orderBy: ['at', 'asc'] }, (docs) => {
  notes = docs;
  render();
});
db.on('readonly', render);
addEventListener('hashchange', render);
render();
