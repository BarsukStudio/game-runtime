// Extracted from Muscle Clicker's scripts/purchase-delivery-test.mjs. Muscle
// Clicker 2 carries the same module and the same suite byte for byte, so there
// was no merge to do and no canonical copy to choose between.
//
// The transaction shape below is cordova-plugin-purchase's — `products[0].id`,
// `transactionId`, `isPending`, `finish()` — read off the plugin's transaction
// type. What these cases pin is the order the module imposes on a transaction of
// that shape; which shapes a real store emits is the consuming game's evidence,
// not this suite's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  deliverPurchaseTransaction,
  getTransactionDeliveryId,
  getTransactionProductId,
} from '../src/purchase-delivery.js';

// A ledger-backed game, reduced to what the module is allowed to know: whether
// an id was already paid for, whether a grant succeeded, and when a transaction
// was finished. Every call is recorded, because the order is the contract.
function createGame(options = {}) {
  const { unknownProducts = [], failFinish = false } = options;
  const game = {
    ledger: [],
    mirrored: [],
    granted: [],
    finished: [],
    delivered: [],
    warnings: [],
    calls: [],
    handlers: {
      isDelivered(transactionId) {
        game.calls.push(`isDelivered:${transactionId}`);
        return game.ledger.includes(transactionId);
      },
      grant(productId, transactionId) {
        game.calls.push(`grant:${productId}`);
        if (unknownProducts.includes(productId)) return false;
        // The real game writes the product and the id together. Here the same
        // single step stands in for that one write.
        game.granted.push(productId);
        game.ledger.push(transactionId);
        return true;
      },
      mirror(transactionId) {
        game.calls.push(`mirror:${transactionId}`);
        game.mirrored.push(transactionId);
      },
      async finish(transaction) {
        game.calls.push(`finish:${getTransactionDeliveryId(transaction)}`);
        if (failFinish) throw new Error('finish never confirmed');
        game.finished.push(transaction);
      },
      onDelivered(delivery) {
        game.calls.push(`onDelivered:${delivery.productId}`);
        game.delivered.push(delivery);
      },
      onWarn(message, detail) {
        game.warnings.push({ message, detail });
      },
    },
  };
  return game;
}

function createTransaction(overrides = {}) {
  return {
    products: [{ id: 'money.1' }],
    transactionId: 'tx-1',
    async finish() {},
    ...overrides,
  };
}

test('transaction identity comes from the plugin contract fields only', () => {
  assert.equal(getTransactionProductId(createTransaction()), 'money.1');
  assert.equal(getTransactionProductId({ products: [{ id: '  money.1  ' }] }), 'money.1');
  assert.equal(getTransactionProductId({}), '');
  assert.equal(getTransactionProductId(null), '');
  assert.equal(getTransactionDeliveryId(createTransaction()), 'tx-1');
  assert.equal(getTransactionDeliveryId({ transactionId: '  tx-1  ' }), 'tx-1');
  assert.equal(getTransactionDeliveryId({}), '');
  assert.equal(getTransactionDeliveryId(null), '');

  // The two plausible wrong fields, refused by name. An empty object proves
  // nothing here: what a reader would reach for is a transaction that carries
  // something *called* the right thing. Accepting either spelling would create
  // a second reading of identity, which is how one delivery becomes two.
  assert.equal(
    getTransactionProductId({ productId: 'money.1' }),
    '',
    'productId is not a contract field',
  );
  assert.equal(
    getTransactionDeliveryId({ purchaseId: 'tx-1' }),
    '',
    'purchaseId is not the idempotency key',
  );
});

test('a first delivery grants, mirrors, reports and only then finishes', async () => {
  const game = createGame();
  assert.equal(await deliverPurchaseTransaction(createTransaction(), game.handlers), true);
  assert.deepEqual(game.calls, [
    'isDelivered:tx-1',
    'grant:money.1',
    'mirror:tx-1',
    'onDelivered:money.1',
    'finish:tx-1',
  ]);
  assert.deepEqual(game.granted, ['money.1']);
  assert.deepEqual(game.mirrored, ['tx-1']);
  assert.deepEqual(game.delivered, [{ transactionId: 'tx-1', productId: 'money.1' }]);
  assert.equal(game.finished.length, 1);
});

test('a replay of a delivered transaction finishes it without granting twice', async () => {
  const game = createGame();
  game.ledger.push('tx-1');
  assert.equal(await deliverPurchaseTransaction(createTransaction(), game.handlers), true);
  assert.deepEqual(game.calls, ['isDelivered:tx-1', 'finish:tx-1']);
  assert.deepEqual(game.granted, []);
  assert.deepEqual(game.mirrored, []);
  // A replay restores nothing, so it must not be announced as a restoration.
  assert.deepEqual(game.delivered, []);
  assert.equal(game.finished.length, 1);
});

test('a transaction the store still calls pending is left alone entirely', async () => {
  const game = createGame();
  assert.equal(
    await deliverPurchaseTransaction(createTransaction({ isPending: true }), game.handlers),
    false,
  );
  assert.deepEqual(game.calls, []);
  assert.deepEqual(game.warnings, []);
});

test('a missing transaction is not an error, only nothing to do', async () => {
  const game = createGame();
  assert.equal(await deliverPurchaseTransaction(null, game.handlers), false);
  assert.deepEqual(game.calls, []);
});

// The three shapes below are each left unfinished on purpose: the store replays
// what was never finished, which is the only way back from a delivery that could
// not be completed.
test('a transaction with no product id is left recoverable', async () => {
  const game = createGame();
  assert.equal(
    await deliverPurchaseTransaction(createTransaction({ products: [] }), game.handlers),
    false,
  );
  assert.deepEqual(game.calls, []);
  assert.equal(game.warnings.length, 1);
  assert.equal(game.finished.length, 0);
});

test('a transaction with no id is left recoverable', async () => {
  const game = createGame();
  assert.equal(
    await deliverPurchaseTransaction(createTransaction({ transactionId: '' }), game.handlers),
    false,
  );
  assert.deepEqual(game.calls, []);
  assert.equal(game.warnings.length, 1);
  assert.equal(game.finished.length, 0);
});

test('a transaction that cannot be finished is left recoverable', async () => {
  const game = createGame();
  assert.equal(
    await deliverPurchaseTransaction(createTransaction({ finish: undefined }), game.handlers),
    false,
  );
  assert.deepEqual(game.calls, []);
  assert.equal(game.warnings.length, 1);
});

test('a product the game does not know is refused before anything is written', async () => {
  const game = createGame({ unknownProducts: ['money.1'] });
  assert.equal(await deliverPurchaseTransaction(createTransaction(), game.handlers), false);
  assert.deepEqual(game.calls, ['isDelivered:tx-1', 'grant:money.1']);
  assert.deepEqual(game.mirrored, []);
  assert.equal(game.warnings.length, 1);
  assert.equal(game.finished.length, 0);
});

test('a throw from finish propagates, because the product may already be granted', async () => {
  const game = createGame({ failFinish: true });
  await assert.rejects(
    deliverPurchaseTransaction(createTransaction(), game.handlers),
    /finish never confirmed/,
  );
  // The grant and both ledger writes happened; the caller has to hear that the
  // transaction stayed unfinished.
  assert.deepEqual(game.granted, ['money.1']);
  assert.deepEqual(game.mirrored, ['tx-1']);
  assert.equal(game.finished.length, 0);
});

test('each required handler is refused by name before the transaction is read', async () => {
  for (const name of ['isDelivered', 'grant', 'mirror', 'finish']) {
    const game = createGame();
    delete game.handlers[name];
    await assert.rejects(
      deliverPurchaseTransaction(createTransaction(), game.handlers),
      new RegExp(`Purchase delivery requires ${name}\\.`),
      `${name} must be required`,
    );
    assert.deepEqual(game.calls, [], `nothing may run before ${name} is missed`);
  }
});

test('no handlers at all names all four, not just the first one missed', async () => {
  await assert.rejects(
    deliverPurchaseTransaction(createTransaction()),
    /Purchase delivery requires isDelivered, grant, mirror, finish\./,
  );
});

test('the handler check precedes the transaction, not merely the handler calls', async () => {
  // A pending transaction is the one input that returns early on its own, so it
  // is also the one that could hide a caller who forgot a handler until the
  // store stopped calling the transaction pending.
  const game = createGame();
  delete game.handlers.finish;
  await assert.rejects(
    deliverPurchaseTransaction(createTransaction({ isPending: true }), game.handlers),
    /Purchase delivery requires finish\./,
  );
});

test('the reporting callbacks are optional and deliberately not type-checked', async () => {
  const game = createGame();
  delete game.handlers.onDelivered;
  delete game.handlers.onWarn;
  assert.equal(await deliverPurchaseTransaction(createTransaction(), game.handlers), true);
  assert.deepEqual(game.granted, ['money.1']);
  assert.equal(game.finished.length, 1);
});

test('a game with no reporting callbacks can still decline an unknown product', async () => {
  const game = createGame({ unknownProducts: ['money.1'] });
  delete game.handlers.onDelivered;
  delete game.handlers.onWarn;
  assert.equal(await deliverPurchaseTransaction(createTransaction(), game.handlers), false);
  assert.deepEqual(game.granted, []);
  assert.equal(game.finished.length, 0);
});

test('the module reaches for nothing hard rule 1 forbids', () => {
  // Carried over from the game this arrived from, where it guarded the seam,
  // and widened to the rule it actually serves here — the game's list was the
  // one that mattered to a game, and stopped short of the ambient APIs the
  // runtime names. Not a ban on imports: a relative import of another headless
  // primitive is allowed, and only what the rule forbids is checked.
  const source = readFileSync(
    fileURLToPath(new URL('../src/purchase-delivery.js', import.meta.url)),
    'utf8',
  );
  for (const forbidden of [
    /\bwindow\b/,
    /\bdocument\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bfetch\s*\(/,
    /\bDate\.now\b/,
    /\bsetTimeout\b/,
    /\bclearTimeout\b/,
    /\bsetInterval\b/,
    /\bglobalThis\b/,
    /\bCapacitor\b/,
    /\bCdvPurchase\b/,
  ]) {
    assert.doesNotMatch(source, forbidden, `hard rule 1: ${forbidden}`);
  }
});
