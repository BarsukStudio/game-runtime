/**
 * The load/show/reward state machine an ad format is driven through.
 *
 * Providers are unreliable in different ways: one can answer a single load
 * attempt twice, one can deliver a reward after the dismissal, and any of them
 * can go silent between the show call and the presentation. The game reacts to
 * each terminal outcome exactly once — it resumes music, restarts timers, grants
 * a reward — so a duplicate or a missing one is a bug the player sees. This
 * module is what turns whatever a provider emits into exactly one outcome per
 * attempt.
 *
 * It is passive: it calls no SDK, shows nothing, and decides nothing about when
 * an ad is appropriate. The caller drives it, and every phase carries a watchdog
 * so a silent provider still ends the attempt instead of pausing the game for
 * the rest of the session.
 *
 * Headless on purpose: no SDK import, no DOM, no storage, and no ambient timers.
 * Ad units, placements, reward amounts and the policy about when to show stay in
 * the game.
 *
 * @module @barsuk/game-runtime/ad-lifecycle
 */

/** How long one load attempt may run before the lifecycle fails it. */
export const AD_LOAD_TIMEOUT_MS = 30000;

/** How long a show may wait for the provider to report presentation. */
export const AD_PRESENTATION_TIMEOUT_MS = 5000;

/** How long a presented ad may stay open before the lifecycle closes it. */
export const AD_DISMISSAL_TIMEOUT_MS = 120000;

/**
 * How long a dismissed rewarded ad still accepts its reward. Only rewarded
 * formats pass it; an interstitial has no reward to wait for. Paid on every
 * close without a reward, so it stays short enough not to read as a stall.
 */
export const AD_LATE_REWARD_GRACE_MS = 600;

/**
 * A timeout budget, or a function that returns one when the budget is read.
 *
 * @typedef {number | (() => number)} TimeoutBudget
 */

/**
 * What the game is told, and the only way anything leaves this module.
 *
 * Every entry is optional: a format with no reward passes no `onRewarded`, and
 * a caller that has nothing to do with an outcome simply leaves it out.
 *
 * A provider error is whatever the SDK raised. Usually an `Error`, but a native
 * bridge can reject with a plain object or a string, and this module forwards
 * it untouched instead of normalising it — only the errors it raises itself are
 * guaranteed to be `Error`s.
 *
 * @typedef {object} AdLifecycleCallbacks
 * @property {(payload?: unknown) => void} [onLoaded] An ad is ready to show.
 * @property {(error: unknown) => void} [onLoadFailed] The attempt is over with nothing to show.
 * @property {() => void} [onShown] The provider reported presentation.
 * @property {(error: unknown) => void} [onShowFailed] The show ended without ever presenting.
 * @property {() => void} [onClosed] The ad is gone and the game may resume.
 * @property {(payload?: unknown) => void} [onRewarded] A reward was granted, at most once per show.
 */

/**
 * The passive state machine an ad format is driven through.
 *
 * Every method reports whether it owned the signal it was given. `false` means
 * the machine was in a phase where that signal has no meaning — a duplicate, or
 * one that belongs to an attempt that is already over — and a caller must never
 * read it as a terminal outcome of its own.
 *
 * @typedef {object} AdLifecycle
 * @property {() => boolean} beginLoad Opens a load attempt and arms its watchdog.
 * @property {(payload?: unknown) => boolean} loadSucceeded Reports a loaded ad.
 * @property {(error: unknown) => boolean} loadFailed Reports a failed load attempt.
 * @property {() => boolean} beginShow Claims the machine for one show attempt.
 * @property {() => boolean} showStarted Reports that the provider presented the ad.
 * @property {(error: unknown) => boolean} showFailed Reports a show that cannot complete.
 * @property {() => boolean} showClosed Reports a dismissal.
 * @property {(payload?: unknown) => boolean} rewardEarned Reports a granted reward.
 */

// Every timeout may be a number or a function returning one, because the right
// budget depends on the provider that is only chosen at init time.
function resolveTimeout(value) {
  return typeof value === 'function' ? value() : value;
}

/**
 * Builds the lifecycle both ad formats report into.
 *
 * It owns no SDK: every provider signal arrives as a call and every terminal
 * outcome leaves through a callback, so the same machine serves a native and a
 * portal provider. Each phase carries a watchdog, which is why a silent
 * provider still ends the attempt instead of pausing the game forever.
 *
 * @param {object} options
 * @param {string} options.name Format name, used in the errors it raises itself.
 * @param {AdLifecycleCallbacks} options.callbacks Where every terminal outcome goes.
 * @param {TimeoutBudget} [options.loadTimeoutMs]
 * @param {TimeoutBudget} [options.presentationTimeoutMs]
 * @param {TimeoutBudget} [options.dismissalTimeoutMs]
 * @param {TimeoutBudget} [options.lateRewardGraceMs] Zero for a format with no reward.
 * @param {(handler: () => void, delayMs: number) => unknown} options.setTimeoutFn
 * @param {(timer: unknown) => void} options.clearTimeoutFn
 * @returns {AdLifecycle}
 * @throws {Error} When the timers are missing.
 */
export function createAdLifecycle({
  name,
  callbacks,
  loadTimeoutMs = AD_LOAD_TIMEOUT_MS,
  presentationTimeoutMs = AD_PRESENTATION_TIMEOUT_MS,
  dismissalTimeoutMs = AD_DISMISSAL_TIMEOUT_MS,
  lateRewardGraceMs = 0,
  setTimeoutFn,
  clearTimeoutFn,
}) {
  // Timers are a dependency, never an ambient global: a game embeds this in a
  // WebView, a test drives it on a fake clock, and neither may depend on which
  // host timer happens to be reachable from the module.
  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new Error('Ad lifecycle requires setTimeoutFn and clearTimeoutFn.');
  }

  const state = {
    loading: false,
    ready: false,
    showPhase: 'idle',
    rewardDelivered: false,
    loadTimer: null,
    presentationTimer: null,
    dismissalTimer: null,
    graceTimer: null,
  };

  function clearTimer(key) {
    if (state[key] === null) return;
    clearTimeoutFn(state[key]);
    state[key] = null;
  }

  function beginLoad() {
    if (state.loading || state.ready) return false;
    state.loading = true;
    state.loadTimer = setTimeoutFn(() => {
      loadFailed(new Error(`${name} did not finish loading`));
    }, resolveTimeout(loadTimeoutMs));
    return true;
  }

  function loadSucceeded(payload) {
    if (!state.loading) return false;
    clearTimer('loadTimer');
    state.loading = false;
    state.ready = true;
    callbacks.onLoaded?.(payload);
    return true;
  }

  function loadFailed(error) {
    // Native SDKs can both emit FailedToLoad and reject the same Promise. Only
    // the first signal owns this load attempt; later duplicates are ignored.
    if (!state.loading) return false;
    clearTimer('loadTimer');
    state.loading = false;
    state.ready = false;
    callbacks.onLoadFailed?.(error);
    return true;
  }

  function showFailed(error) {
    if (state.showPhase === 'idle') return false;
    // Once the provider reported presentation, a later error is no longer a
    // failed show. Close the shown attempt so rewarded flows cannot grant their
    // failure fallback after a real reward was already delivered. An error is
    // terminal on its own, so it closes directly instead of going through
    // showClosed(): a show that failed has no reward on its way, whether the
    // error arrives during the show or inside a grace window already open.
    if (state.showPhase === 'shown' || state.showPhase === 'closing') {
      return completeClose();
    }
    clearTimer('presentationTimer');
    clearTimer('dismissalTimer');
    state.showPhase = 'idle';
    state.ready = false;
    callbacks.onShowFailed?.(error);
    return true;
  }

  function beginShow() {
    // A concurrent second call gets no callback on purpose: the terminal outcome
    // belongs to the attempt that is already in flight, and firing a second one
    // would let the game act twice on a single ad. Callers must not treat this
    // `false` as "the show failed" — the in-flight attempt still reports one of
    // shown/failed/closed, and its watchdogs guarantee that it arrives.
    if (state.showPhase !== 'idle') return false;
    state.showPhase = 'pending';
    state.rewardDelivered = false;

    if (!state.ready) {
      showFailed(new Error(`${name} is not ready`));
      return false;
    }

    state.ready = false;
    state.presentationTimer = setTimeoutFn(() => {
      showFailed(new Error(`${name} did not report presentation`));
    }, resolveTimeout(presentationTimeoutMs));
    return true;
  }

  function showStarted() {
    if (state.showPhase !== 'pending') return false;
    clearTimer('presentationTimer');
    state.showPhase = 'shown';
    // Arm the dismissal watchdog before handing control to the game: a callback
    // that closes the ad synchronously must be able to clear this timer.
    state.dismissalTimer = setTimeoutFn(() => {
      showClosed();
    }, resolveTimeout(dismissalTimeoutMs));
    callbacks.onShown?.();
    return true;
  }

  // The close itself, once nothing can still change this show's outcome.
  function completeClose() {
    clearTimer('presentationTimer');
    clearTimer('dismissalTimer');
    clearTimer('graceTimer');
    state.showPhase = 'idle';
    state.ready = false;
    callbacks.onClosed?.();
    return true;
  }

  function showClosed() {
    if (state.showPhase === 'pending') {
      return showFailed(new Error(`${name} closed before reporting presentation`));
    }
    if (state.showPhase !== 'shown') return false;
    // A provider may report the reward before the dismissal or after it, and
    // this module is not told which — the caller sets the budget. Closing on the
    // dismissal alone would move the machine to idle and refuse a reward that is
    // still on its way, losing the grant of a fully watched ad. A caller that
    // has to allow for the later order therefore passes a non-zero window, and
    // that window becomes the only thing that can still end this show — the
    // other watchdogs go now. The budget is read here, not at creation, because
    // the caller may only learn which provider it got at init.
    const graceMs = resolveTimeout(lateRewardGraceMs);
    if (graceMs > 0 && !state.rewardDelivered) {
      clearTimer('presentationTimer');
      clearTimer('dismissalTimer');
      state.showPhase = 'closing';
      state.graceTimer = setTimeoutFn(() => {
        state.graceTimer = null;
        completeClose();
      }, graceMs);
      return true;
    }
    return completeClose();
  }

  function rewardEarned(payload) {
    // A reward is proof that an ad was presented even if a provider omitted its
    // separate shown event. Promote the attempt before delivering the reward.
    if (state.showPhase === 'pending') showStarted();
    if (state.showPhase !== 'shown' && state.showPhase !== 'closing') return false;
    if (state.rewardDelivered) return false;
    state.rewardDelivered = true;
    callbacks.onRewarded?.(payload);
    // A reward that landed inside the grace window already has its dismissal,
    // so finish the close now instead of waiting the window out.
    if (state.showPhase === 'closing') completeClose();
    return true;
  }

  return {
    beginLoad,
    loadSucceeded,
    loadFailed,
    beginShow,
    showStarted,
    showFailed,
    showClosed,
    rewardEarned,
  };
}
