/**
 * Shared unread badge for the Notifications tab (and home bell).
 *
 * Opening notifications clears the count so the red "2" disappears and stays
 * gone when navigating to other tabs. Demo default is 2 until the inbox is
 * opened or explicitly marked read.
 */
(function (global) {
  var STORAGE_KEY = 'qima-notif-unread';
  var DEFAULT_UNREAD = 2;

  function readCount() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null || raw === '') return DEFAULT_UNREAD;
      var n = parseInt(raw, 10);
      return isNaN(n) || n < 0 ? DEFAULT_UNREAD : n;
    } catch (e) {
      return DEFAULT_UNREAD;
    }
  }

  function writeCount(n) {
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.max(0, n | 0)));
    } catch (e) { /* ignore quota / private mode */ }
  }

  function applyBadge(el, count) {
    if (!el) return;
    if (count > 0) {
      el.hidden = false;
      el.removeAttribute('hidden');
      el.style.display = '';
      el.textContent = String(count);
    } else {
      el.hidden = true;
      el.setAttribute('hidden', '');
      el.textContent = '';
    }
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

  function setUnread(count) {
    writeCount(count);
    return sync();
  }

  function clearUnread() {
    return setUnread(0);
  }

  function isNotificationsPage() {
    try {
      return /(^|\/)notifications\.html(\?|#|$)/i.test(location.pathname + location.search) ||
        /notifications\.html/i.test(location.href);
    } catch (e) {
      return false;
    }
  }

  global.NotifBadge = {
    get: readCount,
    set: setUnread,
    clear: clearUnread,
    sync: sync
  };

  // Clear storage as soon as the inbox route loads so later page scripts see 0.
  if (isNotificationsPage()) writeCount(0);

  function boot() {
    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
