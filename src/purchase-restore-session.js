/**
 * A restore is not over when `store.restorePurchases()` resolves.
 *
 * The store call only asks the platform to replay the transactions; the answer
 * arrives later as `approved` → `verified` → delivery, plus `receiptUpdated` for
 * the entitlement itself. Deciding the message inside the `.then()` of that call
 * tells the player "Nothing to restore" moments before the purchase lands, and
 * reading a single "did the entitlement arrive" flag misses a consumable that
 * was paid for but never granted.
 *
 * This session watches the whole restore instead:
 *
 *     restore call settled
 *   + the store loaded its receipts at least once (or something was restored)
 *   + no verification or delivery still running
 *   + a quiet period since the last event
 *   + a minimum observation window after the call settled
 *
 * and only then decides. After the store call settles, a timeout bounds receipt
 * processing — and a timeout is deliberately *not* "nothing to restore": the
 * game must not claim the player owns nothing when it simply never heard back.
 *
 * **On the limits of "nothing".** There is no per-restore completion event to
 * wait for. In cordova-plugin-purchase the store-level `receiptsReady` is
 * one-shot (`Callbacks(..., finalStateMode)`), so it has long since fired by the
 * time a player taps Restore, and on Google Play a restore that finds nothing
 * emits no receipt event at all — `onPurchasesUpdated([])` iterates an empty
 * list. Requiring a fresh store signal before saying "nothing" would therefore
 * turn the most common outcome into a hard timeout. What the platforms do
 * guarantee is ordering: the App Store adapter resolves `restorePurchases()`
 * only after `refreshReceipts()`, Google Play only after the `setPurchases`
 * callback, and both feed `approved` from that same refresh — with a 300 ms
 * debounce on the Apple side. The observation window is sized for that chain,
 * and every event restarts the quiet period, so a delivery that has started can
 * never be cut off. A store that dispatches its first `approved` more than a
 * full window after resolving would still slip through; nothing available in the
 * plugin can close that gap, and it is the reason restore stays a device test.
 *
 * **Store authentication is not processing.** The processing timeout starts
 * only once the store call settles. On iOS the call includes the player typing
 * an Apple ID password, which Muscle Clicker's device QA on iOS 15 showed
 * outlasting a 20-second budget measured from the tap — the session closed as a
 * timeout and the store's eventual answer was discarded.
 *
 * Headless on purpose: no DOM, no SDK, no product knowledge and no ambient
 * timers. The caller supplies the restore call, the entitlement reader and the
 * timers; which product the entitlement is about stays in the game.
 *
 * @module @barsuk/game-runtime/purchase-restore-session
 */

/** How a restore session ended. */
export const RESTORE_STATUS = Object.freeze({
  RESTORED: 'restored',
  NOTHING: 'nothing',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
});

/**
 * Covers the plugin's 300 ms receipt debounce plus a native round trip, at the
 * cost of showing "Restoring…" that long when there is nothing to restore.
 */
export const DEFAULT_RESTORE_SETTLE_WINDOW_MS = 2500;

/** How long the session waits after the last event before it may decide. */
export const DEFAULT_RESTORE_QUIET_MS = 1500;

/**
 * Bounds processing after the store responds, including a stuck delivery.
 * Store authentication is user-paced and must not consume this budget.
 */
export const DEFAULT_RESTORE_TIMEOUT_MS = 20000;

function positiveMs(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Normalises what a restore call answered into an error, or null.
 *
 * `store.restorePurchases()` resolves with an IError instead of rejecting, so a
 * failed restore looks exactly like a successful one to the caller.
 *
 * @param {unknown} value
 * @returns {Error | null}
 */
export function toRestoreError(value) {
  if (!value) return null;
  if (value instanceof Error) return value;
  if (typeof value === 'object' && (value.code !== undefined || value.message !== undefined)) {
    const error = new Error(String(value.message ?? 'Purchase restore failed.'));
    if (value.code !== undefined) error.code = value.code;
    return error;
  }
  return new Error(String(value));
}

/**
 * The store's answer about the one entitlement the game restores.
 *
 * `receiptsLoaded` is not a confirmation of *this* restore — no such signal
 * exists (see the module note). It only says the store ever completed a receipt
 * load, which is what separates "the store says nothing is owned" from "the
 * store never started".
 *
 * @typedef {object} RestoreEntitlement
 * @property {boolean} owned
 * @property {boolean} receiptsLoaded
 */

/**
 * @typedef {object} RestoredDelivery
 * @property {string} transactionId
 * @property {string} productId
 */

/**
 * @typedef {object} RestoreResult
 * @property {'restored' | 'nothing' | 'failed' | 'timeout'} status
 * @property {boolean} owned The entitlement as the store answered it at the end.
 * @property {RestoredDelivery[]} deliveredTransactions Granted and recorded during this session.
 * @property {Error | null} error The first error of the flow, or the timeout.
 */

/**
 * @typedef {object} PurchaseRestoreSessionOptions
 * @property {(handler: () => void, delayMs: number) => unknown} setTimeoutFn Required.
 * @property {(timer: unknown) => void} clearTimeoutFn Required.
 * @property {() => RestoreEntitlement} [readEntitlement] Defaults to "owns
 *   nothing, receipts loaded" for a game with no entitlement to restore.
 * @property {(message: string, detail?: unknown) => void} [onWarn]
 * @property {number} [settleWindowMs]
 * @property {number} [quietMs]
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {object} PurchaseRestoreSession
 * @property {(restoreCall: () => unknown) => Promise<RestoreResult>} run
 *   Runs the store call once and resolves with the session result.
 * @property {(delivery: RestoredDelivery) => boolean} noteDelivered
 *   A transaction granted and written to the ledger during this session.
 * @property {(cause: unknown) => boolean} noteError
 *   Anything that went wrong anywhere in the restore.
 * @property {() => boolean} noteActivity
 *   Any store event that can still change the outcome.
 * @property {(label: string) => boolean} beginActivity
 *   Opens a bracket around work the session must outlive.
 * @property {(label: string) => boolean} endActivity
 *   Closes one bracket opened under the same label.
 * @property {() => boolean} isFinished
 */

/**
 * Creates one restore session. A session runs exactly one restore.
 *
 * @param {PurchaseRestoreSessionOptions} options
 * @returns {PurchaseRestoreSession}
 * @throws {Error} When the timers are missing.
 */
export function createPurchaseRestoreSession(options = {}) {
  const { setTimeoutFn, clearTimeoutFn } = options;
  // Timers are a dependency, never an ambient global: a game embeds this in a
  // WebView, a test drives it on a fake clock, and neither may depend on which
  // host timer happens to be reachable from the module.
  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new Error('Purchase restore session requires setTimeoutFn and clearTimeoutFn.');
  }
  const readEntitlement = typeof options.readEntitlement === 'function'
    ? options.readEntitlement
    : () => ({ owned: false, receiptsLoaded: true });
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {};

  const settleWindowMs = positiveMs(options.settleWindowMs, DEFAULT_RESTORE_SETTLE_WINDOW_MS);
  const quietMs = positiveMs(options.quietMs, DEFAULT_RESTORE_QUIET_MS);
  const timeoutMs = positiveMs(options.timeoutMs, DEFAULT_RESTORE_TIMEOUT_MS);

  // Only transactions actually granted *and* written to the ledger during this
  // session. A transaction the store replayed but the ledger already knew is not
  // a restoration, even though it is finished again.
  const delivered = new Map();
  const activities = new Map();

  let started = false;
  let finished = false;
  let restoreSettled = false;
  let settleWindowElapsed = false;
  // No activity yet means the quiet period is trivially satisfied.
  let quietElapsed = true;
  let timedOut = false;
  let error = null;

  let quietTimerId = null;
  let settleTimerId = null;
  let timeoutTimerId = null;

  let resolveResult = null;
  const promise = new Promise((resolve) => { resolveResult = resolve; });

  function activeActivityCount() {
    let total = 0;
    for (const count of activities.values()) total += count;
    return total;
  }

  function readEntitlementSafely() {
    try {
      const entitlement = readEntitlement() ?? {};
      return {
        owned: entitlement.owned === true,
        receiptsLoaded: entitlement.receiptsLoaded === true,
      };
    } catch (readError) {
      onWarn('Purchase restore session could not read the entitlement.', readError);
      return { owned: false, receiptsLoaded: false };
    }
  }

  function clearTimers() {
    clearTimeoutFn(quietTimerId);
    clearTimeoutFn(settleTimerId);
    clearTimeoutFn(timeoutTimerId);
    quietTimerId = null;
    settleTimerId = null;
    timeoutTimerId = null;
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearTimers();

    const entitlement = readEntitlementSafely();
    const deliveredTransactions = Array.from(delivered.values());
    // Ownership counts whatever the store's receipts say, loaded this session or
    // not: `owned` is live receipt state, not a cached local flag, and a player
    // who demonstrably owns the product must not be told the restore failed.
    const restoredSomething = deliveredTransactions.length > 0 || entitlement.owned;

    let status;
    if (restoredSomething) status = RESTORE_STATUS.RESTORED;
    else if (error) status = RESTORE_STATUS.FAILED;
    else if (timedOut) status = RESTORE_STATUS.TIMEOUT;
    else status = RESTORE_STATUS.NOTHING;

    // Running out of time is a failure of the flow even when the player ends up
    // with the product. The status stays whatever the benefit deserves; the
    // error makes sure the timeout is never invisible in the log.
    if (timedOut && !error) error = new Error('Purchase restore session timed out.');

    // A product that was granted and recorded stays restored even when the
    // restore call, a verification or a finish() failed afterwards — the player
    // has it. The error still travels in the result so the caller can log it.
    if (status === RESTORE_STATUS.RESTORED && error) {
      onWarn('Purchase restore delivered products but part of the flow failed.', error);
    }

    resolveResult({
      status,
      owned: entitlement.owned,
      deliveredTransactions,
      error,
    });
  }

  function evaluate() {
    if (finished || !started) return;
    if (!restoreSettled || !settleWindowElapsed || !quietElapsed) return;
    if (activeActivityCount() > 0) return;
    // Nothing delivered and the store never loaded a receipt: it has not
    // committed to an answer at all, so "nothing to restore" would be a claim
    // about silence. The hard timeout ends this case, and it ends it as
    // `timeout`.
    if (!readEntitlementSafely().receiptsLoaded && delivered.size === 0) return;
    finish();
  }

  function markRestoreSettled() {
    if (finished || restoreSettled) return;
    restoreSettled = true;
    timeoutTimerId = setTimeoutFn(() => {
      timeoutTimerId = null;
      timedOut = true;
      finish();
    }, timeoutMs);
    settleTimerId = setTimeoutFn(() => {
      settleTimerId = null;
      settleWindowElapsed = true;
      evaluate();
    }, settleWindowMs);
  }

  function recordActivity() {
    if (finished) return;
    quietElapsed = false;
    clearTimeoutFn(quietTimerId);
    quietTimerId = setTimeoutFn(() => {
      quietTimerId = null;
      quietElapsed = true;
      evaluate();
    }, quietMs);
  }

  return {
    // Runs the store call and resolves with the session result. The restore call
    // may resolve with an error object instead of rejecting — both count.
    async run(restoreCall) {
      if (started) throw new Error('Purchase restore session already ran.');
      started = true;

      // Keep the session (and the caller's duplicate-request guard) alive while
      // the store owns the request, including password entry. A JS timeout
      // cannot cancel the store's own sync; abandoning it would permit
      // overlapping restores and discard its eventual result. Gameplay remains
      // available meanwhile — that is the caller's to keep.
      void (async () => {
        let callError = null;
        try {
          callError = toRestoreError(await restoreCall());
        } catch (thrown) {
          callError = toRestoreError(thrown) ?? new Error('Purchase restore failed.');
        }
        if (finished) {
          if (callError) onWarn('Purchase restore failed after the session closed.', callError);
          return;
        }
        if (callError && !error) error = callError;
        markRestoreSettled();
      })();

      return promise;
    },

    // A transaction that was granted and written to the ledger during this
    // session. Called after the grant, never before it.
    noteDelivered(delivery = {}) {
      const transactionId = String(delivery.transactionId ?? '').trim();
      const productId = String(delivery.productId ?? '').trim();
      if (finished || !transactionId || !productId) return false;
      if (delivered.has(transactionId)) return false;
      delivered.set(transactionId, { transactionId, productId });
      recordActivity();
      return true;
    },

    // Anything that went wrong anywhere in the restore: the store call, a
    // verification, a delivery, a finish(). The first one is what the result
    // carries — with nothing delivered it makes the restore `failed` instead of
    // the "nothing to restore" a silent failure would otherwise produce.
    noteError(cause) {
      if (finished || !cause) return false;
      if (!error) error = toRestoreError(cause);
      recordActivity();
      return true;
    },

    // Any store event that can still change the outcome: a receipt update, an
    // entitlement sync, a product update. Restarts the quiet period.
    noteActivity() {
      if (finished) return false;
      recordActivity();
      return true;
    },

    // Brackets asynchronous work the session must outlive — verification and
    // delivery. The window cannot close while a bracket is open, and closing one
    // restarts the quiet period.
    beginActivity(label) {
      if (finished) return false;
      activities.set(label, (activities.get(label) ?? 0) + 1);
      recordActivity();
      return true;
    },

    endActivity(label) {
      if (finished) return false;
      const count = activities.get(label) ?? 0;
      if (count <= 0) return false;
      if (count === 1) activities.delete(label);
      else activities.set(label, count - 1);
      // The quiet period starts over here, so the evaluation happens when it
      // expires — a bracket that just closed is itself fresh activity.
      recordActivity();
      return true;
    },

    isFinished() {
      return finished;
    },
  };
}
