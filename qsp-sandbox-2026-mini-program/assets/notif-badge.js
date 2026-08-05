/**
 * Shared unread badge for the Notifications tab (and home bell).
 *
 * Demo: always show "2" — opening the inbox does not clear it.
 */
(function (global) {
  var DEMO_UNREAD = 2;

  function readCount() {
    return DEMO_UNREAD;
  }

  function applyBadge(el, count) {
    if (!el) return;
    el.hidden = false;
    el.removeAttribute('hidden');
    el.style.display = '';
    el.textContent = String(count);
  }

  function sync() {
    var count = readCount();
    document.querySelectorAll('.tab-badge').forEach(function (el) {
      applyBadge(el, count);
    });
    document.querySelectorAll('.bell .badge').forEach(function (el) {
      applyBadge(el, count);
    });
    return count;
  }

  function setUnread() {
    return sync();
  }

  function clearUnread() {
    return sync();
  }

  global.NotifBadge = {
    get: readCount,
    set: setUnread,
    clear: clearUnread,
    sync: sync
  };

  function boot() {
    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
