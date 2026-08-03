// Minimal shoal integration: a todo list that syncs across devices.
//
// The pattern every app follows:
//   1. write locally first (Dexie), so the app never waits on the network
//   2. after every write, hand the full record state to sync.record()
//   3. apply() routes incoming remote records back into the same tables
//   4. sync.start() keeps a poke stream open and pulls whenever ops land
import Dexie from "dexie";
import { ShoalSync, SyncKeys } from "shoal-client";
import { DexieShoalStorage } from "shoal-client/dexie";

const db = new Dexie("shoal-todo-example");
db.version(1).stores({
  todos: "id, createdAt",
  _shoal_outbox: "opId, createdAt",
  _shoal_meta: "recordId",
  _shoal_kv: "key",
});

const $ = (id) => document.getElementById(id);
const URL_KEY = "shoal-example-url";
const MNEMONIC_KEY = "shoal-example-mnemonic";
const NODE_KEY = "shoal-example-node-id";

let sync = null;

function nodeId() {
  let id = Number(localStorage.getItem(NODE_KEY));
  if (!Number.isInteger(id) || id === 0) {
    id = crypto.getRandomValues(new Uint32Array(1))[0];
    localStorage.setItem(NODE_KEY, String(id));
  }
  return id;
}

// ---- remote -> local ------------------------------------------------------
// Called only when the incoming op wins last-writer-wins, never for this
// device's own echoed writes.
async function apply(recordId, body) {
  const [kind, id] = recordId.split("/");
  if (kind !== "todo") return;
  if (body.deleted) await db.todos.delete(id);
  else await db.todos.put({ ...body, id });
  await render();
}

// ---- local -> remote ------------------------------------------------------
async function putTodo(todo) {
  await db.todos.put(todo);
  await sync?.record(`todo/${todo.id}`, todo);
  await render();
}

async function deleteTodo(id) {
  await db.todos.delete(id);
  await sync?.record(`todo/${id}`, { deleted: true });
  await render();
}

// ---- sync lifecycle -------------------------------------------------------
function connect(serverUrl, mnemonic) {
  sync?.stop();
  sync = new ShoalSync({
    serverUrl,
    mnemonic,
    collection: "todo-example",
    nodeId: nodeId(),
    storage: new DexieShoalStorage(db, "todo-example"),
    apply,
    onError: (e) => setStatus(`sync error, retrying: ${e}`),
  });
  sync.start(); // initial sync, then a pull on every server poke
  setStatus(`live · user ${sync.publicKeyB64.slice(0, 12)}…`);
}

async function enable() {
  const serverUrl = $("server").value.trim().replace(/\/$/, "");
  const phrase = $("phrase").value.trim() || SyncKeys.generateMnemonic();
  SyncKeys.fromMnemonic(phrase); // validate before persisting
  localStorage.setItem(URL_KEY, serverUrl);
  localStorage.setItem(MNEMONIC_KEY, phrase);
  $("phrase").value = phrase; // show a generated phrase so it can be written down
  connect(serverUrl, phrase);
  // First enable on a device that already has data: snapshot it all into the
  // outbox so the other devices receive it.
  for (const todo of await db.todos.toArray()) {
    await sync.record(`todo/${todo.id}`, todo);
  }
}

function setStatus(text) {
  $("status").textContent = text;
}

// ---- ui -------------------------------------------------------------------
async function render() {
  const todos = await db.todos.orderBy("createdAt").toArray();
  const list = $("list");
  list.replaceChildren(
    ...todos.map((todo) => {
      const li = document.createElement("li");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = todo.done;
      box.onchange = () => putTodo({ ...todo, done: box.checked });
      const span = document.createElement("span");
      span.textContent = todo.text;
      if (todo.done) span.className = "done";
      const del = document.createElement("button");
      del.textContent = "x";
      del.onclick = () => deleteTodo(todo.id);
      li.append(box, span, del);
      return li;
    }),
  );
}

$("add").onsubmit = (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = "";
  putTodo({ id: crypto.randomUUID(), text, done: false, createdAt: Date.now() });
};

$("enable").onclick = () => enable().catch((e) => setStatus(String(e)));

// Reconnect automatically when the page reloads with saved settings.
const savedUrl = localStorage.getItem(URL_KEY);
const savedPhrase = localStorage.getItem(MNEMONIC_KEY);
if (savedUrl && savedPhrase) {
  $("server").value = savedUrl;
  $("phrase").value = savedPhrase;
  connect(savedUrl, savedPhrase);
}
render();
