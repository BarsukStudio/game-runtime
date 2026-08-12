// Merged from the two consumers of this logic: Muscle Clicker's
// scripts/purchase-wiring-contract-test.mjs (canonical source) and Ball Launch's
// scripts/purchase-finish-test.mjs + purchase-ownership-settlement-test.mjs.
//
// The transaction shapes below are modelled on cordova-plugin-purchase's own
// state mapping (GooglePlay.Transaction.toState(), PurchasePlugin.java), not on
// a device QA pass — neither game has device-verified purchases end to end
// (Muscle Clicker's PROJECT_STATUS.md, Ball Launch's pending iOS sandbox rows).
// These tests pin the coordinator's behaviour for a given transaction shape;
// which shapes a real store emits is still an open verification item.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPurchaseFinishCoordinator,
  isSettledStoreTransaction,
  DEFAULT_FINISH_TIMEOUT_MS,
} from '../src/purchase-finish.js';

// Mirrors CdvPurchase.TransactionState.
const FINISHED = 'finished';
const APPROVED = 'approved';

// A store double that hands back the registered listener plus a manual timer.
function createStoreHarness() {
  const harness = {
    finishedCallback: null,
    listenerName: null,
    offCalls: 0,
    timeoutCallback: null,
    timeoutMs: null,
    clearedHandles: [],
  };
  harness.store = {
    when() {
      return {
        finished(callback, name) {
          harness.finishedCallback = callback;
          harness.listenerName = name ?? null;
          return this;
        },
      };
    },
    off(callback) {
      harness.offCalls += 1;
      if (harness.finishedCallback === callback) harness.finishedCallback = null;
    },
  };
  harness.setTimeoutFn = (callback, ms) => {
    harness.timeoutCallback = callback;
    harness.timeoutMs = ms;
    return 1;
  };
  harness.clearTimeoutFn = (handle) => {
    harness.clearedHandles.push(handle);
    harness.timeoutCallback = null;
  };
  harness.create = (options = {}) => createPurchaseFinishCoordinator({
    store: harness.store,
    finishedState: FINISHED,
    timeoutMs: 100,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    ...options,
  });
  return harness;
}

function approvedTransaction(overrides = {}) {
  return {
    platform: 'android-playstore',
    transactionId: 'confirmed-finish',
    state: APPROVED,
    async finish() {},
    ...overrides,
  };
}

// --- the settlement predicate ------------------------------------------------

test('an acknowledged Google Play non-consumable is settled although it stays APPROVED', () => {
  const nonConsumable = { finishedState: FINISHED, consumable: false };
  // What GooglePlay.Transaction.toState() produces for an owned non-consumable.
  const restoredOnGooglePlay = {
    transactionId: 'GPA.1111-2222-3333-44444',
    state: APPROVED,
    isAcknowledged: true,
    isConsumed: false,
    isPending: false,
  };
  const freshOnGooglePlay = {
    transactionId: 'GPA.5555-6666-7777-88888',
    state: APPROVED,
    isAcknowledged: false,
    isConsumed: false,
    isPending: false,
  };

  assert.equal(isSettledStoreTransaction(restoredOnGooglePlay, nonConsumable), true);
  assert.equal(
    isSettledStoreTransaction(freshOnGooglePlay, nonConsumable),
    false,
    'a fresh purchase must still wait for confirmed acknowledgement',
  );
  // Apple never sets isAcknowledged; finish() takes a restored one to FINISHED.
  assert.equal(
    isSettledStoreTransaction({ transactionId: '2000000000000001', state: FINISHED }, nonConsumable),
    true,
  );
  assert.equal(
    isSettledStoreTransaction(undefined, nonConsumable),
    false,
    'a missing transaction is never settled',
  );
  assert.equal(
    isSettledStoreTransaction({ state: APPROVED, isAcknowledged: 'true' }, nonConsumable),
    false,
    'only a real boolean acknowledgement counts as settled',
  );
});

test('an acknowledged consumable is not settled until it is consumed', () => {
  const consumable = { finishedState: FINISHED, consumable: true };

  // Acknowledgement is not consumption. The Android bridge reports only
  // `acknowledged`; `consumed` lives in-session and is gone after a relaunch.
  // Skipping finish() for an acknowledged consumable would leave the product
  // unconsumed forever — unbuyable for the player and refunded by the store.
  assert.equal(isSettledStoreTransaction({ state: APPROVED, isAcknowledged: true }, consumable), false);
  assert.equal(isSettledStoreTransaction({ state: APPROVED, isConsumed: true }, consumable), true);
  assert.equal(isSettledStoreTransaction({ state: FINISHED }, consumable), true);
});

test('the non-consumable branch is the default', () => {
  assert.equal(
    isSettledStoreTransaction({ state: APPROVED, isAcknowledged: true }, { finishedState: FINISHED }),
    true,
  );
  assert.equal(isSettledStoreTransaction({ state: APPROVED, isAcknowledged: true }), true);
});

test('without a finishedState the state alone never settles a transaction', () => {
  assert.equal(isSettledStoreTransaction({ state: FINISHED }, {}), false);
  assert.equal(isSettledStoreTransaction({ state: FINISHED }, { consumable: true }), false);
});

// --- construction ------------------------------------------------------------

test('a store without when()/off() is rejected at construction', () => {
  assert.throws(() => createPurchaseFinishCoordinator(), /requires store\.when\(\) and store\.off\(\)/);
  assert.throws(
    () => createPurchaseFinishCoordinator({ store: { when() {} } }),
    /requires store\.when\(\) and store\.off\(\)/,
  );
});

// The library must never reach for an ambient setTimeout — a missing timer is a
// wiring bug in the game, and it has to surface at construction, not as a finish
// that silently never times out.
test('timers are a required dependency', () => {
  const harness = createStoreHarness();
  const missingTimers = /requires setTimeoutFn and clearTimeoutFn/;

  assert.throws(() => createPurchaseFinishCoordinator({ store: harness.store }), missingTimers);
  assert.throws(
    () => createPurchaseFinishCoordinator({ store: harness.store, setTimeoutFn: harness.setTimeoutFn }),
    missingTimers,
  );
  assert.throws(
    () => createPurchaseFinishCoordinator({ store: harness.store, clearTimeoutFn: harness.clearTimeoutFn }),
    missingTimers,
  );
  assert.throws(
    () => createPurchaseFinishCoordinator({
      store: harness.store,
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: 1,
    }),
    missingTimers,
  );
});

test('the finished listener is registered once under a namespaced name', () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  assert.equal(typeof harness.finishedCallback, 'function');
  assert.equal(harness.listenerName, 'barsukPurchaseFinishCoordinator');
  coordinator.dispose();
});

test('an invalid timeout falls back to the default budget', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create({ timeoutMs: undefined });
  coordinator.finish(approvedTransaction()).catch(() => {});
  await Promise.resolve();
  assert.equal(harness.timeoutMs, DEFAULT_FINISH_TIMEOUT_MS);
  coordinator.dispose();
});

test('a zero or negative timeout is clamped to one millisecond', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create({ timeoutMs: 0 });
  coordinator.finish(approvedTransaction()).catch(() => {});
  await Promise.resolve();
  assert.equal(harness.timeoutMs, 1);
  coordinator.dispose();
});

// --- confirmed finishing -----------------------------------------------------

// The purchase plugin's transaction.finish() resolves after dispatch. Delivery
// must stay pending until the SDK reports the native FINISHED state.
test('dispatch resolution alone does not finish delivery', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  const transaction = approvedTransaction();

  let settled = false;
  const finishPromise = coordinator.finish(transaction).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, 'dispatch resolution alone must not finish delivery');
  assert.equal(coordinator.pendingCount(), 1);

  harness.finishedCallback({
    platform: transaction.platform,
    transactionId: transaction.transactionId,
    state: FINISHED,
  });
  await finishPromise;
  assert.equal(settled, true);
  assert.equal(coordinator.pendingCount(), 0);
  assert.equal(harness.timeoutCallback, null, 'confirmation must clear the timeout');
  coordinator.dispose();
});

test('a transaction that reaches the finished state during dispatch resolves itself', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  const transaction = approvedTransaction({
    async finish() {
      this.state = FINISHED;
    },
  });

  assert.equal(await coordinator.finish(transaction), transaction);
  assert.equal(coordinator.pendingCount(), 0);
  assert.equal(harness.timeoutCallback, null);
  coordinator.dispose();
});

test('an already finished transaction is returned without touching the store', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  let finishCalls = 0;
  const transaction = approvedTransaction({
    state: FINISHED,
    async finish() {
      finishCalls += 1;
    },
  });

  assert.equal(await coordinator.finish(transaction), transaction);
  assert.equal(finishCalls, 0, 'a finished transaction must not be dispatched again');
  assert.equal(coordinator.pendingCount(), 0);
  assert.equal(harness.timeoutCallback, null, 'no timer may be armed for it');
  coordinator.dispose();
});

test('a second finish call for the same transaction reuses the pending confirmation', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  let finishCalls = 0;
  const transaction = approvedTransaction({
    async finish() {
      finishCalls += 1;
    },
  });

  const first = coordinator.finish(transaction);
  await Promise.resolve();
  const second = coordinator.finish(transaction);
  await Promise.resolve();
  assert.equal(coordinator.pendingCount(), 1, 'a duplicate must not arm a second timeout');

  harness.finishedCallback({
    platform: transaction.platform,
    transactionId: transaction.transactionId,
    state: FINISHED,
  });
  await Promise.all([first, second]);
  assert.equal(finishCalls, 1, 'the store must be asked to finish only once');
  coordinator.dispose();
});

test('the same transaction id on two platforms is tracked separately', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  const android = approvedTransaction({ platform: 'android-playstore', transactionId: 'shared-id' });
  const apple = approvedTransaction({ platform: 'ios-appstore', transactionId: 'shared-id' });

  const androidPromise = coordinator.finish(android);
  const applePromise = coordinator.finish(apple);
  await Promise.resolve();
  assert.equal(coordinator.pendingCount(), 2);

  harness.finishedCallback({ platform: 'android-playstore', transactionId: 'shared-id', state: FINISHED });
  await androidPromise;
  assert.equal(coordinator.pendingCount(), 1, 'the other platform stays pending');

  harness.finishedCallback({ platform: 'ios-appstore', transactionId: 'shared-id', state: FINISHED });
  await applePromise;
  assert.equal(coordinator.pendingCount(), 0);
  coordinator.dispose();
});

// --- failure paths -----------------------------------------------------------

test('a transaction that cannot be finished is rejected before anything is armed', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();

  await assert.rejects(coordinator.finish(null), /cannot be finished/);
  await assert.rejects(coordinator.finish({ transactionId: 'x', state: APPROVED }), /cannot be finished/);
  assert.equal(coordinator.pendingCount(), 0);
  assert.equal(harness.timeoutCallback, null);
  coordinator.dispose();
});

test('a transaction without a stable id is rejected', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();

  await assert.rejects(
    coordinator.finish(approvedTransaction({ transactionId: '  ' })),
    /no stable transaction id/,
  );
  assert.equal(coordinator.pendingCount(), 0);
  assert.equal(harness.timeoutCallback, null, 'a rejected transaction must not leave a timer behind');
  coordinator.dispose();
});

test('a store error during dispatch rejects the confirmation', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  const failure = new Error('billing unavailable');
  const transaction = approvedTransaction({
    async finish() {
      throw failure;
    },
  });

  await assert.rejects(coordinator.finish(transaction), (error) => error === failure);
  assert.equal(coordinator.pendingCount(), 0);
  assert.equal(harness.timeoutCallback, null);
  coordinator.dispose();
});

test('an unconfirmed finish rejects when the confirmation budget expires', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  const timedOut = approvedTransaction({ platform: 'ios-appstore', transactionId: 'timeout' });

  const rejected = coordinator.finish(timedOut);
  await Promise.resolve();
  harness.timeoutCallback();
  await assert.rejects(rejected, /confirmation timed out for ios-appstore:timeout/);
  assert.equal(coordinator.pendingCount(), 0);
  coordinator.dispose();
});

// The store can move the transaction to its terminal state without emitting the
// event the coordinator listens for; the timeout must read the state before it
// declares a failure.
test('a transaction already finished when the timeout fires resolves instead', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  const transaction = approvedTransaction({ transactionId: 'silently-finished' });

  const promise = coordinator.finish(transaction);
  await Promise.resolve();
  transaction.state = FINISHED;
  harness.timeoutCallback();
  assert.equal(await promise, transaction);
  assert.equal(coordinator.pendingCount(), 0);
  coordinator.dispose();
});

test('a finished event for an unknown transaction is ignored', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  const transaction = approvedTransaction();
  const promise = coordinator.finish(transaction);
  await Promise.resolve();

  harness.finishedCallback({ platform: 'android-playstore', transactionId: 'other', state: FINISHED });
  harness.finishedCallback({ state: FINISHED });
  harness.finishedCallback(undefined);
  assert.equal(coordinator.pendingCount(), 1, 'a foreign confirmation must not settle our transaction');

  harness.finishedCallback({
    platform: transaction.platform,
    transactionId: transaction.transactionId,
    state: FINISHED,
  });
  await promise;
  coordinator.dispose();
});

// --- disposal ----------------------------------------------------------------

test('dispose unsubscribes, clears timers and rejects everything pending', async () => {
  const harness = createStoreHarness();
  const coordinator = harness.create();
  const pending = coordinator.finish(approvedTransaction({ transactionId: 'disposed' }));
  await Promise.resolve();
  assert.equal(coordinator.pendingCount(), 1);

  coordinator.dispose();
  await assert.rejects(pending, /coordinator disposed/);
  assert.equal(coordinator.pendingCount(), 0);
  assert.equal(harness.offCalls, 1);
  assert.equal(harness.finishedCallback, null, 'dispose must hand back the registered listener');
  assert.deepEqual(harness.clearedHandles, [1], 'the pending timeout must be cleared');
});

test('the coordinator works with the host platform timers', async () => {
  const harness = createStoreHarness();
  const coordinator = createPurchaseFinishCoordinator({
    store: harness.store,
    finishedState: FINISHED,
    timeoutMs: 20,
    setTimeoutFn: (callback, ms) => setTimeout(callback, ms),
    clearTimeoutFn: (handle) => clearTimeout(handle),
  });
  const transaction = approvedTransaction({ transactionId: 'real-timers' });

  await assert.rejects(coordinator.finish(transaction), /confirmation timed out/);
  assert.equal(coordinator.pendingCount(), 0);
  coordinator.dispose();
});
