// Extracted from Muscle Clicker 2, which carries the starter template's copy of
// the coordinator, and from the starter's own suite for it. Muscle Clicker's
// copy differed only in ignoring a handler's `false`; its handlers never return
// one, so both games keep their behaviour. The scenarios below are the generic
// half of Muscle Clicker's scripts/rewarded-request-context-test.mjs, with the
// placements and amounts replaced by neutral ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AD_DISMISSAL_TIMEOUT_MS, createAdLifecycle } from '../src/ad-lifecycle.js';
import { createRewardedRequestCoordinator } from '../src/rewarded-request-context.js';

function createIds() {
  let sequence = 0;
  return () => `request-${++sequence}`;
}

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
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
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

// A game with one placement that pays only on a confirmed view and one that also
// owes a base payout on every outcome.
function createGame(overrides = {}) {
  const state = { money: 0, basePaid: 0, finalized: [], warnings: [] };
  const coordinator = createRewardedRequestCoordinator({
    createRequestId: createIds(),
    onRewardEarned: (request) => {
      state.money += request.payload.bonus;
    },
    onFinalize: (request, outcome) => {
      state.finalized.push(outcome);
      if (request.placement === 'with_base') {
        state.basePaid += 1;
        state.money += request.payload.base;
      }
    },
    onWarn: (message, detail) => state.warnings.push({ message, detail }),
    ...overrides,
  });
  return { state, coordinator };
}

test('the id source is required', () => {
  // A default counter would restart at the same ids every launch, and a game
  // that keeps the id as a durable delivery id would refuse the new reward.
  assert.throws(() => createRewardedRequestCoordinator(), /createRequestId/);
  assert.throws(() => createRewardedRequestCoordinator({ createRequestId: 'id' }), /createRequestId/);
});

test('the request carries the snapshot taken at begin', () => {
  const { coordinator } = createGame();
  const payload = { bonus: 100 };
  const request = coordinator.begin({ placement: 'bonus_only', payload });
  assert.deepEqual(request, {
    requestId: 'request-1',
    saveEpoch: 0,
    placement: 'bonus_only',
    payload,
    rewardGranted: false,
    finalized: false,
  });
  assert.equal(coordinator.getActive(), request);
  assert.equal(coordinator.isBusy(), true);
});

test('a begin without a placement is a wiring mistake, not a silent no-op', () => {
  const { coordinator } = createGame();
  assert.throws(() => coordinator.begin({ payload: {} }), /placement/);
  assert.throws(() => coordinator.begin(), /placement/);
  assert.equal(coordinator.isBusy(), false);
});

test('a second begin while a request is in flight is refused', () => {
  const { state, coordinator } = createGame();
  const first = coordinator.begin({ placement: 'bonus_only', payload: { bonus: 100 } });
  assert.equal(coordinator.begin({ placement: 'bonus_only', payload: { bonus: 7 } }), null);
  assert.equal(coordinator.getActive(), first);
  coordinator.rewardEarned();
  assert.equal(state.money, 100, 'the first request owns the reward');
});

test('a provider that emits the reward twice grants once', () => {
  const { state, coordinator } = createGame();
  coordinator.begin({ placement: 'bonus_only', payload: { bonus: 100 } });
  assert.equal(coordinator.rewardEarned(), true);
  assert.equal(coordinator.rewardEarned(), false);
  assert.equal(state.money, 100);
});

test('a doubled close finalizes once and releases the coordinator', () => {
  const { state, coordinator } = createGame();
  const request = coordinator.begin({ placement: 'with_base', payload: { base: 50, bonus: 50 } });
  assert.equal(coordinator.finalize('closed'), true);
  assert.equal(coordinator.finalize('closed'), false);
  assert.equal(state.basePaid, 1);
  assert.equal(request.finalized, true);
  assert.equal(coordinator.isBusy(), false);
  assert.equal(coordinator.rewardEarned(), false, 'no reward after finalization');
  assert.equal(state.money, 50);
});

test('a close without a confirmed view pays only what every outcome owes', () => {
  const { state, coordinator } = createGame();
  coordinator.begin({ placement: 'bonus_only', payload: { bonus: 100 } });
  coordinator.finalize('closed');
  assert.equal(state.money, 0);
  coordinator.begin({ placement: 'with_base', payload: { base: 50, bonus: 50 } });
  coordinator.finalize('show-failed');
  assert.equal(state.money, 50, 'base only, no bonus');
  assert.deepEqual(state.finalized, ['closed', 'show-failed']);
});

test('an explicitly tagged callback from a finished request is dropped', () => {
  // Production callbacks pass no id — there the ordering guarantee comes from
  // ad-lifecycle — so this covers the stricter, opt-in path only.
  const { state, coordinator } = createGame();
  const stale = coordinator.begin({ placement: 'bonus_only', payload: { bonus: 100 } });
  coordinator.finalize('closed');
  coordinator.begin({ placement: 'bonus_only', payload: { bonus: 7 } });
  assert.equal(coordinator.rewardEarned(stale.requestId), false);
  assert.equal(coordinator.finalize('closed', stale.requestId), false);
  assert.equal(state.money, 0);
  assert.equal(coordinator.isBusy(), true);
  assert.equal(coordinator.rewardEarned('request-2'), true);
  assert.equal(state.money, 7);
});

test('a captured confirmation keeps its request after the UI finalized', () => {
  const paid = [];
  const finalized = [];
  const coordinator = createRewardedRequestCoordinator({
    createRequestId: createIds(),
    onRewardEarned: (request) => paid.push(request.payload.amount),
    onFinalize: (request) => finalized.push(request.requestId),
  });
  const a = coordinator.begin({ placement: 'money', payload: { amount: 100 } });
  const confirmA = coordinator.captureReward();
  coordinator.finalize();
  assert.deepEqual(paid, []);
  const b = coordinator.begin({ placement: 'money', payload: { amount: 200 } });
  assert.equal(confirmA(), true);
  assert.equal(confirmA(), false);
  assert.deepEqual(paid, [100], 'the late confirmation paid its own request');
  assert.equal(coordinator.getActive(), b);
  assert.equal(b.rewardGranted, false);
  assert.deepEqual(finalized, [a.requestId]);
});

test('an invalidated save voids every captured confirmation', () => {
  const { state, coordinator } = createGame();
  coordinator.begin({ placement: 'bonus_only', payload: { bonus: 100 } });
  const confirm = coordinator.captureReward();
  coordinator.invalidate();
  assert.equal(coordinator.isBusy(), false);
  assert.equal(confirm(), false);
  assert.equal(coordinator.rewardEarned(), false);
  assert.equal(state.money, 0);
});

test('a confirmation captured with nothing in flight grants nothing', () => {
  const { state, coordinator } = createGame();
  const confirm = coordinator.captureReward();
  coordinator.begin({ placement: 'bonus_only', payload: { bonus: 100 } });
  assert.equal(confirm(), false);
  assert.equal(state.money, 0);
});

for (const path of ['captureReward', 'rewardEarned']) {
  test(`${path}: a grant refused with false is retried, and re-entry is refused`, () => {
    // The model for a game whose grant commits to storage: `false` means the
    // save failed and the next confirmation of the same request retries it.
    let calls = 0;
    let paid = 0;
    let confirm;
    const coordinator = createRewardedRequestCoordinator({
      createRequestId: createIds(),
      onRewardEarned: () => {
        calls += 1;
        assert.equal(confirm(), false, 'an in-progress grant cannot enter twice');
        if (calls === 1) return false;
        paid += 1;
      },
    });
    const request = coordinator.begin({ placement: 'bonus_only' });
    confirm = path === 'captureReward'
      ? coordinator.captureReward()
      : () => coordinator.rewardEarned(request.requestId);
    assert.equal(confirm(), false);
    assert.equal(request.rewardGranted, false);
    assert.equal(confirm(), true);
    assert.equal(request.rewardGranted, true);
    assert.equal(confirm(), false);
    assert.equal(paid, 1);
    assert.equal(calls, 2);
  });

  test(`${path}: a grant that returns nothing counts as granted`, () => {
    // The model for a game whose grant cannot fail: no return value, one grant.
    let calls = 0;
    const coordinator = createRewardedRequestCoordinator({
      createRequestId: createIds(),
      onRewardEarned: () => {
        calls += 1;
      },
    });
    const request = coordinator.begin({ placement: 'bonus_only' });
    const confirm = path === 'captureReward'
      ? coordinator.captureReward()
      : () => coordinator.rewardEarned();
    assert.equal(confirm(), true);
    assert.equal(request.rewardGranted, true);
    assert.equal(confirm(), false);
    assert.equal(calls, 1);
  });
}

test('a throwing handler is reported and does not wedge the coordinator', () => {
  let explode = true;
  const { state, coordinator } = createGame({
    onFinalize: () => {
      if (explode) {
        explode = false;
        throw new Error('game handler exploded');
      }
    },
  });
  coordinator.begin({ placement: 'with_base', payload: { base: 50, bonus: 50 } });
  assert.equal(coordinator.finalize('closed'), true);
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0].message, /with_base, closed/);
  assert.equal(state.warnings[0].detail.message, 'game handler exploded');
  assert.equal(coordinator.isBusy(), false);
  assert.ok(coordinator.begin({ placement: 'bonus_only', payload: { bonus: 100 } }));
  coordinator.rewardEarned();
  assert.equal(state.money, 100);
});

test('a throwing grant counts as granted, so it is never paid twice', () => {
  const warnings = [];
  let calls = 0;
  const coordinator = createRewardedRequestCoordinator({
    createRequestId: createIds(),
    onRewardEarned: () => {
      calls += 1;
      throw new Error('grant exploded');
    },
    onWarn: (message) => warnings.push(message),
  });
  coordinator.begin({ placement: 'bonus_only' });
  assert.equal(coordinator.rewardEarned(), true);
  assert.equal(coordinator.rewardEarned(), false);
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
});

test('without onWarn a throwing handler is still contained', () => {
  const coordinator = createRewardedRequestCoordinator({
    createRequestId: createIds(),
    onFinalize: () => {
      throw new Error('game handler exploded');
    },
  });
  coordinator.begin({ placement: 'bonus_only' });
  assert.equal(coordinator.finalize('closed'), true);
  assert.equal(coordinator.isBusy(), false);
});

// Wired to ad-lifecycle the way a game's bridge hands it the terminal events.
function createShow(coordinator, clock) {
  return createAdLifecycle({
    name: 'rewarded',
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    callbacks: {
      onRewarded: () => coordinator.rewardEarned(),
      onClosed: () => coordinator.finalize('closed'),
      onShowFailed: () => coordinator.finalize('show-failed'),
    },
  });
}

test('with ad-lifecycle: reward then close pays the bonus and the base once', () => {
  const clock = createClock();
  const { state, coordinator } = createGame();
  const show = createShow(coordinator, clock);
  show.beginLoad();
  show.loadSucceeded();
  coordinator.begin({ placement: 'with_base', payload: { base: 50, bonus: 50 } });
  show.beginShow();
  show.showStarted();
  show.rewardEarned();
  show.showClosed();
  assert.equal(state.money, 100);
  assert.equal(coordinator.isBusy(), false);
});

test('with ad-lifecycle: a missing close is finalized by the dismissal watchdog', () => {
  const clock = createClock();
  const { state, coordinator } = createGame();
  const show = createShow(coordinator, clock);
  show.beginLoad();
  show.loadSucceeded();
  coordinator.begin({ placement: 'with_base', payload: { base: 50, bonus: 50 } });
  show.beginShow();
  show.showStarted();
  show.rewardEarned();
  assert.equal(state.money, 50, 'only the bonus before finalization');
  assert.equal(coordinator.isBusy(), true);
  clock.advance(AD_DISMISSAL_TIMEOUT_MS);
  assert.equal(state.money, 100);
  assert.equal(state.basePaid, 1);
  assert.equal(coordinator.isBusy(), false);
});

test('with ad-lifecycle: a failed show still pays what every outcome owes', () => {
  const clock = createClock();
  const { state, coordinator } = createGame();
  const show = createShow(coordinator, clock);
  show.beginLoad();
  show.loadSucceeded();
  coordinator.begin({ placement: 'with_base', payload: { base: 50, bonus: 50 } });
  show.beginShow();
  show.showFailed(new Error('no fill'));
  assert.equal(state.money, 50);
  assert.deepEqual(state.finalized, ['show-failed']);
  assert.equal(coordinator.isBusy(), false);
});

test('the module source stays headless', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/rewarded-request-context.js', import.meta.url)),
    'utf8',
  );
  for (const forbidden of [
    /\bimport\b/,
    /\bwindow\b/,
    /\bdocument\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bfetch\s*\(/,
    /\bDate\.now\b/,
    /\bsetTimeout\b/,
    /\bglobalThis\b/,
    /\bconsole\b/,
    /\bcrypto\b/,
    /\bCapacitor\b/,
  ]) {
    assert.doesNotMatch(source, forbidden, `hard rule 1: ${forbidden}`);
  }
});
