# @barsuk/game-runtime

Headless runtime logic shared by Barsuk Studio games (Muscle Clicker, Ball
Launch, …). Plain ES modules, no build step, no dependencies.

**Status: released — `v0.1.0` (`2fa65e8`), 2026-08-14.** The tag marks the first
runtime proven by two consumers: Muscle Clicker and Ball Launch both resolve that
commit, pass their purchase suites from clean installs, and Ball's Remove Ads and
Restore are device-verified on Android and iOS.

Nothing is published to npm, and consumers stay pinned to the exact commit SHA
rather than the tag: the tarball URL is what carries an integrity hash into the
lockfile. The tag names a proven commit; it is not an install target.

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

### `@barsuk/game-runtime/purchase-delivery`

The order in which one approved-and-verified transaction becomes a delivered
product, and the two rules that order exists to enforce: a transaction is
finished only after its product was granted or an earlier delivery of it was
confirmed, and a transaction whose delivery could not be completed is left
unfinished so the store replays it.

```js
import { deliverPurchaseTransaction } from '@barsuk/game-runtime/purchase-delivery';

const settled = await deliverPurchaseTransaction(transaction, {
  // All four are required; a missing one throws before the transaction is read.
  isDelivered: (transactionId) => ledger.includes(transactionId),
  grant: (productId, transactionId) => game.grant(productId, transactionId),
  mirror: (transactionId) => ledger.mirror(transactionId),
  finish: (approved) => coordinator.finish(approved),
  // Both optional.
  onDelivered: ({ transactionId, productId }) => session?.noteDelivered({ transactionId, productId }),
  onWarn: (message, detail) => console.warn(message, detail),
});
```

- `deliverPurchaseTransaction(transaction, handlers)` → `Promise<boolean>`. True
  when the transaction is settled and its product accounted for; false when it
  was deliberately left recoverable — pending at the store, carrying no product
  or transaction id, unable to be finished, or naming a product the game does not
  sell. Every one of those is a decision to let the store replay it, not an error
  swallowed. Throws when `isDelivered`, `grant`, `mirror` or `finish` is missing,
  before anything is read or granted; a throw from `grant` or `finish` propagates,
  because by then the product may already be granted.
- `getTransactionProductId(transaction)` and `getTransactionDeliveryId(transaction)`
  → the plugin's contract fields, trimmed, or `''`. One reading of transaction
  identity, so a consumer does not grow a second.

`grant` must persist the product and the transaction id in a single write: the
ledger lookup is what stops a replay from granting twice, and a grant recorded
without its id cannot be found again. The module reads an SDK-shaped transaction
(`products[0].id`, `transactionId`, `isPending`, `finish`) — cordova-plugin-purchase's
shape. Headless it is; store-agnostic it does not claim to be.

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

The order around it is `purchase-delivery` above: grant the product, write the
delivery ledger, and only then finish the transaction.

## Development

```bash
npm test    # node --test autodiscovery, no dependencies
npm pack --dry-run
```

Node 20 is the floor (`engines`), so the test script uses plain autodiscovery: a
quoted glob argument only works from Node 22 on. Agents working in this repo
read `AGENTS.md` first.
