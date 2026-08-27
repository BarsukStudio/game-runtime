/**
 * The order in which one approved-and-verified transaction becomes a delivered
 * product:
 *
 *     validate the transaction
 *   → skip anything the store still calls pending
 *   → ask the ledger whether it was already paid for
 *   → grant it through the game's callback
 *   → mirror the transaction id
 *   → finish the transaction with the store
 *
 * Everything game-specific arrives as a callback. This module never sees money,
 * status points, an entitlement, a save, a storage key or an SDK — only that a
 * grant either succeeded or did not.
 *
 * It does read an SDK-shaped transaction, though: `products[0].id`,
 * `transactionId`, `isPending` and `finish`. That is cordova-plugin-purchase's
 * shape, read off the plugin's own transaction type rather than off any one
 * game. Stated rather than hidden: a game on a different store adapts to this
 * shape, or hands this module an object already adapted to it. Headless and
 * store-agnostic are not the same property, and only the first is claimed here.
 *
 * The two rules the sequence exists to enforce:
 *
 * 1. A transaction is finished only after its product was granted, or after the
 *    ledger confirmed an earlier delivery of it. Finishing first would leave a
 *    paid product ungranted and unrecoverable — the store stops replaying a
 *    finished transaction.
 * 2. A transaction whose delivery could not be completed is left unfinished on
 *    purpose, so the store replays it. Every early return here is that decision,
 *    not an error swallowed.
 *
 * @module @barsuk/game-runtime/purchase-delivery
 */

/**
 * The subset of a store transaction this module reads.
 *
 * @typedef {object} StoreTransaction
 * @property {Array<{ id?: string }>} [products] The store's product list; the
 *   first entry names the product.
 * @property {string} [transactionId] Stable per-transaction id.
 * @property {boolean} [isPending] Whether the store still calls it pending.
 * @property {() => Promise<unknown>} [finish] Dispatches the finish call.
 */

/**
 * Everything game-specific the sequence needs.
 *
 * The first four are required and are checked before anything runs. The last
 * two are not: a game that does not want to hear about a delivery, or about a
 * transaction left recoverable, is not thereby broken.
 *
 * @typedef {object} PurchaseDeliveryHandlers
 * @property {(transactionId: string) => boolean} isDelivered
 *   Required. The ledger lookup.
 * @property {(productId: string, transactionId: string) => boolean} grant
 *   Required. False for a product the game does not know. Must persist the
 *   product and the transaction id together, in one write.
 * @property {(transactionId: string) => void} mirror
 *   Required. The second, independent ledger write.
 * @property {(transaction: StoreTransaction) => Promise<unknown>} finish
 *   Required. Resolves once the store confirms the transaction is settled.
 * @property {(delivery: { transactionId: string, productId: string }) => void} [onDelivered]
 *   A real delivery only, never a replay.
 * @property {(message: string, detail?: unknown) => void} [onWarn]
 *   Why a transaction was deliberately left unfinished.
 */

// The four the sequence cannot proceed without.
const REQUIRED_HANDLERS = ['isDelivered', 'grant', 'mirror', 'finish'];

/**
 * The product a transaction is about, as the game's own key.
 *
 * @param {StoreTransaction} transaction
 * @returns {string} The product id, or '' when the transaction carries none.
 */
export function getTransactionProductId(transaction) {
  return String(transaction?.products?.[0]?.id ?? '').trim();
}

/**
 * What one delivery is identified by, for the ledger.
 *
 * @param {StoreTransaction} transaction
 * @returns {string} The transaction id, or '' when there is none.
 */
export function getTransactionDeliveryId(transaction) {
  return String(transaction?.transactionId ?? '').trim();
}

/**
 * Delivers one approved-and-verified transaction, in the order above.
 *
 * @param {StoreTransaction} transaction
 * @param {PurchaseDeliveryHandlers} [handlers]
 * @returns {Promise<boolean>} True when the transaction is settled and its
 *   product is accounted for; false when it was deliberately left recoverable.
 * @throws {Error} When a required handler is missing, before anything is read
 *   or granted. A throw from `grant` or `finish` propagates as well: by then
 *   the product may already be granted, and the caller has to hear about a
 *   transaction that stayed unfinished.
 */
export async function deliverPurchaseTransaction(transaction, handlers = {}) {
  // Checked before the transaction is read, not where each handler is called.
  // Every step below either grants a product or decides to leave a transaction
  // replayable; discovering a missing handler halfway through would do it with
  // the money already moved and the ledger half-written. The message names the
  // ones that are absent, because a caller that forgot one forgot it silently.
  const missing = REQUIRED_HANDLERS.filter((name) => typeof handlers?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Purchase delivery requires ${missing.join(', ')}.`);
  }

  const {
    isDelivered,
    grant,
    mirror,
    finish,
    onDelivered,
    onWarn = () => {},
  } = handlers;

  if (!transaction || transaction.isPending) return false;
  const productId = getTransactionProductId(transaction);
  if (!productId) {
    onWarn('Verified purchase has no product id; leaving it unfinished.', transaction);
    return false;
  }
  const transactionId = getTransactionDeliveryId(transaction);
  if (!transactionId) {
    onWarn(`Verified purchase ${productId} has no transaction id; leaving it unfinished.`);
    return false;
  }
  if (typeof transaction.finish !== 'function') {
    onWarn(`Verified purchase ${productId} cannot be finished; leaving it recoverable.`);
    return false;
  }

  if (!isDelivered(transactionId)) {
    // One write: the game persists the product and the transaction id together.
    if (!grant(productId, transactionId)) {
      onWarn(`Unknown verified purchase ${productId}; leaving it unfinished.`);
      return false;
    }
    // The mirror half of the ledger, second and independent.
    mirror(transactionId);
    // Reported only here: after the grant and the ledger write, and for a
    // consumable as much as for a permanent entitlement. A replay restores
    // nothing, so it must not be announced as a restoration.
    onDelivered?.({ transactionId, productId });
  }

  await finish(transaction);
  return true;
}
