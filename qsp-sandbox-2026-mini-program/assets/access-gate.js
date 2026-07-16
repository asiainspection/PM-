/**
 * Access gate for the GitHub Pages demo — currently disabled.
 * The gate no longer requires a password; the demo loads directly.
 *
 * To re-enable: restore the SHA-256 password check (see git history) and
 * redeploy the PM- sandbox.
 */
(function () {
  function unlock() {
    document.documentElement.classList.remove('qima-gate-locked');
    var gate = document.getElementById('qima-access-gate');
    if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
  }

  // Gate disabled — unlock immediately.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', unlock, { once: true });
  } else {
    unlock();
  }
})();
