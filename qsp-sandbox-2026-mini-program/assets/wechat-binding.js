/**
 * WeChat account-linking onboarding.
 *
 * Renders as a full-bleed overlay inside the .phone shell on first entry, so the
 * home page is already mounted underneath and "skip" is an instant dismiss rather
 * than a page navigation. Mirrors the assets/access-gate.js pattern.
 *
 * Replay the flow with ?bind=1 (or #bind), or window.QimaWechatBinding.reset().
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'qima-wechat-binding';
  var RESEND_SECONDS = 90;

  /** Demo rule: consumer mailboxes are treated as "not in the QIMA system". */
  var UNKNOWN_DOMAINS = [
    'qq.com', '163.com', '126.com', 'gmail.com', 'hotmail.com',
    'outlook.com', 'foxmail.com', 'sina.com', 'yahoo.com', 'icloud.com'
  ];

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var state = {
    email: '',
    code: '',
    emailError: false,
    codeSent: false,
    remaining: 0
  };

  var timer = null;
  var root = null;
  var el = {};

  function tr(key, vars) {
    if (typeof global.t === 'function') return global.t(key, vars);
    return key;
  }

  function shouldShow() {
    var search = String(global.location.search || '');
    var hash = String(global.location.hash || '');
    if (search.indexOf('bind=1') !== -1 || hash === '#bind') return true;
    try {
      return !localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return true;
    }
  }

  function remember(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (e) { /* private mode — flow just replays next visit */ }
  }

  function emailDomain(value) {
    var at = String(value || '').lastIndexOf('@');
    return at === -1 ? '' : String(value).slice(at + 1).toLowerCase();
  }

  function isQimaUser(value) {
    return emailDomain(value) === 'qima.com';
  }

  function isKnownAccount(value) {
    return UNKNOWN_DOMAINS.indexOf(emailDomain(value)) === -1;
  }

  function template() {
    return '' +
      '<img class="wxbind-gradient" src="assets/binding/gradient.svg" alt="" />' +
      '<div class="wxbind-panel">' +
        '<img class="wxbind-curve" src="assets/binding/curve.svg" alt="" />' +
        '<div class="wxbind-nav">' +
          '<div class="wxbind-statusbar">' +
            '<div class="wxbind-time">9:41</div>' +
            '<div class="wxbind-indicators">' +
              '<img src="assets/signal.svg" alt="" width="18" height="12" />' +
              '<img src="assets/wifi.svg" alt="" width="17" height="12" />' +
              '<img src="assets/battery.svg" alt="" width="27" height="13" />' +
            '</div>' +
          '</div>' +
          '<div class="wxbind-navbar">' +
            '<img class="wxbind-back" src="assets/vector52.svg" alt="" width="9" height="17" />' +
            '<img class="wxbind-logo" src="assets/frame207.svg" width="72" height="16" data-i18n-alt="binding.qimaAlt" alt="QIMA" />' +
            '<div class="wxbind-capsule">' +
              '<img src="assets/share.svg" alt="" width="17" height="17" />' +
              '<div class="wxbind-divider"></div>' +
              '<img src="assets/home.svg" alt="" width="17" height="17" />' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="wxbind-card">' +
          '<div class="wxbind-marks">' +
            '<img class="wxbind-mark" src="assets/binding/wechat.svg" width="38" height="38" data-i18n-alt="binding.wechatAlt" alt="" />' +
            '<img class="wxbind-link" src="assets/binding/link.svg" width="16" height="16" data-i18n-alt="binding.linkAlt" alt="" />' +
            '<img class="wxbind-mark" src="assets/binding/qima-badge.svg" width="38" height="38" data-i18n-alt="binding.qimaAlt" alt="" />' +
          '</div>' +
          '<div class="wxbind-title" data-i18n="binding.title">' + tr('binding.title') + '</div>' +
          '<div class="wxbind-note">' +
            '<img src="assets/binding/info.svg" width="16" height="16" alt="" />' +
            '<p id="wxbindNote">' + tr('binding.infoSupplier') + '</p>' +
          '</div>' +

          '<div class="wxbind-body">' +
            '<div class="wxbind-form" id="wxbindForm">' +
              '<div class="wxbind-fields">' +
                '<div class="wxbind-field" id="wxbindEmailField">' +
                  '<label class="wxbind-label" for="wxbindEmail" data-i18n="binding.emailLabel">' + tr('binding.emailLabel') + '</label>' +
                  '<div class="wxbind-input-wrap">' +
                    '<input class="wxbind-input" id="wxbindEmail" type="email" autocomplete="email" ' +
                      'inputmode="email" data-i18n-placeholder="binding.emailPlaceholder" ' +
                      'placeholder="' + tr('binding.emailPlaceholder') + '" />' +
                    '<button class="wxbind-clear" type="button" id="wxbindClear" ' +
                      'data-i18n-title="binding.clearEmail" title="' + tr('binding.clearEmail') + '">' +
                      '<img src="assets/binding/clear.svg" width="16" height="16" alt="" />' +
                    '</button>' +
                  '</div>' +
                  '<p class="wxbind-help" id="wxbindEmailHelp">' + tr('binding.emailHelp') + '</p>' +
                '</div>' +

                '<div class="wxbind-field">' +
                  '<label class="wxbind-label" for="wxbindCode" data-i18n="binding.codeLabel">' + tr('binding.codeLabel') + '</label>' +
                  '<div class="wxbind-code-row">' +
                    '<input class="wxbind-input" id="wxbindCode" type="text" inputmode="numeric" ' +
                      'data-i18n-placeholder="binding.codePlaceholder" placeholder="' + tr('binding.codePlaceholder') + '" />' +
                    '<button class="wxbind-btn" type="button" id="wxbindSend" disabled>' + tr('binding.sendCode') + '</button>' +
                  '</div>' +
                  '<p class="wxbind-help" id="wxbindCodeHelp"></p>' +
                '</div>' +
              '</div>' +

              '<button class="wxbind-btn wxbind-submit" type="button" id="wxbindSubmit" disabled ' +
                'data-i18n="binding.submit">' + tr('binding.submit') + '</button>' +
            '</div>' +

            '<div class="wxbind-success" id="wxbindSuccess" hidden>' +
              '<svg class="wxbind-success-icon" viewBox="0 0 56 56" aria-hidden="true">' +
                '<circle class="wxbind-success-ring" cx="28" cy="28" r="26" fill="none" ' +
                  'stroke="#16a34a" stroke-width="3" />' +
                '<path class="wxbind-success-tick" d="M17 28.8l7.4 7.2L39 21.5" fill="none" ' +
                  'stroke="#16a34a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />' +
              '</svg>' +
              '<div class="wxbind-success-title" data-i18n="binding.successTitle">' + tr('binding.successTitle') + '</div>' +
              '<div class="wxbind-success-desc" data-i18n="binding.successDesc">' + tr('binding.successDesc') + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<button class="wxbind-skip" type="button" id="wxbindSkip">' +
        '<span data-i18n="binding.skip">' + tr('binding.skip') + '</span>' +
        '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none">' +
          '<path d="M7.5 4.5L13 10l-5.5 5.5" stroke="currentColor" stroke-width="1.8" ' +
            'stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
      '</button>';
  }

  function render() {
    var emailOk = EMAIL_RE.test(state.email);

    el.note.textContent = isQimaUser(state.email)
      ? tr('binding.infoQima')
      : tr('binding.infoSupplier');

    el.emailField.classList.toggle('is-error', state.emailError);
    el.emailHelp.classList.toggle('is-error', state.emailError);
    el.emailHelp.textContent = state.emailError
      ? tr('binding.emailNotFound')
      : tr('binding.emailHelp');

    var canSend = emailOk && !state.emailError && state.remaining === 0;
    el.send.disabled = !canSend;
    el.send.classList.toggle('is-enabled', canSend);
    el.send.textContent = state.remaining > 0
      ? tr('binding.resendIn', { seconds: state.remaining })
      : tr('binding.sendCode');

    el.codeHelp.classList.toggle('is-ok', state.codeSent);
    el.codeHelp.textContent = state.codeSent ? tr('binding.codeSent') : '';

    var canSubmit = state.codeSent && /^\d{6}$/.test(state.code);
    el.submit.disabled = !canSubmit;
    el.submit.classList.toggle('is-enabled', canSubmit);
  }

  function startCountdown() {
    state.remaining = RESEND_SECONDS;
    render();
    clearInterval(timer);
    timer = setInterval(function () {
      state.remaining -= 1;
      if (state.remaining <= 0) {
        state.remaining = 0;
        clearInterval(timer);
        timer = null;
      }
      render();
    }, 1000);
  }

  function dismiss(reason) {
    if (!root) return;
    clearInterval(timer);
    timer = null;
    remember(reason);
    var node = root;
    root = null;
    node.classList.add('is-leaving');
    document.documentElement.classList.remove('qima-wxbind-active');
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 240);
  }

  function showSuccess() {
    clearInterval(timer);
    timer = null;
    el.form.hidden = true;
    el.success.hidden = false;
    setTimeout(function () { dismiss('bound'); }, 1800);
  }

  function bindEvents() {
    el.email.addEventListener('input', function () {
      state.email = el.email.value.trim();
      state.emailError = false;
      render();
    });

    el.clear.addEventListener('click', function () {
      el.email.value = '';
      state.email = '';
      state.emailError = false;
      render();
      el.email.focus();
    });

    el.code.addEventListener('input', function () {
      el.code.value = el.code.value.replace(/\D/g, '').slice(0, 6);
      state.code = el.code.value;
      render();
    });

    el.send.addEventListener('click', function () {
      if (el.send.disabled) return;
      if (!isKnownAccount(state.email)) {
        state.emailError = true;
        state.codeSent = false;
        render();
        el.email.focus();
        return;
      }
      state.codeSent = true;
      startCountdown();
    });

    el.submit.addEventListener('click', function () {
      if (el.submit.disabled) return;
      showSuccess();
    });

    el.skip.addEventListener('click', function () { dismiss('skipped'); });
  }

  function mount() {
    var phone = document.querySelector('.phone');
    if (!phone || document.querySelector('.wxbind')) return;

    root = document.createElement('div');
    root.className = 'wxbind';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = template();
    phone.appendChild(root);

    el = {
      note: root.querySelector('#wxbindNote'),
      form: root.querySelector('#wxbindForm'),
      success: root.querySelector('#wxbindSuccess'),
      emailField: root.querySelector('#wxbindEmailField'),
      email: root.querySelector('#wxbindEmail'),
      emailHelp: root.querySelector('#wxbindEmailHelp'),
      clear: root.querySelector('#wxbindClear'),
      code: root.querySelector('#wxbindCode'),
      codeHelp: root.querySelector('#wxbindCodeHelp'),
      send: root.querySelector('#wxbindSend'),
      submit: root.querySelector('#wxbindSubmit'),
      skip: root.querySelector('#wxbindSkip')
    };

    bindEvents();
    if (global.I18n && typeof global.I18n.applyPageI18n === 'function') {
      global.I18n.applyPageI18n(root);
    }
    render();
  }

  global.QimaWechatBinding = {
    STORAGE_KEY: STORAGE_KEY,
    reset: function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    },
    /** Debug helper: jump straight to a Figma state without typing. */
    goTo: function (stateName) {
      if (!root) return;
      if (stateName === 'filled') {
        el.email.value = '23124798@qima.com';
        state.email = el.email.value;
        state.emailError = false;
        state.codeSent = false;
        state.remaining = 0;
      } else if (stateName === 'sent') {
        el.email.value = '2141243@sunrisetoys.com';
        state.email = el.email.value;
        state.emailError = false;
        state.codeSent = true;
        state.remaining = RESEND_SECONDS;
      } else if (stateName === 'error') {
        el.email.value = '2141243@qq.com';
        state.email = el.email.value;
        state.emailError = true;
        state.codeSent = false;
        state.remaining = 0;
      } else if (stateName === 'success') {
        showSuccess();
        return;
      }
      render();
    }
  };

  if (!shouldShow()) return;

  document.documentElement.classList.add('qima-wxbind-active');
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
