# Repository Guidelines

`@barsuk/game-runtime` — headless logic shared by Barsuk Studio games. Plain ES
modules, no build step, no runtime dependencies, no dev dependencies. This file
is the contract for every agent and contributor working here.

The games are the source, this repo is the destination: logic arrives here by
extraction from a game that already ships it, never by being invented here.

## Hard rules

1. **Headless.** No SDK, Capacitor, portal or framework import. No implicit
   `window`, `document`, `localStorage`, `fetch`, `Date.now` or `setTimeout`.
   Everything environmental arrives through parameters, and a missing dependency
   throws at construction rather than being defaulted.
2. **Game-agnostic.** No product or ad ids, no reward amounts, no economy, no UI,
   no translations, no storage keys. If a module needs to know one, it belongs in
   the game.
3. **One module, one subpath export.** Add it to `exports` in `package.json`;
   there is no root export and no barrel file, so a consumer can only import what
   it names.
4. **Every module ships its own tests** in `test/<module>.test.js`, on
   `node:test`, with no dependencies.
5. **Fix in the game first.** A bug found during extraction is fixed and
   committed in the game it came from, then extracted — never moved and fixed
   twice.
6. **Evidence discipline.** Never write "verified on device" in code, comments,
   tests or commit messages. Device behaviour is verified by Oleg on real
   hardware and recorded in the consuming game's `PROJECT_STATUS.md`. Describe
   what a test pins, and where a store behaviour claim comes from (SDK source,
   plugin source, a game's documented incident).

## Commands

```bash
npm test              # node --test autodiscovery, Node >= 20
npm pack --dry-run    # what a consumer actually gets
```

Node 20 is the floor declared in `engines`, so keep the test script on
autodiscovery: a quoted glob positional argument only works from Node 22 on.
Verify against both Node 20 and the current release before reporting a change.

## Consumption

Games pin an exact commit as a tarball URL:

```json
"@barsuk/game-runtime": "https://github.com/BarsukStudio/game-runtime/archive/<sha>.tar.gz"
```

`github:owner/repo#sha` resolves to `git+ssh://` and fails without an SSH key.

Nothing is published to npm (`private: true`) and no version is tagged yet. Do
not publish, do not tag, and do not pick a licence without asking — both are
release decisions, not implementation details.

## Style

ES modules, semicolons, single quotes, trailing commas in multiline structures,
two-space indentation. `camelCase` for functions and variables,
`UPPER_SNAKE_CASE` for constants. Code, names and comments in English. JSDoc on
every exported function and on the options and return shapes.

Comments explain *why* a branch exists — store quirks, race windows, ordering
constraints. A module extracted from a game keeps the reasoning it arrived with;
drop only what is specific to that one game.

## Commits

Short, capitalized, imperative summaries. One coherent change per commit. Commit
and push only when asked. State in the message which game the logic came from
when it is an extraction.
