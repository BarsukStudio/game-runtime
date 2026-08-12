/**
 * Confirmed finishing of store transactions, decoupled from any store SDK.
 *
 * `transaction.finish()` in cordova-plugin-purchase resolves once the call has
 * been dispatched to the native layer, not once the store has settled the
 * transaction. Delivery that trusts that promise reports success while the
 * purchase is still open. This coordinator keeps the finish pending until the
 * store reports the transaction as finished, or until an injected timeout
 * fires.
 *
 * The module is headless on purpose: no SDK import, no Capacitor, no DOM, no
 * storage, and no ambient timers. The store object arrives as a duck-typed
 * dependency, the caller injects the timers, and nothing here knows about
 * products, prices or entitlements.
 *
 * @module @barsuk/game-runtime/purchase-finish
 */

/** @type {number} */
const DEFAULT_FINISH_TIMEOUT_MS = 30000;

/**
 * The subset of a store transaction this module reads.
 *
 * @typedef {object} StoreTransaction
 * @property {string} [platform] Store platform id, part of the dedupe key.
 * @property {string} [transactionId] Stable per-transaction id.
 * @property {string} [state] Current transaction state.
 * @property {boolean} [isAcknowledged] Android: acknowledged by the store.
 * @property {boolean} [isConsumed] Android: consumed in this session.
 * @property {() => Promise<unknown>} [finish] Dispatches the finish call.
 */

/**
 * @typedef {object} SettledTransactionOptions
 * @property {string} [finishedState] The store's terminal state value.
 * @property {boolean} [consumable=false] Whether the product is a consumable.
 */

/**
 * True once the store itself has settled a transaction, so nothing is left for
 * this client to finish.
 *
 * FINISHED alone is not enough for a non-consumable: Google Play loads an
 * already acknowledged one as APPROVED with isAcknowledged=true and keeps it
 * there forever — finish() short-circuits for it without emitting a state
 * change, so the FINISHED event this coordinator waits for never arrives and it
 * would only hang until the confirmation timeout. Apple never sets
 * isAcknowledged, but there a restored transaction does reach FINISHED through
 * finish(), so the state check covers iOS.
 *
 * A consumable must never take that shortcut. Acknowledgement is not
 * consumption: the Android bridge reports only `acknowledged`
 * (PurchasePlugin.java), while `consumed` is set in-session by
 * onPurchaseConsumed and is gone after a relaunch. Treating an acknowledged but
 * unconsumed consumable as settled would skip finish() — the product would stay
 * unconsumed forever, so the player could never buy it again and the store would
 * eventually refund it.
 *
 * @param {StoreTransaction | null | undefined} transaction
 * @param {SettledTransactionOptions} [options]
 * @returns {boolean}
 */
export function isSettledStoreTransaction(transaction, options = {}) {
  const { finishedState, consumable = false } = options;
  if (finishedState && transaction?.state === finishedState) return true;
  if (consumable) return transaction?.isConsumed === true;
  return transaction?.isAcknowledged === true;
}

/**
 * Dedupe key for a pending finish. The transaction id alone is not enough: the
 * same id can exist on two platforms in a test or a multi-store build.
 *
 * @param {StoreTransaction | null | undefined} transaction
 * @returns {string} Empty when the transaction carries no usable id.
 */
function getTransactionKey(transaction) {
  const platform = String(transaction?.platform ?? '').trim();
  const transactionId = String(transaction?.transactionId ?? '').trim();
  if (!transactionId) return '';
  return `${platform}:${transactionId}`;
}

/**
 * @typedef {object} PurchaseFinishCoordinatorOptions
 * @property {{ when: () => { finished: (callback: (transaction: StoreTransaction) => void, name?: string) => unknown }, off: (callback: unknown) => void }} store
 *   Duck-typed store: `when().finished()` to subscribe, `off()` to unsubscribe.
 * @property {string} [finishedState='finished'] The store's terminal state value.
 * @property {number} [timeoutMs=30000] Confirmation budget, clamped to >= 1.
 * @property {(callback: () => void, ms: number) => unknown} setTimeoutFn
 *   Required. The library never reaches for an ambient timer.
 * @property {(handle: unknown) => void} clearTimeoutFn
 *   Required. Must cancel a handle produced by `setTimeoutFn`.
 */

/**
 * @typedef {object} PurchaseFinishCoordinator
 * @property {(transaction: StoreTransaction) => Promise<StoreTransaction>} finish
 *   Finishes a transaction and resolves only on confirmation.
 * @property {() => void} dispose Unsubscribes and rejects everything pending.
 * @property {() => number} pendingCount Pending confirmations, for tests.
 */

/**
 * Creates a coordinator that turns "finish dispatched" into "finish confirmed".
 *
 * @param {PurchaseFinishCoordinatorOptions} [options]
 * @returns {PurchaseFinishCoordinator}
 * @throws {Error} When the store cannot be subscribed to, or timers are missing.
 */
export function createPurchaseFinishCoordinator(options = {}) {
  const store = options.store;
  const finishedState = String(options.finishedState ?? 'finished');
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : DEFAULT_FINISH_TIMEOUT_MS;
  const { setTimeoutFn, clearTimeoutFn } = options;
  const pending = new Map();

  if (!store?.when || !store?.off) {
    throw new Error('Purchase finish coordinator requires store.when() and store.off().');
  }
  // Timers are a dependency, never an ambient global: a game embeds this in a
  // WebView, a test drives it on a fake clock, and neither may depend on which
  // setTimeout happens to be reachable from the module.
  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new Error('Purchase finish coordinator requires setTimeoutFn and clearTimeoutFn.');
  }

  /**
   * @param {StoreTransaction} transaction
   * @param {Error | null} [error]
   * @returns {boolean} True when a pending entry was settled.
   */
  function settle(transaction, error = null) {
    const key = getTransactionKey(transaction);
    const entry = key ? pending.get(key) : null;
    if (!entry) return false;
    pending.delete(key);
    clearTimeoutFn(entry.timeoutId);
    if (error) entry.reject(error);
    else entry.resolve(transaction);
    return true;
  }

  /** @param {StoreTransaction} transaction */
  function onFinished(transaction) {
    settle(transaction);
  }

  store.when().finished(onFinished, 'barsukPurchaseFinishCoordinator');

  /**
   * @param {StoreTransaction} transaction
   * @returns {Promise<StoreTransaction>}
   */
  async function finish(transaction) {
    if (!transaction || typeof transaction.finish !== 'function') {
      throw new Error('Purchase transaction cannot be finished.');
    }
    if (String(transaction.state ?? '') === finishedState) return transaction;

    const key = getTransactionKey(transaction);
    if (!key) throw new Error('Purchase transaction has no stable transaction id.');
    const existing = pending.get(key);
    if (existing) return existing.promise;

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timeoutId = setTimeoutFn(() => {
      if (String(transaction.state ?? '') === finishedState) {
        settle(transaction);
        return;
      }
      settle(transaction, new Error(`Purchase finish confirmation timed out for ${key}.`));
    }, timeoutMs);
    pending.set(key, {
      transaction,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeoutId,
    });

    try {
      await transaction.finish();
      if (String(transaction.state ?? '') === finishedState) settle(transaction);
    } catch (error) {
      settle(transaction, error);
    }
    return promise;
  }

  /** Unsubscribes from the store and rejects every pending confirmation. */
  function dispose() {
    store.off(onFinished);
    for (const entry of pending.values()) {
      clearTimeoutFn(entry.timeoutId);
      entry.reject(new Error('Purchase finish coordinator disposed.'));
    }
    pending.clear();
  }

  return {
    finish,
    dispose,
    pendingCount: () => pending.size,
  };
}

export { DEFAULT_FINISH_TIMEOUT_MS };
