// Behavioural tests for the purchase restore session, carried over from Muscle
// Clicker (scripts/purchase-restore-session-test.mjs) with its scenarios intact.
//
// Every scenario runs on a fake clock, so "waited long enough" is asserted as an
// exact number of milliseconds instead of being slept through. The recurring
// theme: the store answers *after* restorePurchases() resolves, and the session
// may not decide before it has heard that answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RESTORE_QUIET_MS,
  DEFAULT_RESTORE_SETTLE_WINDOW_MS,
  DEFAULT_RESTORE_TIMEOUT_MS,
  RESTORE_STATUS,
  createPurchaseRestoreSession,
  toRestoreError,
} from '../src/purchase-restore-session.js';

function createClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    setTimeoutFn(fn, ms) {
      sequence += 1;
      timers.set(sequence, { fn, at: now + Number(ms || 0) });
      return sequence;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    // Fires every timer due at or before `now + ms`, in order, so a timer
    // scheduled by a callback still runs inside the same advance().
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

// The session resolves from a timer callback, so the awaiting continuation only
// runs once the microtask queue is drained. Every assertion about "has it
// decided yet" goes through this.
function settled(promise) {
  const pending = Symbol('pending');
  let outcome = pending;
  promise.then((value) => { outcome = value; });
  return {
    async read() {
      // A real macrotask, so every pending microtask — including the
      // promise adoption inside run() — has run by the time we look.
      await new Promise((resolve) => { setImmediate(resolve); });
      return outcome === pending ? null : outcome;
    },
  };
}

// A store stand-in: `restorePurchases()` resolves when the test says so, and the
// entitlement answers exactly what the store would.
function createStore({ owned = false, receiptsLoaded = false } = {}) {
  let resolveRestore = null;
  const state = { owned, receiptsLoaded, restoreCalls: 0 };
  return {
    state,
    readEntitlement: () => ({ owned: state.owned, receiptsLoaded: state.receiptsLoaded }),
    restoreCall: () => {
      state.restoreCalls += 1;
      return new Promise((resolve) => { resolveRestore = resolve; });
    },
    // cdv-purchase resolves restorePurchases() with an IError instead of
    // rejecting, so "resolved" and "failed" are the same code path.
    settleRestore(value) {
      resolveRestore?.(value);
      return Promise.resolve();
    },
  };
}

function createSession(clock, store, options = {}) {
  return createPurchaseRestoreSession({
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    readEntitlement: store.readEntitlement,
    onWarn: () => { },
    ...options,
  });
}

// 1. The bug this module exists for: restorePurchases() resolves, the session
//    must not answer before the entitlement and the delivery have landed.
test('The bug this module exists for', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  assert.equal(await result.read(), null, 'a resolved store call is not an answer');

  // The receipt arrives one tick later, as it does on a device.
  clock.advance(200);
  session.beginActivity('purchase-delivery');
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS + DEFAULT_RESTORE_QUIET_MS);
  assert.equal(await result.read(), null, 'the window cannot close while a delivery runs');

  session.noteDelivered({ transactionId: 'tx-1', productId: 'fixture.money.1' });
  session.endActivity('purchase-delivery');
  clock.advance(DEFAULT_RESTORE_QUIET_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.RESTORED);
  assert.deepEqual(outcome.deliveredTransactions, [
    { transactionId: 'tx-1', productId: 'fixture.money.1' },
  ], 'a redelivered consumable is a restoration');
  assert.equal(outcome.error, null);
});

// 2. Nothing to restore: the store has loaded its receipts and owns nothing, so
//    the session may say so — but only after the observation window.
test('Nothing to restore', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS - 1);
  assert.equal(await result.read(), null, 'the minimum window must elapse first');

  clock.advance(1);
  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.NOTHING);
  assert.equal(outcome.owned, false);
  assert.deepEqual(outcome.deliveredTransactions, []);
});

// 3. The store never loads a receipt. "Nothing to restore" would be a claim
//    about an answer that never came, so this is a timeout instead.
test('The store never loads a receipt', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: false });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_TIMEOUT_MS - 1);
  assert.equal(await result.read(), null, 'an unanswered store keeps the session open');

  clock.advance(1);
  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.TIMEOUT);
  assert.notEqual(outcome.status, RESTORE_STATUS.NOTHING);
});

// 4. A late entitlement: receiptsReady lands after the store call resolved, and
//    it is what unblocks the session.
test('A late entitlement', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: false });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  clock.advance(5000);
  assert.equal(await result.read(), null);

  store.state.owned = true;
  store.state.receiptsLoaded = true;
  session.noteActivity();
  clock.advance(DEFAULT_RESTORE_QUIET_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.RESTORED);
  assert.equal(outcome.owned, true, 'the non-consumable entitlement is reported');
  assert.deepEqual(outcome.deliveredTransactions, [], 'ownership alone delivers no transaction');
});

// 5. Every event restarts the quiet period, so a stream of receipt updates is
//    followed to its end instead of being cut off mid-restore.
test('Every event restarts the quiet period, so a stream of receipt updates is followed to its end instead of being cut off mid-restore', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS - 100);
  for (let i = 0; i < 4; i++) {
    session.noteActivity();
    clock.advance(DEFAULT_RESTORE_QUIET_MS - 100);
    assert.equal(await result.read(), null, 'each event pushes the decision back');
  }
  session.noteDelivered({ transactionId: 'tx-late', productId: 'fixture.sp.1' });
  clock.advance(DEFAULT_RESTORE_QUIET_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.RESTORED);
  assert.deepEqual(outcome.deliveredTransactions.map((t) => t.transactionId), ['tx-late']);
});

// 6. The store call itself failed and nothing arrived: failed, not nothing.
test('The store call itself failed and nothing arrived', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  // cdv-purchase resolves with an IError rather than rejecting.
  await store.settleRestore({ code: 6777010, message: 'Restore failed' });
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.FAILED);
  assert.equal(outcome.error?.message, 'Restore failed');
  assert.equal(outcome.error?.code, 6777010);
});

// A rejected promise is the same failure.
test('A rejected promise is the same failure', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(() => Promise.reject(new Error('store offline'))));

  await Promise.resolve();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.FAILED);
  assert.equal(outcome.error?.message, 'store offline');
});

// 7. Delivered first, failed after: the player has the product, so the result is
//    restored — with the error carried along for the log.
test('Delivered first, failed after', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  session.noteDelivered({ transactionId: 'tx-2', productId: 'fixture.entitlement' });
  await store.settleRestore({ code: 6777010, message: 'finish failed' });
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS + DEFAULT_RESTORE_QUIET_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.RESTORED, 'a granted product outranks a late failure');
  assert.equal(outcome.error?.message, 'finish failed', 'the error still travels to the caller');
  assert.deepEqual(outcome.deliveredTransactions.map((t) => t.transactionId), ['tx-2']);
});

// 8. A delivery that outlives the hard timeout still ends the session, and what
//    was already granted is still reported as restored.
test('A delivery that outlives the hard timeout still ends the session, and what was already granted is still reported as restored', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  session.beginActivity('purchase-delivery');
  session.noteDelivered({ transactionId: 'tx-3', productId: 'fixture.money.2' });
  clock.advance(DEFAULT_RESTORE_TIMEOUT_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.RESTORED);
  assert.deepEqual(outcome.deliveredTransactions.map((t) => t.transactionId), ['tx-3']);
  assert.equal(session.isFinished(), true);
  // Whatever the stuck delivery does afterwards must not reopen the session.
  assert.equal(session.endActivity('purchase-delivery'), false, 'a bracket closing after the fact is inert');
  assert.equal(session.noteDelivered({ transactionId: 'tx-4', productId: 'fixture.sp.2' }), false);
  assert.deepEqual(outcome.deliveredTransactions.map((t) => t.transactionId), ['tx-3']);
});

// Password entry can outlive the processing timeout. Keep one request alive,
// then accept the store's late result instead of reporting a false timeout.
test('Password entry can outlive the processing timeout', async () => {
 for (const owned of [false, true]) {
   const clock = createClock();
   const store = createStore({ receiptsLoaded: true });
   const session = createSession(clock, store);
   const result = settled(session.run(store.restoreCall));
   clock.advance(DEFAULT_RESTORE_TIMEOUT_MS * 4);
   assert.equal(await result.read(), null);
   assert.equal(session.isFinished(), false);
   await assert.rejects(() => session.run(store.restoreCall), /already ran/);
   assert.equal(store.state.restoreCalls, 1);
   store.state.owned = owned;
   await store.settleRestore();
   clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS);
   const outcome = await result.read();
   assert.equal(outcome.status, owned ? RESTORE_STATUS.RESTORED : RESTORE_STATUS.NOTHING);
   assert.equal(outcome.error, null);
 }
});

// A cancelled/failed store request after slow authentication remains a failure.
test('A cancelled/failed store request after slow authentication remains a failure', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));
  clock.advance(DEFAULT_RESTORE_TIMEOUT_MS * 4);
  await store.settleRestore({ code: 6777006, message: 'User cancelled' });
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS);
  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.FAILED);
  assert.equal(outcome.error.message, 'User cancelled');
});

// 9. The same transaction reported twice counts once. Delivery is recorded after
//    the ledger write, but a redelivered receipt can still run through twice.
test('The same transaction reported twice counts once', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  assert.equal(session.noteDelivered({ transactionId: 'tx-5', productId: 'fixture.money.1' }), true);
  assert.equal(session.noteDelivered({ transactionId: 'tx-5', productId: 'fixture.money.1' }), false);
  // A transaction without an id is not a delivery the session can name.
  assert.equal(session.noteDelivered({ transactionId: '', productId: 'fixture.money.1' }), false);
  assert.equal(session.noteDelivered({ transactionId: 'tx-6', productId: '' }), false);

  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS + DEFAULT_RESTORE_QUIET_MS);
  const outcome = await result.read();
  assert.deepEqual(outcome.deliveredTransactions.map((t) => t.transactionId), ['tx-5']);
});

// 10. Nested brackets: the session waits for the last one to close.
test('Nested brackets', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  session.beginActivity('purchase-verify');
  session.beginActivity('purchase-verify');
  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS + DEFAULT_RESTORE_QUIET_MS);
  assert.equal(await result.read(), null);

  session.endActivity('purchase-verify');
  clock.advance(DEFAULT_RESTORE_QUIET_MS);
  assert.equal(await result.read(), null, 'one bracket is still open');

  session.endActivity('purchase-verify');
  assert.equal(session.endActivity('purchase-verify'), false, 'an unbalanced close is refused');
  clock.advance(DEFAULT_RESTORE_QUIET_MS);
  assert.equal((await result.read()).status, RESTORE_STATUS.NOTHING);
});

// 11. A throwing entitlement reader must not wedge the session; it is treated as
//     "the store has not answered", which the hard timeout resolves.
test('A throwing entitlement reader must not wedge the session; it is treated as "the store has not answered", which the hard timeout resolves', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store, {
    readEntitlement: () => { throw new Error('store exploded'); },
  });
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_TIMEOUT_MS);
  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.TIMEOUT);
  assert.equal(outcome.owned, false);
});

// 12. One session runs one restore.
test('One session runs one restore', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  void session.run(store.restoreCall);
  await assert.rejects(() => session.run(store.restoreCall), /already ran/);
  assert.equal(store.state.restoreCalls, 1);
});

// 13. The store's error shapes.
test('The store\'s error shapes', async () => {
  assert.equal(toRestoreError(undefined), null);
  assert.equal(toRestoreError(null), null);
  const fromError = new Error('boom');
  assert.equal(toRestoreError(fromError), fromError);
  const fromIError = toRestoreError({ code: 42, message: 'nope' });
  assert.equal(fromIError.message, 'nope');
  assert.equal(fromIError.code, 42);
  assert.equal(toRestoreError('plain').message, 'plain');
});

// 14. Errors from anywhere in the pipeline decide `failed` vs `nothing`. A
//     verification that rejected is not "nothing to restore".
test('Errors from anywhere in the pipeline decide `failed` vs `nothing`', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  session.beginActivity('purchase-verify');
  await store.settleRestore();
  session.noteError(new Error('verify rejected'));
  session.endActivity('purchase-verify');
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS + DEFAULT_RESTORE_QUIET_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.FAILED, 'a failed verification is not "nothing"');
  assert.equal(outcome.error?.message, 'verify rejected');
});

// A finish() that failed after the grant leaves the product restored, with the
// error carried for the log — the contract a game relies on.
test('A finish() that failed after the grant leaves the product restored, with the error carried for the log — the contract a game relies on', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  session.beginActivity('purchase-delivery');
  session.noteDelivered({ transactionId: 'tx-7', productId: 'fixture.money.1' });
  session.noteError(new Error('finish confirmation timed out'));
  session.endActivity('purchase-delivery');
  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS + DEFAULT_RESTORE_QUIET_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.RESTORED);
  assert.equal(outcome.error?.message, 'finish confirmation timed out');
  assert.deepEqual(outcome.deliveredTransactions.map((t) => t.transactionId), ['tx-7']);
});

// The first error wins, later ones do not overwrite it, and an error after the
// session closed changes nothing.
test('The first error wins, later ones do not overwrite it, and an error after the session closed changes nothing', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  session.noteError(new Error('first'));
  assert.equal(session.noteError(new Error('second')), true);
  assert.equal(session.noteError(null), false, 'a missing error is not activity');
  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS + DEFAULT_RESTORE_QUIET_MS);

  const outcome = await result.read();
  assert.equal(outcome.error?.message, 'first');
  assert.equal(session.noteError(new Error('too late')), false);
  assert.equal(outcome.error?.message, 'first');
});

// An error noted before the store call settles still restarts the quiet period,
// so it cannot be raced by the observation window closing.
test('An error noted before the store call settles still restarts the quiet period, so it cannot be raced by the observation window closing', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS - 100);
  session.noteError(new Error('late unverified receipt'));
  clock.advance(DEFAULT_RESTORE_QUIET_MS - 100);
  assert.equal(await result.read(), null, 'the error pushed the decision back');

  clock.advance(100);
  assert.equal((await result.read()).status, RESTORE_STATUS.FAILED);
});

// 15. Ownership the store reports is a restoration even when the receipts were
//     loaded before this session — `store.owned()` is live receipt state, not a
//     cached local flag, and a player who owns the product must never be told
//     the restore failed. Deliberately different from a stricter reading that
//     would demand a fresh confirmation the plugin never emits.
test('Ownership the store reports is a restoration even when the receipts were loaded before this session — `store.owned()` is live receipt state, not a cached local flag, and a player who owns the product must never be told the restore failed', async () => {
  const clock = createClock();
  const store = createStore({ owned: true, receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS);
  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.RESTORED);
  assert.equal(outcome.owned, true);
});

// An error that arrived on its own is not overwritten by the timeout.
test('An error that arrived on its own is not overwritten by the timeout', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  session.noteError(new Error('verification exploded'));
  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_TIMEOUT_MS);
  const outcome = await result.read();
  assert.equal(outcome.error?.message, 'verification exploded');
});

// 17. A delivery that outlives its restore must not report into the next one.
//     The finish confirmation alone allows 30s against the session's 20s, so a
//     player can start restore B while A's transactions are still settling.
test('A delivery that outlives its restore must not report into the next one', async () => {
  const clock = createClock();
  const storeA = createStore({ receiptsLoaded: true });
  const sessionA = createSession(clock, storeA);
  const resultA = settled(sessionA.run(storeA.restoreCall));

  await storeA.settleRestore();
  // Two transactions on one receipt: the first is delivered, the second hangs
  // inside finish().
  sessionA.beginActivity('purchase-delivery');
  sessionA.noteDelivered({ transactionId: 'tx-a1', productId: 'fixture.money.1' });
  clock.advance(DEFAULT_RESTORE_TIMEOUT_MS);

  const outcomeA = await resultA.read();
  assert.equal(outcomeA.status, RESTORE_STATUS.RESTORED, 'A keeps what it delivered');
  assert.deepEqual(outcomeA.deliveredTransactions.map((t) => t.transactionId), ['tx-a1']);

  const storeB = createStore({ receiptsLoaded: true });
  const sessionB = createSession(clock, storeB);
  const resultB = settled(sessionB.run(storeB.restoreCall));
  await storeB.settleRestore();

  // A's stuck delivery finally lands. It holds session A, so everything it
  // reports goes nowhere — B must stay clean.
  assert.equal(sessionA.noteDelivered({ transactionId: 'tx-a2', productId: 'fixture.sp.1' }), false);
  assert.equal(sessionA.noteError(new Error('finish confirmation timed out')), false);
  assert.equal(sessionA.endActivity('purchase-delivery'), false);

  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS + DEFAULT_RESTORE_QUIET_MS);
  const outcomeB = await resultB.read();
  assert.equal(outcomeB.status, RESTORE_STATUS.NOTHING, 'B answers for itself only');
  assert.deepEqual(outcomeB.deliveredTransactions, [], "A's late delivery must not land in B");
  assert.equal(outcomeB.error, null, "A's late failure must not land in B");
  // And A's own result was already resolved and stays untouched.
  assert.deepEqual(outcomeA.deliveredTransactions.map((t) => t.transactionId), ['tx-a1']);
});

// But ownership alone cannot close the session early while the store has never
// loaded a receipt — that state is indistinguishable from a store that never
// started, so it waits for the hard timeout.
test('But ownership alone cannot close the session early while the store has never loaded a receipt — that state is indistinguishable from a store that never started, so it waits for the hard timeout', async () => {
  const clock = createClock();
  const store = createStore({ owned: true, receiptsLoaded: false });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS + DEFAULT_RESTORE_QUIET_MS);
  assert.equal(await result.read(), null, 'an unloaded store keeps the session open');

  clock.advance(DEFAULT_RESTORE_TIMEOUT_MS);
  assert.equal((await result.read()).status, RESTORE_STATUS.RESTORED);
});

// 16. The scenario the whole window exists for: receipts were ready long before
//     the player tapped Restore, so nothing in the session is "fresh". A
//     delivery that starts inside the window must still be waited for.
test('The scenario the whole window exists for', async () => {
  const clock = createClock();
  const store = createStore({ receiptsLoaded: true });
  const session = createSession(clock, store);
  const result = settled(session.run(store.restoreCall));

  await store.settleRestore();
  // approved arrives late, but still inside the observation window.
  clock.advance(DEFAULT_RESTORE_SETTLE_WINDOW_MS - 200);
  session.beginActivity('purchase-verify');
  clock.advance(4000);
  assert.equal(await result.read(), null, 'verification holds the session open');

  session.beginActivity('purchase-delivery');
  session.endActivity('purchase-verify');
  session.noteDelivered({ transactionId: 'tx-8', productId: 'fixture.money.2' });
  session.endActivity('purchase-delivery');
  clock.advance(DEFAULT_RESTORE_QUIET_MS);

  const outcome = await result.read();
  assert.equal(outcome.status, RESTORE_STATUS.RESTORED);
  assert.deepEqual(outcome.deliveredTransactions.map((t) => t.transactionId), ['tx-8']);
});


test('timers are a required dependency', () => {
  const clock = createClock();
  const missingTimers = /requires setTimeoutFn and clearTimeoutFn/;

  assert.throws(() => createPurchaseRestoreSession(), missingTimers);
  assert.throws(() => createPurchaseRestoreSession({ setTimeoutFn: clock.setTimeoutFn }), missingTimers);
  assert.throws(() => createPurchaseRestoreSession({ clearTimeoutFn: clock.clearTimeoutFn }), missingTimers);
});

test('the module reaches for nothing hard rule 1 forbids', () => {
  // The game's copy fell back to the host timers and console; here every one of
  // them has to arrive through the options. Read off the code, not the prose:
  // the comments talk about the observation *window*, and a check that mistook
  // that for a reach would be a check about English.
  const source = readFileSync(
    fileURLToPath(new URL('../src/purchase-restore-session.js', import.meta.url)),
    'utf8',
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  for (const forbidden of [
    /\bwindow\b/,
    /\bdocument\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bfetch\s*\(/,
    /\bDate\.now\b/,
    /\bperformance\b/,
    /\bsetTimeout\b/,
    /\bclearTimeout\b/,
    /\bsetInterval\b/,
    /\bglobalThis\b/,
    /\bconsole\b/,
    /\bCapacitor\b/,
    /\bCdvPurchase\b/,
    /\bimport\s*\(/,
    /\bimport\s*['"][^.]/,
    /\bfrom\s*['"][^.]/,
  ]) {
    assert.doesNotMatch(code, forbidden, `hard rule 1: ${forbidden}`);
  }
  // The stripper has to leave something to check.
  assert.match(code, /export function createPurchaseRestoreSession\(/, 'the code survived comment stripping');
});
