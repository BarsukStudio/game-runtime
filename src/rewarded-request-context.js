/**
 * One rewarded show = one request, decided before the ad opens.
 *
 * The reward used to be reconstructed after the ad closed, from whatever the
 * selected placement and the visible controls happened to say at that moment.
 * A rewarded ad covers the app for tens of seconds and the player can background
 * it, so those globals are not the same ones the player tapped on. Everything
 * the grant needs is therefore snapshotted at tap time and carried through the
 * whole flow.
 *
 * Deliberately free of game, DOM and SDK knowledge: the game supplies the
 * placement, the payload and the two handlers, its ad bridge supplies the
 * terminal events. Placements and amounts stay in the game.
 *
 * @module @barsuk/game-runtime/rewarded-request-context
 */

/**
 * @typedef {object} RewardedRequest
 * @property {string} requestId From the injected `createRequestId`.
 * @property {number} saveEpoch The save generation the request belongs to.
 * @property {string} placement The game's own placement name.
 * @property {object} payload Everything the grant needs, snapshotted at tap time.
 * @property {boolean} rewardGranted True once a grant was accepted.
 * @property {boolean} finalized True once the terminal outcome ran.
 */

/**
 * @typedef {object} RewardedRequestCoordinatorOptions
 * @property {() => string} createRequestId Required. A request id that never
 *   repeats across launches: a game that keeps it as a durable delivery id
 *   would refuse a new reward whose id an earlier launch already recorded.
 * @property {(request: RewardedRequest, outcome: 'rewarded') => (boolean | void)} [onRewardEarned]
 *   The grant. Returning `false` means it was not committed (a failed save, say):
 *   the request stays ungranted and the next confirmation of the same request
 *   retries it. Any other return value, a throw included, counts as granted.
 * @property {(request: RewardedRequest, outcome: string) => void} [onFinalize]
 *   Everything owed on every terminal outcome, reward or not.
 * @property {(message: string, detail?: unknown) => void} [onWarn]
 *   Receives a handler failure the coordinator recovered from.
 */

/**
 * @typedef {object} RewardedRequestCoordinator
 * @property {(request?: { placement: string, payload?: object }) => (RewardedRequest | null)} begin
 *   Starts a request, or returns null when one is already in flight.
 * @property {() => () => boolean} captureReward
 *   A confirmation bound to the request active right now.
 * @property {() => void} invalidate
 *   Drops the active request and voids every captured confirmation.
 * @property {() => (RewardedRequest | null)} getActive
 * @property {() => boolean} isBusy
 * @property {(requestId?: string) => boolean} rewardEarned
 *   Grants the active request at most once.
 * @property {(outcome?: string, requestId?: string) => boolean} finalize
 *   Runs the terminal outcome at most once and releases the coordinator.
 */

const noop = () => {};

/**
 * Creates the coordinator for one game's rewarded flow.
 *
 * @param {RewardedRequestCoordinatorOptions} options
 * @returns {RewardedRequestCoordinator}
 * @throws {Error} When `createRequestId` is missing.
 */
export function createRewardedRequestCoordinator(options = {}) {
  const {
    createRequestId,
    onRewardEarned = noop,
    onFinalize = noop,
    onWarn = noop,
  } = options;
  // No default id source: a per-module counter restarts at the same ids on every
  // launch, which is exactly what a durable delivery journal must never see.
  if (typeof createRequestId !== 'function') {
    throw new Error('Rewarded request coordinator requires createRequestId.');
  }

  let active = null;
  let saveEpoch = 0;

  function notify(handler, request, outcome) {
    try {
      return handler(request, outcome);
    } catch (error) {
      // A throwing game handler must not wedge the coordinator: the state
      // transition is already committed by the time we get here, so the next
      // rewarded request can still start.
      onWarn(`Rewarded request handler failed (${request?.placement}, ${outcome}).`, error);
    }
  }

  // Shared by both confirmation paths. The flag is raised before the handler
  // runs, so a confirmation re-entering from inside the grant is refused.
  function grant(request) {
    request.rewardGranted = true;
    if (notify(onRewardEarned, request, 'rewarded') === false) {
      request.rewardGranted = false;
      return false;
    }
    return true;
  }

  // `requestId` is optional because the ad SDK terminal events carry no id of
  // their own — in production the game calls these without one, and the
  // ordering guarantee comes from `ad-lifecycle`, which emits exactly one
  // terminal outcome per show and swallows duplicates. Passing an id is the
  // stricter path: it rejects a callback that explicitly belongs to a request
  // that is no longer active.
  function matches(requestId) {
    if (!active) return false;
    return requestId === undefined || requestId === active.requestId;
  }

  return {
    // A concurrent second tap gets no reward of its own — the outcome belongs to
    // the attempt that is already showing.
    begin({ placement, payload = {} } = {}) {
      if (active) return null;
      if (!placement) throw new Error('Rewarded request requires a placement.');
      active = {
        requestId: createRequestId(),
        saveEpoch,
        placement,
        payload,
        rewardGranted: false,
        finalized: false,
      };
      return active;
    },

    // The closure owns the original request even after another show begins, so
    // a reward confirmed after the UI already finalized still pays that request.
    captureReward() {
      const request = active;
      return () => {
        if (!request || request.saveEpoch !== saveEpoch || request.rewardGranted) return false;
        return grant(request);
      };
    },

    // A save reset or reload: nothing captured before it may pay into the new
    // save.
    invalidate() {
      saveEpoch += 1;
      active = null;
    },

    getActive() {
      return active;
    },

    isBusy() {
      return active !== null;
    },

    // The reward itself. At most once per request, and never after the request
    // has been finalized.
    rewardEarned(requestId) {
      if (!matches(requestId)) return false;
      if (active.rewardGranted) return false;
      return grant(active);
    },

    // Everything that has to happen whether or not the reward was earned:
    // closing the message, a base payout owed on every outcome, a location
    // change. At most once per request, and it is what releases the coordinator.
    finalize(outcome = 'closed', requestId) {
      if (!matches(requestId)) return false;
      const request = active;
      request.finalized = true;
      active = null;
      notify(onFinalize, request, outcome);
      return true;
    },
  };
}
