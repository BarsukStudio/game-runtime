import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdLifecycle } from '../src/ad-lifecycle.js';
import { withAdAttemptScopes } from '../src/ad-attempt-scope.js';

function fixture(callbacks = {}) {
  const timers = new Map();
  const events = [];
  let id = 0;
  const lifecycle = withAdAttemptScopes(createAdLifecycle, {
    name: 'Rewarded', lateRewardGraceMs: 600,
    setTimeoutFn: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeoutFn: (key) => timers.delete(key),
    callbacks: {
      onLoaded: () => events.push('loaded'),
      onLoadFailed: () => events.push('load-failed'),
      onShown: () => events.push('shown'),
      onShowFailed: () => events.push('failed'),
      onClosed: () => events.push('closed'),
      onRewarded: () => events.push('reward'),
      ...callbacks,
    },
  });
  return {
    lifecycle, events,
    expire(ms) {
      for (const [key, timer] of [...timers]) {
        if (timer.ms === ms) { timers.delete(key); timer.fn(); }
      }
    },
    show() {
      assert.equal(lifecycle.beginLoad(), true);
      lifecycle.captureLoad().loadSucceeded();
      assert.equal(lifecycle.beginShow(), true);
      return lifecycle.captureShow();
    },
  };
}

test('expired show callbacks cannot reward, close or fail its replacement', () => {
  const f = fixture();
  const old = f.show();
  f.expire(5000);
  const current = f.show();
  const before = [...f.events];
  for (const method of ['showStarted', 'rewardEarned', 'showClosed', 'showFailed']) {
    assert.equal(old[method](new Error('old reply')), false);
  }
  assert.deepEqual(f.events, before);
  assert.equal(current.rewardEarned(), true);
  assert.equal(current.showClosed(), true);
  assert.deepEqual(f.events.slice(-3), ['shown', 'reward', 'closed']);
});

test('expired load replies cannot settle the next load', () => {
  const f = fixture();
  f.lifecycle.beginLoad();
  const old = f.lifecycle.captureLoad();
  f.expire(30000);
  f.lifecycle.beginLoad();
  assert.equal(old.loadSucceeded(), false);
  assert.equal(old.loadFailed(new Error('old')), false);
  assert.equal(f.lifecycle.captureLoad().loadSucceeded(), true);
  assert.deepEqual(f.events, ['load-failed', 'loaded']);
});

test('reward grace belongs to the closing show and invalidates after completion', () => {
  const f = fixture(); const show = f.show();
  show.showStarted(); show.showClosed();
  assert.equal(show.isCurrent(), true);
  assert.equal(show.rewardEarned(), true);
  assert.equal(show.isCurrent(), false);
  assert.equal(show.rewardEarned(), false);
});

test('dismissal watchdog invalidates the attempt after grace expires', () => {
  const f = fixture(); const show = f.show();
  show.showStarted(); f.expire(120000); f.expire(600);
  assert.equal(show.isCurrent(), false);
  assert.equal(show.rewardEarned(), false);
});

test('refused concurrent show preserves the accepted handle', () => {
  const f = fixture(); const show = f.show();
  assert.equal(f.lifecycle.beginShow(), false);
  assert.equal(show.rewardEarned(), true);
});

test('synchronous failure callback can open a new show without losing its scope', () => {
  let replacement;
  const f = fixture({ onShowFailed: () => { replacement = f.show(); } });
  assert.equal(f.lifecycle.beginShow(), false);
  assert.equal(replacement.isCurrent(), true);
  assert.equal(replacement.rewardEarned(), true);
});

test('capture before any attempt is inert', () => {
  const f = fixture(); const show = f.lifecycle.captureShow();
  f.show();
  assert.equal(show.isCurrent(), false);
  assert.equal(show.rewardEarned(), false);
});
