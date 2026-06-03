# Contributing / development

These steps put the plugin into a real Obsidian vault so you can run it as you'd
run any community plugin — but rebuild it from source as you change the code.
For user-facing documentation, see [README.md](README.md).

## Prerequisites

- **Node 18+** (the build target is ES2020).
- **Obsidian 1.6+** desktop. (Mobile testing works too — see below.)
- A vault you don't mind using as a sandbox. **Do not use your real vault** until
  you've smoke-tested at least one board.

## 1. Clone and install

```bash
git clone <this-repo> kanban-pro
cd kanban-pro
npm install
```

## 2. Wire the plugin folder into a vault

Obsidian discovers plugins via `<vault>/.obsidian/plugins/<plugin-id>/`. Create
that folder and link in the three required files:

```bash
# pick a vault — create a fresh one in Obsidian first if you don't have a sandbox
VAULT=~/Documents/ObsidianSandbox
PLUGIN_DIR="$VAULT/.obsidian/plugins/kanban-pro-boards"

mkdir -p "$PLUGIN_DIR"

# Symlink the live build outputs into the vault so esbuild --watch updates
# the running plugin without an extra copy step.
ln -sf "$PWD/manifest.json" "$PLUGIN_DIR/manifest.json"
ln -sf "$PWD/styles.css"    "$PLUGIN_DIR/styles.css"
ln -sf "$PWD/main.js"       "$PLUGIN_DIR/main.js"   # will exist after the first build
```

> If you can't use symlinks (e.g. iCloud-backed vaults sometimes refuse), `cp` the
> three files instead. You'll need to re-copy after each rebuild.

## 3. First build

```bash
npm run build       # full production build — emits main.js
```

## 4. Dev loop with watch

```bash
npm run dev         # esbuild watch mode — rebuilds main.js on every save
```

Leave this running. Each rebuild emits a fresh `main.js`. You still have to
**reload the plugin in Obsidian** for the change to take effect:

- Open Obsidian → **Settings → Community plugins**.
- Find **Kanban for Professionals** and toggle it off, then back on. (Or use the
  *Hot reload* community plugin to skip the toggle — Obsidian's plugin sandbox
  doesn't auto-restart on file change.)
- Open the developer console with `Cmd/Ctrl+Shift+I` to see logs prefixed
  `[Kanban Pro]`.

## 5. Make your first board

Enable the plugin in Obsidian's settings if it isn't already. Then:

1. Click the **Kanban** ribbon icon, *or* run **Kanban for Professionals: Create
   new board** from the command palette.
2. Obsidian opens a file with `kanban-plugin: board` frontmatter and three empty
   lanes.
3. Try the flows — drag, inline edit, open the detail panel, switch between
   Board / Table / List, etc.

## 6. Open an existing kanban-format board

Any `.md` file whose frontmatter contains `kanban-plugin: board` is routed into
`KanbanView`. To smoke-test the migration path:

- Copy a board from an existing `obsidian-kanban` install into the sandbox vault.
- Open it. You should see a board, *not* the raw markdown.
- Make one small change (move a card). Save. Re-open the file as text
  (right-click → *Open in default app*) and confirm the on-disk format is
  preserved byte-for-byte on every card you didn't touch.

The **Kanban for Professionals: Validate board** command runs the same parser as
the standalone validator (`scripts/validate.mjs`) against the current file and
reports any round-trip byte-diff.

## 7. Mobile

```bash
npm run build
```

Copy the three files (`manifest.json`, `main.js`, `styles.css`) into your
Obsidian Sync'd vault's `.obsidian/plugins/kanban-pro-boards/`. Open Obsidian on
iOS / Android and enable the plugin from Settings. (Mobile doesn't honour
symlinks — you have to copy.)

Mobile-specific things to look for:

- A card press-and-hold for 200ms initiates a drag (`TouchSensor`).
- 350ms long-press opens the `DetailPanel` instead.
- `body.is-mobile` activates `src/styles/mobile.css` overrides.

---

## Test commands

| Command | What it runs |
|---|---|
| `npm test` | All vitest suites once. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:parser:property` | The fast-check round-trip property test on the parser. CI gate. |
| `npm run test:edit-loss` | The edit-loss state-machine fuzzer (10,000 generated traces). |
| `npm run test:lifecycle` | Lifecycle leak checks against the obsidian mock. |
| `npm run test:license` | Ed25519 verify + FSM race tests. |
| `npm run typecheck` | `tsc -noEmit` over `src/`. |
| `npm run bench` | Perf benchmark vs `scripts/bench-budgets.json`. |
| `node scripts/bundleSize.mjs` | Gzip `main.js` and fail if over the bundle-size budget. |
| `node scripts/validate.mjs <board.md>` | Standalone parser validator — used by the **Validate board** command. |

---

## Pro features and licensing

Pro features are gated at runtime through `useProGate()`. Free-tier users see a
paywall card in place of a Pro feature; Pro is unlocked by an Ed25519-signed
license token verified entirely offline against the public keys in
`src/pro/license/keys.ts`.

The token-issuing license service is a separate, self-hosted backend and is
**not** part of this repository. The plugin ships only the client side: signature
verification (`src/pro/license/verify.ts`), the activation/revalidation state
machine (`src/pro/license/state.ts`), and the thin HTTP client
(`src/pro/license/remote.ts`). Everything works offline; the network is only
touched to exchange a purchased key for a signed token, to re-validate
periodically, and to pick up revocations.

---

## Project layout

```
src/
  main.ts                      plugin entry
  view/                        TextFileView, EmbedProcessor, read-only banner
  ui/                          BoardRoot, Column, Card, DnDProvider, DetailPanel, …
  core/
    model.ts                   shared types (Board / Lane / Card / FileTrivia …)
    store.ts                   per-leaf Zustand factory, immer producers, gesture API
    saveQueue.ts               debounce + coalesce + never-silence
    undo.ts                    gesture-scoped undo
    parser/                    remark + sentinels + settings block, source-position
  pro/
    license/                   Ed25519 verify + remote client + FSM with idle-boundary
    recurrence/                rrule + chrono-node
    savedViews/                JSON-backed named filters
    tracking/                  time tracking
    integrations/              github (stub), calendar (.ics export)
  settings/
  shared/
  styles/                      tokens.css + per-feature CSS
docs/
  inline-meta.ebnf             EBNF for the inline-meta vocabulary
scripts/
  validate.mjs                 parser round-trip validator
  bench.mjs                    perf harness
  bundleSize.mjs               bundle-size CI gate
  checkProductionKeys.mjs      release gate: no placeholder license keys
.github/workflows/ci.yml       typecheck / lint / test / build / bundle gate
```
