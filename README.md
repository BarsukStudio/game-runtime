# @barsuk/game-runtime

Headless runtime logic shared by Barsuk Studio games (Muscle Clicker, Ball
Launch, …). Plain ES modules, no build step, no dependencies.

**Status: unreleased.** Nothing is published to npm and no version is tagged yet.
Consumers pin an exact commit SHA until `v0.1.0` exists.

## Rules

These are the rules that decide what may live here at all:

- No game ids, no economy, no reward amounts, no product or ad ids, no UI.
- No SDK, Capacitor, portal or framework imports.
- No implicit `window`, `document`, `localStorage` or `fetch`. Environment
  arrives through parameters.
- Timers are injected (`setTimeoutFn` / `clearTimeoutFn`) and required — no
  module here ever reaches for an ambient `setTimeout`.
- Every module ships with its own tests and its own subpath export.

What never leaves a game: reward amounts, product and ad ids, shop UI, rewarded
placements, interstitial policy, the back ladder, saves, translations.

## Install

Pin an exact commit as a tarball URL — the same form the studio already uses for
`capacitor-plugin-yandex-ads`. The `github:owner/repo#sha` shorthand is avoided
on purpose: it is recorded in the lockfile as `git+ssh://`, so every install
needs git and depends on whatever ssh-to-https fallback that machine happens to
have, and npm skips the integrity check for a git dependency. The tarball is a
plain HTTPS artifact whose integrity hash is pinned in the lockfile.

```json
{
  "dependencies": {
    "@barsuk/game-runtime": "https://github.com/BarsukStudio/game-runtime/archive/<exact-sha>.tar.gz"
  }
}
```

## Modules

### `@barsuk/game-runtime/purchase-finish`

Confirmed finishing of store transactions for cordova-plugin-purchase style
stores. `transaction.finish()` resolves when the call has been *dispatched*, not
when the store has *settled* the transaction; delivery that trusts that promise
reports success while the purchase is still open.

```js
import {
  createPurchaseFinishCoordinator,
  isSettledStoreTransaction,
} from '@barsuk/game-runtime/purchase-finish';

const coordinator = createPurchaseFinishCoordinator({
  store: CdvPurchase.store,
  finishedState: CdvPurchase.TransactionState.FINISHED,
  // Timers are required; timeoutMs is optional (30 s default).
  setTimeoutFn: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeoutFn: (handle) => window.clearTimeout(handle),
});

// Skip the coordinator when the store has already settled the transaction.
if (!isSettledStoreTransaction(transaction, { finishedState, consumable })) {
  await coordinator.finish(transaction);
}
```

- `createPurchaseFinishCoordinator(options)` → `{ finish, dispose, pendingCount }`.
  Throws at construction when the store cannot be subscribed to or when either
  timer is missing.
  `finish(transaction)` resolves only after the store emits its `finished` event
  for that transaction, rejects on a store error, and rejects after `timeoutMs`
  (default 30 s) if no confirmation arrives. Concurrent calls for the same
  `platform:transactionId` share one pending confirmation. `dispose()`
  unsubscribes and rejects everything still pending.
- `isSettledStoreTransaction(transaction, { finishedState, consumable })` — true
  when the store itself already settled the transaction. A non-consumable counts
  as settled once acknowledged (Google Play keeps an acknowledged one in
  `APPROVED` forever and short-circuits `finish()`), a consumable only once
  consumed — acknowledgement is not consumption, and skipping `finish()` there
  would leave the product unbuyable and eventually refunded.

The order around it belongs to the game: grant the product, write the delivery
ledger, and only then finish the transaction.

## Development

```bash
npm test    # node --test autodiscovery, no dependencies
npm pack --dry-run
```

Node 20 is the floor (`engines`), so the test script uses plain autodiscovery: a
quoted glob argument only works from Node 22 on. Agents working in this repo
read `AGENTS.md` first.
