/**
 * Bind asynchronous provider replies to the load/show that issued the request.
 * Global SDK events without an attempt id must still use the underlying signals;
 * capturing the current attempt when such an event arrives cannot identify it.
 *
 * @param {Function} createLifecycle Injected passive lifecycle factory.
 * @param {object} options Lifecycle options, including callbacks and timers.
 * @returns {object} Lifecycle with captureLoad/captureShow callback handles.
 */
export function withAdAttemptScopes(createLifecycle, options) {
  let load = null;
  let show = null;
  const callbacks = { ...options.callbacks };
  for (const name of ['onLoaded', 'onLoadFailed', 'onShowFailed', 'onClosed']) {
    callbacks[name] = (...args) => {
      const attempt = name === 'onLoaded' || name === 'onLoadFailed' ? load : show;
      // Invalidate before game callbacks, which may synchronously start a retry.
      if (attempt) attempt.active = false;
      options.callbacks[name]?.(...args);
    };
  }
  const lifecycle = createLifecycle({ ...options, callbacks });

  function capture(attempt, methods) {
    const isCurrent = () => attempt?.active === true;
    return Object.fromEntries([
      ['isCurrent', isCurrent],
      ...methods.map((name) => [name, (...args) => isCurrent() && lifecycle[name](...args)]),
    ]);
  }

  return {
    ...lifecycle,
    beginLoad() {
      if (load?.active) return false;
      const attempt = load = { active: true };
      const accepted = lifecycle.beginLoad();
      if (!accepted) attempt.active = false;
      return accepted;
    },
    beginShow() {
      if (show?.active) return false;
      const attempt = show = { active: true };
      const accepted = lifecycle.beginShow();
      if (!accepted) attempt.active = false;
      return accepted;
    },
    captureLoad: () => capture(load, ['loadSucceeded', 'loadFailed']),
    captureShow: () => capture(show, ['showStarted', 'showFailed', 'showClosed', 'rewardEarned']),
  };
}
