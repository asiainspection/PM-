/**
 * Shared demo walkthrough shortcuts (bottom-right of the .phone shell).
 * Collapses into one "Demo" control; expands to jump targets.
 */
(function (global) {
  'use strict';

  function tr(key, fallback) {
    if (typeof global.t === 'function') {
      var value = global.t(key);
      if (value && value !== key) return value;
    }
    return fallback || key;
  }

  function icon(name) {
    if (name === 'login') {
      return '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<rect x="3.5" y="8" width="13" height="9" rx="2" stroke="currentColor" stroke-width="1.6"/>' +
        '<path d="M6.5 8V6.2a3.5 3.5 0 0 1 7 0V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
        '</svg>';
    }
    if (name === 'fail') {
      return '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<path d="M10 3.2 18 16.8H2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
        '<path d="M10 8v3.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
        '<circle cx="10" cy="14.2" r=".95" fill="currentColor"/>' +
        '</svg>';
    }
    return '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/>' +
      '<path d="M10 6.5v4l2.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '</svg>';
  }

  function pageBase() {
    var path = String(global.location.pathname || '');
    var slash = path.lastIndexOf('/');
    return slash === -1 ? '' : path.slice(0, slash + 1);
  }

  function goLogin() {
    try {
      if (global.QimaWechatBinding && typeof global.QimaWechatBinding.reset === 'function') {
        global.QimaWechatBinding.reset();
      } else {
        localStorage.removeItem('qima-wechat-binding');
      }
    } catch (e) { /* ignore */ }

    // Already on home and the overlay API is available — remount without a full hop.
    var file = String(global.location.pathname || '').split('/').pop() || '';
    var onIndex = file === '' || file === 'index.html' || file === 'index.htm';
    if (onIndex && global.QimaWechatBinding && typeof global.QimaWechatBinding.open === 'function') {
      try {
        var url = new URL(global.location.href);
        url.searchParams.set('bind', '1');
        global.history.replaceState(null, '', url.toString());
      } catch (e) { /* ignore */ }
      global.QimaWechatBinding.open();
      return;
    }
    global.location.href = pageBase() + 'index.html?bind=1';
  }

  function goParseFail() {
    if (typeof global.openParseFailureDemo === 'function') {
      global.openParseFailureDemo();
      return;
    }
    global.location.href = pageBase() + 'order-chat.html?demo=parse-fail';
  }

  function mount() {
    var phone = document.querySelector('.phone');
    if (!phone || document.getElementById('demoShortcuts')) return;

    var root = document.createElement('div');
    root.id = 'demoShortcuts';
    root.className = 'demo-shortcuts';
    root.innerHTML =
      '<div class="demo-shortcuts-menu" id="demoShortcutsMenu" hidden>' +
        '<button class="demo-shortcuts-item" type="button" data-action="login">' +
          icon('login') +
          '<span data-i18n="demo.login">' + tr('demo.login', '未登录') + '</span>' +
        '</button>' +
        '<button class="demo-shortcuts-item" type="button" data-action="parse-fail">' +
          icon('fail') +
          '<span data-i18n="demo.parseFail">' + tr('demo.parseFail', '解析失败') + '</span>' +
        '</button>' +
      '</div>' +
      '<button class="demo-shortcuts-toggle" type="button" id="demoShortcutsToggle" ' +
        'aria-expanded="false" aria-controls="demoShortcutsMenu">' +
        icon('menu') +
        '<span data-i18n="demo.menu">' + tr('demo.menu', '演示') + '</span>' +
        '<svg class="demo-shortcuts-chevron" viewBox="0 0 10 10" aria-hidden="true" fill="none">' +
          '<path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" ' +
            'stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
      '</button>';

    phone.appendChild(root);

    if (global.I18n && typeof global.I18n.applyPageI18n === 'function') {
      global.I18n.applyPageI18n(root);
    }

    var menu = root.querySelector('#demoShortcutsMenu');
    var toggle = root.querySelector('#demoShortcutsToggle');

    toggle.addEventListener('click', function () {
      var open = root.classList.toggle('is-open');
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    root.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-action]');
      if (!btn || !root.contains(btn)) return;
      var action = btn.getAttribute('data-action');
      root.classList.remove('is-open');
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (action === 'login') goLogin();
      else if (action === 'parse-fail') goParseFail();
    });
  }

  global.QimaDemoShortcuts = {
    openLogin: goLogin,
    openParseFail: goParseFail
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
