# todo example

The smallest complete shoal integration: a todo list in one HTML file and one
JS file. Local-first Dexie storage, every write mirrored to a shoal server as
an encrypted op, live cross-device sync over the poke stream.

The four-step pattern, marked in `app.js`:

1. Write locally first. The app never waits on the network.
2. After every write, hand the full record state to `sync.record()`.
   Deletes are `{ deleted: true }` tombstones.
3. `apply()` routes incoming remote records back into the same tables.
4. `sync.start()` holds a poke stream open and pulls whenever ops land.

## Run it

From the repository root:

```sh
pnpm install
pnpm build
npx esbuild examples/todo/app.js --bundle \
  --outfile=examples/todo/bundle.js \
  --alias:shoal-client=./dist/index.js \
  "--alias:shoal-client/dexie=./dist/dexie.js"
npx serve examples/todo
```

Point a [shoal server](https://github.com/emerson-d-lopes/shoal) anywhere
reachable, `cargo run --release` is enough locally.

Open the page in two different browsers (or one normal and one private
window, so they do not share IndexedDB). In the first: leave the phrase
empty and click "enable sync" to generate an identity. Copy the phrase it
shows into the second browser, enable, and the list appears. Edits on
either side show up on the other without a reload.

A real app stores the phrase more carefully than `localStorage` (see
[habit-tracker](https://github.com/emerson-d-lopes/habit-tracker) for the
same pattern behind a settings screen) and prompts the user to write it
down: the phrase is the identity and the encryption key, and there is no
recovery without it.
