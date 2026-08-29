// Merged from the two consumers of this logic: gym2's
// scripts/ad-lifecycle-test.mjs (canonical source — the only suite that owned
// the machine outright) and the lifecycle blocks of Muscle Clicker's
// scripts/ad-wiring-contract-test.mjs, which contributed the cases about which
// watchdog is armed and with which budget.
//
// What these pin is the machine's own behaviour for a given sequence of calls,
// driven on a hand-run clock. Which sequences a real provider emits is not
// pinned here and is not proven by these tests: neither consumer has an ad
// provider trace recorded against a named SDK version, and the ordering a
// mediated network uses is a caller's assumption, expressed as the grace budget
// it passes. Both orders are supported, and each is exercised below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AD_DISMISSAL_TIMEOUT_MS,
  AD_LATE_REWARD_GRACE_MS,
  AD_LOAD_TIMEOUT_MS,
  AD_PRESENTATION_TIMEOUT_MS,
  createAdLifecycle,
} from '../src/ad-lifecycle.js';

// A clock the case runs by hand. It answers two different questions, because the
// two source suites asked two different ones: `advance` proves a budget is spent
// where it should be, and `delays`/`fireOnlyTimer` prove *which* watchdog is
// armed without committing the case to a number.
function createClock() {
  const timers = new Map();
  let nextId = 1;
  let now = 0;
  return {
    setTimeoutFn(callback, delay = 0) {
      const id = nextId++;
      timers.set(id, { callback, delay, at: now + delay });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    // Fires everything due, in the order it came due, including timers armed by
    // a callback that just ran.
    advance(ms) {
      now += ms;
      let ran = true;
      while (ran) {
        ran = false;
        for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
          if (timer.at > now || !timers.has(id)) continue;
          timers.delete(id);
          timer.callback();
          ran = true;
        }
      }
    },
    // The single timer that must be armed right now, fired without moving the
    // clock.
    fireOnlyTimer() {
      assert.equal(timers.size, 1, 'expected exactly one armed timer');
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
    },
    armed: () => timers.size,
    delays: () => [...timers.values()].map((timer) => timer.delay),
  };
}

// One lifecycle plus the log of what the caller was told, in order. A payload is
// recorded with its outcome; an outcome without one is recorded as a bare name,
// so a case can assert the whole conversation with a single deepEqual.
function createSubject(options = {}) {
  const clock = createClock();
  const events = [];
  const record = (name) => (payload) => events.push(payload === undefined ? name : [name, payload]);
  const lifecycle = createAdLifecycle({
    name: 'Test ad',
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    callbacks: {
      onLoaded: record('loaded'),
      onLoadFailed: () => events.push('loadFailed'),
      onShown: record('shown'),
      onShowFailed: () => events.push('showFailed'),
      onClosed: record('closed'),
      onRewarded: record('rewarded'),
    },
    ...options,
  });
  // A loaded ad, ready to show — the starting point of most cases below.
  const load = () => {
    lifecycle.beginLoad();
    lifecycle.loadSucceeded();
    events.length = 0;
  };
  return { lifecycle, clock, events, load };
}

test('the timers are required at construction', () => {
  // Timers are a dependency, never an ambient global. A lifecycle that fell back
  // to whatever setTimeout its module can reach would look correct in this suite
  // and drive the wrong clock inside a WebView, so a missing one fails here
  // rather than being defaulted away.
  for (const timers of [
    {},
    { setTimeoutFn: createClock().setTimeoutFn },
    { clearTimeoutFn: createClock().clearTimeoutFn },
  ]) {
    assert.throws(
      () => createAdLifecycle({ name: 'Test ad', callbacks: {}, ...timers }),
      { name: 'Error', message: /requires setTimeoutFn and clearTimeoutFn/ },
      'the lifecycle must refuse to build without both injected timers',
    );
  }
});

test('a load that already answered owns its attempt', () => {
  // A provider can answer one attempt twice — an event and a settled promise for
  // the same load. The caller must not be told twice.
  const { lifecycle, events } = createSubject();
  assert.equal(lifecycle.beginLoad(), true);
  assert.equal(lifecycle.loadSucceeded(), true);
  assert.equal(lifecycle.loadSucceeded(), false, 'a second load answer is not a second load');
  assert.equal(lifecycle.loadFailed(new Error('late')), false, 'a late failure cannot undo a load');
  assert.deepEqual(events, ['loaded']);
});

test('only the first failure of a load attempt reaches the caller', () => {
  const { lifecycle, events, clock } = createSubject();
  lifecycle.beginLoad();
  assert.equal(lifecycle.loadFailed(new Error('first')), true);
  assert.equal(lifecycle.loadFailed(new Error('second')), false, 'only the first signal owns the attempt');
  assert.deepEqual(events, ['loadFailed']);
  assert.equal(clock.armed(), 0, 'a failed load must leave no watchdog behind');
});

test('a load in flight and a loaded ad are not reloaded', () => {
  // The caller's preloads dispatch on this answer, and a second request would
  // arm a second watchdog against one provider call.
  const { lifecycle } = createSubject();
  assert.equal(lifecycle.beginLoad(), true);
  assert.equal(lifecycle.beginLoad(), false, 'a load in flight is not restarted');
  lifecycle.loadSucceeded();
  assert.equal(lifecycle.beginLoad(), false, 'a loaded ad is not reloaded');
});

test('a show already in flight keeps its own terminal outcome', () => {
  const { lifecycle, events, load } = createSubject();
  load();
  assert.equal(lifecycle.beginShow(), true);
  assert.equal(lifecycle.beginShow(), false, 'a concurrent show must not start a second attempt');
  assert.deepEqual(events, [], 'the refused call must not report a failure of its own');
  lifecycle.showStarted();
  assert.equal(lifecycle.showStarted(), false, 'a repeated presentation event is not a second show');
  lifecycle.showClosed();
  assert.equal(lifecycle.showClosed(), false, 'a repeated dismissal is not a second close');
  assert.deepEqual(events, ['shown', 'closed']);
});

test('showing an ad that never loaded fails immediately', () => {
  const { lifecycle, events, clock } = createSubject();
  assert.equal(lifecycle.beginShow(), false);
  assert.deepEqual(events, ['showFailed']);
  assert.equal(clock.armed(), 0, 'a refused show must leave no watchdog behind');
});

test('a provider that takes the show call and goes silent still ends the attempt', () => {
  const { lifecycle, events, clock, load } = createSubject();
  load();
  lifecycle.beginShow();
  clock.advance(AD_PRESENTATION_TIMEOUT_MS - 1);
  assert.deepEqual(events, [], 'the budget must not expire early');
  clock.advance(1);
  assert.deepEqual(events, ['showFailed']);
  assert.equal(clock.armed(), 0);
});

test('a presentation that arrived disarms the presentation watchdog', () => {
  // A slow ad the player is already watching must not be reported as failed.
  const { lifecycle, events, clock, load } = createSubject();
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  clock.advance(AD_PRESENTATION_TIMEOUT_MS * 10);
  assert.deepEqual(events, ['shown'], 'a shown ad must not fail on the presentation budget');
});

test('the presentation budget is read when the show starts', () => {
  // The right budget depends on the provider, which the caller may only choose
  // at init — long after the lifecycle was built.
  let budget = 200;
  const { lifecycle, events, clock, load } = createSubject({ presentationTimeoutMs: () => budget });
  load();
  budget = 400;
  lifecycle.beginShow();
  assert.deepEqual(clock.delays(), [400], 'the watchdog must use the current budget');
  clock.advance(200);
  assert.deepEqual(events, [], 'the budget is read when the show starts, not at creation');
  clock.advance(200);
  assert.deepEqual(events, ['showFailed']);
});

test('an ad that opened and was never dismissed still ends', () => {
  const { lifecycle, events, clock, load } = createSubject();
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  clock.advance(AD_DISMISSAL_TIMEOUT_MS - 1);
  assert.deepEqual(events, ['shown']);
  clock.advance(1);
  assert.deepEqual(events, ['shown', 'closed']);
  assert.equal(clock.armed(), 0);
});

test('the dismissal watchdog is armed before the caller is told', () => {
  // A callback that closes the ad synchronously must be able to clear this
  // timer; arming it afterwards would leave one behind for the session.
  const clock = createClock();
  let lifecycle;
  lifecycle = createAdLifecycle({
    name: 'Test ad',
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    callbacks: { onShown: () => lifecycle.showClosed() },
  });
  lifecycle.beginLoad();
  lifecycle.loadSucceeded();
  lifecycle.beginShow();
  lifecycle.showStarted();
  assert.equal(clock.armed(), 0, 'a synchronous close must not leave the dismissal watchdog armed');
});

test('a dismissal before any presentation is a failed show', () => {
  // The caller never paused for it, so it did not close — it never opened.
  const { lifecycle, events, load } = createSubject();
  load();
  lifecycle.beginShow();
  assert.equal(lifecycle.showClosed(), true);
  assert.deepEqual(events, ['showFailed']);
});

test('a reward inside the grace window is still delivered, and ends the close', () => {
  const { lifecycle, events, clock, load } = createSubject({
    lateRewardGraceMs: () => AD_LATE_REWARD_GRACE_MS,
  });
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  lifecycle.showClosed();
  assert.deepEqual(events, ['shown'], 'the close waits for the reward window');
  assert.deepEqual(
    clock.delays(),
    [AD_LATE_REWARD_GRACE_MS],
    'the grace window replaces the other watchdogs',
  );
  assert.equal(lifecycle.rewardEarned(), true);
  assert.deepEqual(events, ['shown', 'rewarded', 'closed'], 'the grant must land before the close');
  assert.equal(clock.armed(), 0, 'the grace timer must not outlive the close it opened');
});

test('a grace window that expires closes the show unrewarded', () => {
  const { lifecycle, events, clock, load } = createSubject({
    lateRewardGraceMs: () => AD_LATE_REWARD_GRACE_MS,
  });
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  lifecycle.showClosed();
  clock.advance(AD_LATE_REWARD_GRACE_MS);
  assert.deepEqual(events, ['shown', 'closed']);
  assert.equal(lifecycle.rewardEarned(), false, 'a reward after the window is refused');
  assert.deepEqual(events, ['shown', 'closed']);
  assert.equal(clock.armed(), 0);
});

test('no show may start while a grace window is open', () => {
  const { lifecycle, load } = createSubject({ lateRewardGraceMs: AD_LATE_REWARD_GRACE_MS });
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  lifecycle.showClosed();
  assert.equal(lifecycle.beginShow(), false, 'a show must not start while the window is open');
});

test('an error inside the grace window closes rather than fails', () => {
  const { lifecycle, events, clock, load } = createSubject({
    lateRewardGraceMs: AD_LATE_REWARD_GRACE_MS,
  });
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  lifecycle.showClosed();
  assert.equal(lifecycle.showFailed(new Error('late provider error')), true);
  assert.deepEqual(events, ['shown', 'closed'], 'an error in the window must close, not fail');
  assert.equal(clock.armed(), 0, 'an error must clear the grace window');
});

test('a reward that arrived before the dismissal closes at once', () => {
  // Nothing is left to wait for, so the window is never opened.
  const { lifecycle, events, clock, load } = createSubject({
    lateRewardGraceMs: AD_LATE_REWARD_GRACE_MS,
  });
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  lifecycle.rewardEarned();
  lifecycle.showClosed();
  assert.deepEqual(events, ['shown', 'rewarded', 'closed'], 'a rewarded show must close immediately');
  assert.equal(clock.armed(), 0);
});

test('a zero grace closes immediately', () => {
  // A format with no reward, and every caller whose provider reports the reward
  // through the show call's own result, must not be delayed by a window it has
  // nothing to wait for.
  const { lifecycle, events, clock, load } = createSubject();
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  lifecycle.showClosed();
  assert.deepEqual(events, ['shown', 'closed'], 'a zero grace closes immediately');
  assert.equal(clock.armed(), 0);
});

test('the grace budget is read when the show closes', () => {
  // One lifecycle, two shows, and a budget the caller changes in between: the
  // provider it applies to is only known after init.
  let grace = 0;
  const { lifecycle, events, clock, load } = createSubject({ lateRewardGraceMs: () => grace });
  const runShow = () => {
    load();
    lifecycle.beginShow();
    lifecycle.showStarted();
    lifecycle.showClosed();
  };

  runShow();
  assert.deepEqual(events, ['shown', 'closed'], 'a zero budget must close at once');
  assert.equal(clock.armed(), 0, 'a zero budget must not open a window');

  grace = 600;
  events.length = 0;
  runShow();
  assert.deepEqual(events, ['shown'], 'the deferred close must wait for its window');
  assert.deepEqual(clock.delays(), [600], 'the grace budget must be read when the show closes');
});

test('one reward per show, whatever the provider repeats', () => {
  const { lifecycle, events, load } = createSubject();
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  assert.equal(lifecycle.rewardEarned('first'), true);
  assert.equal(lifecycle.rewardEarned('second'), false, 'a repeated reward event grants nothing');
  lifecycle.showClosed();
  assert.deepEqual(events, ['shown', ['rewarded', 'first'], 'closed']);
});

test('a reward promotes a show whose presentation was never reported', () => {
  // A reward is proof the ad was presented, even from a provider that omitted
  // its shown event: the caller still owes the player the pause and the grant.
  const { lifecycle, events, load } = createSubject();
  load();
  lifecycle.beginShow();
  assert.equal(lifecycle.rewardEarned(), true);
  assert.deepEqual(events, ['shown', 'rewarded'], 'a reward promotes a pending show');
});

test('an error after presentation closes, and the closed show refuses a later reward', () => {
  // A rewarded caller must not run its failure fallback on top of a reward it
  // already delivered, and an error is terminal on its own: a show that failed
  // has no reward on its way.
  const { lifecycle, events, clock, load } = createSubject({
    lateRewardGraceMs: AD_LATE_REWARD_GRACE_MS,
  });
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  assert.equal(lifecycle.showFailed(new Error('provider error after presentation')), true);
  assert.deepEqual(events, ['shown', 'closed'], 'an error after presentation must close at once');
  assert.equal(clock.armed(), 0, 'an error after presentation must not open a window');
  assert.equal(lifecycle.rewardEarned(), false, 'a closed show must refuse a later reward');
});

test('an error after a delivered reward closes rather than fails', () => {
  const { lifecycle, events, load } = createSubject();
  load();
  lifecycle.beginShow();
  lifecycle.showStarted();
  lifecycle.rewardEarned();
  assert.equal(lifecycle.showFailed(new Error('late error')), true);
  assert.deepEqual(events, ['shown', 'rewarded', 'closed'], 'a late error closes rather than fails');
});

test('a load the provider never answers becomes a failure, and may be retried', () => {
  const { lifecycle, events, clock } = createSubject();
  lifecycle.beginLoad();
  clock.advance(AD_LOAD_TIMEOUT_MS - 1);
  assert.deepEqual(events, []);
  clock.advance(1);
  assert.deepEqual(events, ['loadFailed']);
  assert.equal(clock.armed(), 0);
  assert.equal(lifecycle.beginLoad(), true, 'a timed-out load may be retried');
});

test('each phase has exactly one watchdog, and it is the phase that owns it', () => {
  // The whole ladder in one pass: a silent load, a silent presentation, and a
  // rewarded show ended by an error — each answered by the timer of its own
  // phase and no other.
  const { lifecycle, events, clock } = createSubject();

  lifecycle.beginLoad();
  assert.deepEqual(clock.delays(), [AD_LOAD_TIMEOUT_MS]);
  clock.fireOnlyTimer();
  assert.deepEqual(events, ['loadFailed']);

  lifecycle.beginLoad();
  lifecycle.loadSucceeded();
  lifecycle.beginShow();
  assert.deepEqual(clock.delays(), [AD_PRESENTATION_TIMEOUT_MS]);
  clock.fireOnlyTimer();
  assert.deepEqual(events, ['loadFailed', 'loaded', 'showFailed']);

  lifecycle.beginLoad();
  lifecycle.loadSucceeded();
  lifecycle.beginShow();
  lifecycle.rewardEarned();
  lifecycle.rewardEarned();
  assert.deepEqual(clock.delays(), [AD_DISMISSAL_TIMEOUT_MS], 'a promoted show holds the dismissal watchdog');
  lifecycle.showFailed(new Error('late provider error'));
  assert.equal(clock.armed(), 0);
  assert.deepEqual(events, [
    'loadFailed',
    'loaded',
    'showFailed',
    'loaded',
    'shown',
    'rewarded',
    'closed',
  ]);
});

test('the module reaches for nothing hard rule 1 forbids', () => {
  // The owner-side half of the injected timers: the case above proves a missing
  // one throws, and this proves nothing quietly took its place. A returned
  // default is only the loudest way to break the rule — an ambient `Date.now`,
  // a storage read or an SDK import would all pass every behavioural case in
  // this file, because the fake clock never notices them.
  //
  // Read off the code, not the prose: this module's comments talk about the
  // grace *window* and about which host timer is reachable, and a check that
  // mistook either for a reach would be a check about English. Comments go
  // first — a comment cannot reach for anything. Not a ban on imports either: a
  // relative import of another headless primitive is allowed, and only what the
  // rule names is checked.
  const source = readFileSync(
    fileURLToPath(new URL('../src/ad-lifecycle.js', import.meta.url)),
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
    /\brequestAnimationFrame\b/,
    /\bglobalThis\b/,
    /\bCapacitor\b/,
    /\bAdMob\b/,
    /\bYandexAds\b/,
    /\bYaGames\b/,
    /\bCrazyGames\b/,
    /\bimport\s*\(/,
    /\bimport\s*['"][^.]/,
    /\bfrom\s*['"][^.]/,
  ]) {
    assert.doesNotMatch(code, forbidden, `hard rule 1: ${forbidden}`);
  }
  // The stripper has to leave something to check: an empty haystack would make
  // every assertion above pass for the wrong reason.
  assert.match(code, /export function createAdLifecycle\(/, 'the code survived comment stripping');
});
