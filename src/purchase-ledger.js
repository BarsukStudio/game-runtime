/**
 * The pure half of a delivery journal: a list of transaction ids in delivery
 * order, and the operations a game needs to keep one.
 *
 * Deliberately storage-free. Where the halves live, how many there are and what
 * they are written next to is the game's decision — in Muscle Clicker one half
 * shares a single write with the granted product and the other is a standalone
 * mirror, so no wrapper here could own both. These functions only decide what
 * the resulting list looks like.
 *
 * The journal is not a cache. An id that falls out of every copy stops guarding
 * its transaction, so a replay of it would be granted a second time; that is why
 * trimming is a caller's explicit act with a caller's limit, never implied by a
 * read or a merge.
 *
 * @module @barsuk/game-runtime/purchase-ledger
 */

/**
 * A usable id is a non-empty string; anything else came from a corrupted save or
 * an SDK that answered with an object, and must not be counted as a delivery.
 *
 * @param {unknown} value A stored or SDK-supplied transaction id.
 * @returns {string} The trimmed id, or `''` when the value is not a usable id.
 */
export function normalizePurchaseId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Union of any number of halves, in delivery order, without trimming. A repeated
 * id keeps only its newest position: the order is what makes trimming drop the
 * oldest entry rather than an arbitrary one.
 *
 * @param {...unknown} sources Id lists; anything that is not an array is skipped.
 * @returns {string[]} A new array of normalized ids, oldest first.
 */
export function mergePurchaseIds(...sources) {
  const ids = new Set();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const value of source) {
      const id = normalizePurchaseId(value);
      if (!id) continue;
      ids.delete(id);
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Keeps the newest `limit` ids. A replay grows less likely the further a
 * transaction is from now, so the oldest tail is the only safe thing to evict.
 *
 * @param {unknown} ids An id list in delivery order.
 * @param {number} limit How many of the newest ids to keep.
 * @returns {Array<unknown>} A new array; the whole list when `limit` is missing,
 *   negative or not finite, an empty one for a non-array.
 */
export function limitPurchaseIds(ids, limit) {
  if (!Array.isArray(ids)) return [];
  // A limit that never arrived must not be read as "keep nothing": losing the
  // journal costs a double grant, keeping too much costs bytes.
  if (!Number.isFinite(limit) || limit < 0) return [...ids];
  // `slice(-0)` is `slice(0)` — the whole array, the exact opposite of a zero
  // limit — so zero is answered before the slice ever sees it.
  if (limit === 0) return [];
  return ids.slice(-limit);
}

/**
 * The replay guard itself: was this transaction already paid for?
 *
 * @param {unknown} ids An id list.
 * @param {unknown} id The transaction id to look for.
 * @returns {boolean} True only for a usable id present in the list.
 */
export function purchaseIdsContain(ids, id) {
  const wanted = normalizePurchaseId(id);
  if (!wanted || !Array.isArray(ids)) return false;
  return ids.some((value) => normalizePurchaseId(value) === wanted);
}

/**
 * One delivery recorded into one half, at that half's own limit.
 *
 * @param {unknown} ids The half's current id list.
 * @param {unknown} id The delivered transaction id; an unusable one records nothing.
 * @param {number} limit The half's depth, as in {@link limitPurchaseIds}.
 * @returns {string[]} A new list with the id at the newest end.
 */
export function addPurchaseId(ids, id, limit) {
  return limitPurchaseIds(mergePurchaseIds(ids, [id]), limit);
}
