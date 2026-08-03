/**
 * WeChat sign-in / account-linking onboarding.
 *
 * Mirrors the myQIMA (my.qima.com/v2/login) sign-in interaction inside the mini
 * program shell: username + password by default, with an email one-time-code
 * path behind "Sign in with a one-time code". Signing in links the WeChat
 * session to the QIMA account, so the success state stays account-linking copy.
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
  /** myQIMA resends the email code after a 30s cooldown. */
  var RESEND_SECONDS = 30;
  var CODE_LENGTH = 6;

  /** Demo rule: consumer mailboxes are treated as "not in the QIMA system". */
  var UNKNOWN_DOMAINS = [
    'qq.com', '163.com', '126.com', 'gmail.com', 'hotmail.com',
    'outlook.com', 'foxmail.com', 'sina.com', 'yahoo.com', 'icloud.com'
  ];

  /** Demo rule: this code always fails, so the mismatch state is reachable. */
  var REJECTED_CODE = '000000';

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var state = {
    screen: 'password',
    username: '',
    password: '',
    showPassword: false,
    keepSignedIn: false,
    usernameError: false,
    passwordError: false,
    formError: false,
    email: '',
    emailError: '',
    showEmailClear: false,
    code: '',
    codeError: false,
    remaining: 0,
    showRegPassword: false
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

  function pad2(value) {
    return (value < 10 ? '0' : '') + value;
  }

  function eyeIcon() {
    return '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none">' +
      '<path d="M1.7 10S4.8 4.9 10 4.9 18.3 10 18.3 10 15.2 15.1 10 15.1 1.7 10 1.7 10Z" ' +
        'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5"/>' +
      '<path class="lg-eye-slash" d="M4.2 15.8 15.8 4.2" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg>';
  }

  function dividerHtml() {
    return '<div class="lg-divider"><span data-i18n="login.or">' + tr('login.or') + '</span></div>';
  }

  function codeBoxesHtml() {
    var html = '';
    for (var i = 0; i < CODE_LENGTH; i += 1) {
      html += '<input class="lg-code-box" type="text" inputmode="numeric" maxlength="1" ' +
        (i === 0 ? 'autocomplete="one-time-code" ' : '') +
        'data-index="' + i + '" aria-label="' + tr('login.codeDigit', { index: i + 1 }) + '" />';
    }
    return html;
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
            '<img class="wxbind-mark" src="assets/binding/wechat.svg" width="34" height="34" data-i18n-alt="binding.wechatAlt" alt="" />' +
            '<img class="wxbind-link" src="assets/binding/link.svg" width="16" height="16" data-i18n-alt="binding.linkAlt" alt="" />' +
            '<img class="wxbind-mark" src="assets/binding/qima-badge.svg" width="34" height="34" data-i18n-alt="binding.qimaAlt" alt="" />' +
          '</div>' +

          '<div class="lg-head" id="lgHead">' +
            '<h1 class="lg-heading" id="lgHeading">' + tr('login.heading') + '</h1>' +
            '<p class="lg-signup" id="lgSignup">' +
              '<span data-i18n="login.signupLead">' + tr('login.signupLead') + '</span> ' +
              '<button class="lg-link" type="button" id="lgSignupLink" data-i18n="login.signupLink">' + tr('login.signupLink') + '</button>' +
            '</p>' +
          '</div>' +

          '<p class="lg-lead" id="lgLead" hidden></p>' +

          '<div class="wxbind-note" id="lgNote">' +
            '<img src="assets/binding/info.svg" width="16" height="16" alt="" />' +
            '<p id="wxbindNote">' + tr('binding.infoSupplier') + '</p>' +
          '</div>' +

          // ===== Screen 1: username + password =====
          '<div class="lg-screen" id="lgPasswordScreen">' +
            '<div class="lg-field" id="lgUsernameField">' +
              '<label class="lg-label" for="lgUsername" data-i18n="login.usernameLabel">' + tr('login.usernameLabel') + '</label>' +
              '<input class="lg-input" id="lgUsername" type="text" autocomplete="username" ' +
                'data-i18n-placeholder="login.usernamePlaceholder" placeholder="' + tr('login.usernamePlaceholder') + '" />' +
              '<p class="lg-error" id="lgUsernameError"></p>' +
            '</div>' +

            '<div class="lg-field" id="lgPasswordField">' +
              '<label class="lg-label" for="lgPassword" data-i18n="login.passwordLabel">' + tr('login.passwordLabel') + '</label>' +
              '<div class="lg-input-wrap">' +
                '<input class="lg-input" id="lgPassword" type="password" autocomplete="current-password" ' +
                  'data-i18n-placeholder="login.passwordPlaceholder" placeholder="' + tr('login.passwordPlaceholder') + '" />' +
                '<button class="lg-eye" type="button" id="lgEye" aria-label="' + tr('login.showPassword') + '">' + eyeIcon() + '</button>' +
              '</div>' +
              '<p class="lg-error" id="lgPasswordError"></p>' +
            '</div>' +

            '<div class="lg-row">' +
              '<label class="lg-check">' +
                '<input type="checkbox" id="lgKeep" />' +
                '<span class="lg-check-box" aria-hidden="true">' +
                  '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.3l3 3 6-6.6" stroke="currentColor" ' +
                    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                '</span>' +
                '<span data-i18n="login.keepSignedIn">' + tr('login.keepSignedIn') + '</span>' +
              '</label>' +
              '<button class="lg-link" type="button" id="lgForgot" data-i18n="login.forgotPassword">' + tr('login.forgotPassword') + '</button>' +
            '</div>' +

            '<p class="lg-error lg-error-banner" id="lgFormError"></p>' +

            '<button class="lg-btn lg-btn-primary" type="button" id="lgSignIn" data-i18n="login.signIn">' + tr('login.signIn') + '</button>' +
            dividerHtml() +
            '<button class="lg-btn lg-btn-secondary" type="button" id="lgOtpEntry" data-i18n="login.otpEntry">' + tr('login.otpEntry') + '</button>' +
          '</div>' +

          // ===== Screen: Register (mirrors qima.com/register) =====
          '<div class="lg-screen" id="lgRegisterScreen" hidden>' +
            '<div class="lg-benefits">' +
              '<div class="lg-benefits-title" data-i18n="signup.benefitsTitle">' + tr('signup.benefitsTitle') + '</div>' +
              '<ul>' +
                '<li data-i18n="signup.benefitFree">' + tr('signup.benefitFree') + '</li>' +
                '<li data-i18n="signup.benefitNoCommit">' + tr('signup.benefitNoCommit') + '</li>' +
                '<li data-i18n="signup.benefitTrusted">' + tr('signup.benefitTrusted') + '</li>' +
              '</ul>' +
            '</div>' +

            '<div class="lg-field-row">' +
              '<div class="lg-field" id="suFirstField">' +
                '<label class="lg-label" for="suFirst" data-i18n="signup.firstName">' + tr('signup.firstName') + '</label>' +
                '<input class="lg-input" id="suFirst" type="text" autocomplete="given-name" ' +
                  'data-i18n-placeholder="signup.firstNamePh" placeholder="' + tr('signup.firstNamePh') + '" />' +
                '<p class="lg-error" id="suFirstError"></p>' +
              '</div>' +
              '<div class="lg-field" id="suLastField">' +
                '<label class="lg-label" for="suLast" data-i18n="signup.lastName">' + tr('signup.lastName') + '</label>' +
                '<input class="lg-input" id="suLast" type="text" autocomplete="family-name" ' +
                  'data-i18n-placeholder="signup.lastNamePh" placeholder="' + tr('signup.lastNamePh') + '" />' +
                '<p class="lg-error" id="suLastError"></p>' +
              '</div>' +
            '</div>' +

            '<div class="lg-field" id="suCompanyField">' +
              '<label class="lg-label" for="suCompany" data-i18n="signup.company">' + tr('signup.company') + '</label>' +
              '<input class="lg-input" id="suCompany" type="text" autocomplete="organization" ' +
                'data-i18n-placeholder="signup.companyPh" placeholder="' + tr('signup.companyPh') + '" />' +
              '<p class="lg-error" id="suCompanyError"></p>' +
            '</div>' +

            '<div class="lg-field" id="suCountryField">' +
              '<label class="lg-label" for="suCountry" data-i18n="signup.country">' + tr('signup.country') + '</label>' +
              '<select class="lg-input lg-select" id="suCountry">' +
                '<option value="">' + tr('signup.countryPh') + '</option>' +
                '<option value="cn">' + tr('signup.country.cn') + '</option>' +
                '<option value="us">' + tr('signup.country.us') + '</option>' +
                '<option value="gb">' + tr('signup.country.gb') + '</option>' +
                '<option value="de">' + tr('signup.country.de') + '</option>' +
                '<option value="fr">' + tr('signup.country.fr') + '</option>' +
                '<option value="jp">' + tr('signup.country.jp') + '</option>' +
                '<option value="vn">' + tr('signup.country.vn') + '</option>' +
                '<option value="in">' + tr('signup.country.in') + '</option>' +
                '<option value="au">' + tr('signup.country.au') + '</option>' +
                '<option value="other">' + tr('signup.country.other') + '</option>' +
              '</select>' +
              '<p class="lg-error" id="suCountryError"></p>' +
            '</div>' +

            '<div class="lg-field" id="suStateField" hidden>' +
              '<label class="lg-label" for="suState" data-i18n="signup.state">' + tr('signup.state') + '</label>' +
              '<select class="lg-input lg-select" id="suState">' +
                '<option value="">' + tr('signup.statePh') + '</option>' +
                '<option value="CA">California</option>' +
                '<option value="NY">New York</option>' +
                '<option value="TX">Texas</option>' +
                '<option value="FL">Florida</option>' +
                '<option value="WA">Washington</option>' +
                '<option value="IL">Illinois</option>' +
              '</select>' +
              '<p class="lg-error" id="suStateError"></p>' +
            '</div>' +

            '<div class="lg-field" id="suIndustryField">' +
              '<label class="lg-label" for="suIndustry" data-i18n="signup.industry">' + tr('signup.industry') + '</label>' +
              '<select class="lg-input lg-select" id="suIndustry">' +
                '<option value="">' + tr('signup.industryPh') + '</option>' +
                '<option value="toys">' + tr('signup.industry.toys') + '</option>' +
                '<option value="apparel">' + tr('signup.industry.apparel') + '</option>' +
                '<option value="electronics">' + tr('signup.industry.electronics') + '</option>' +
                '<option value="homeware">' + tr('signup.industry.homeware') + '</option>' +
                '<option value="food">' + tr('signup.industry.food') + '</option>' +
                '<option value="packaging">' + tr('signup.industry.packaging') + '</option>' +
                '<option value="other">' + tr('signup.industry.other') + '</option>' +
              '</select>' +
              '<p class="lg-error" id="suIndustryError"></p>' +
            '</div>' +

            '<div class="lg-field" id="suPhoneField">' +
              '<label class="lg-label" for="suPhone" data-i18n="signup.phone">' + tr('signup.phone') + '</label>' +
              '<input class="lg-input" id="suPhone" type="tel" autocomplete="tel" ' +
                'data-i18n-placeholder="signup.phonePh" placeholder="' + tr('signup.phonePh') + '" />' +
            '</div>' +

            '<div class="lg-field" id="suEmailField">' +
              '<label class="lg-label" for="suEmail" data-i18n="signup.email">' + tr('signup.email') + '</label>' +
              '<input class="lg-input" id="suEmail" type="email" autocomplete="email" ' +
                'data-i18n-placeholder="signup.emailPh" placeholder="' + tr('signup.emailPh') + '" />' +
              '<p class="lg-error" id="suEmailError"></p>' +
            '</div>' +

            '<div class="lg-field" id="suUserField">' +
              '<label class="lg-label" for="suUser" data-i18n="signup.username">' + tr('signup.username') + '</label>' +
              '<input class="lg-input" id="suUser" type="text" autocomplete="username" ' +
                'data-i18n-placeholder="signup.usernamePh" placeholder="' + tr('signup.usernamePh') + '" />' +
              '<p class="lg-error" id="suUserError"></p>' +
            '</div>' +

            '<div class="lg-field" id="suPassField">' +
              '<label class="lg-label" for="suPass" data-i18n="signup.password">' + tr('signup.password') + '</label>' +
              '<div class="lg-input-wrap">' +
                '<input class="lg-input" id="suPass" type="password" autocomplete="new-password" />' +
                '<button class="lg-eye" type="button" id="suEye" aria-label="' + tr('login.showPassword') + '">' + eyeIcon() + '</button>' +
              '</div>' +
              '<p class="lg-error" id="suPassError"></p>' +
            '</div>' +

            '<div class="lg-field" id="suServiceField">' +
              '<label class="lg-label" for="suService" data-i18n="signup.service">' + tr('signup.service') + '</label>' +
              '<select class="lg-input lg-select" id="suService">' +
                '<option value="">' + tr('signup.servicePh') + '</option>' +
                '<option value="inspections">' + tr('signup.service.inspections') + '</option>' +
                '<option value="lab">' + tr('signup.service.lab') + '</option>' +
                '<option value="audits">' + tr('signup.service.audits') + '</option>' +
                '<option value="certification">' + tr('signup.service.certification') + '</option>' +
                '<option value="esg">' + tr('signup.service.esg') + '</option>' +
                '<option value="software">' + tr('signup.service.software') + '</option>' +
              '</select>' +
              '<p class="lg-error" id="suServiceError"></p>' +
            '</div>' +

            '<label class="lg-check is-block">' +
              '<input type="checkbox" id="suSubscribe" />' +
              '<span class="lg-check-box" aria-hidden="true">' +
                '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.3l3 3 6-6.6" stroke="currentColor" ' +
                  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
              '</span>' +
              '<span data-i18n="signup.subscribe">' + tr('signup.subscribe') + '</span>' +
            '</label>' +

            '<button class="lg-btn lg-btn-primary" type="button" id="suRegister" data-i18n="signup.register">' +
              tr('signup.register') +
            '</button>' +
            '<p class="lg-legal" data-i18n-html="signup.legalHtml">' +
              (typeof global.tHtml === 'function' ? global.tHtml('signup.legalHtml') : tr('signup.legalHtml')) +
            '</p>' +
          '</div>' +

          // ===== Screen 2: request an email code =====
          '<div class="lg-screen" id="lgEmailScreen" hidden>' +
            '<div class="lg-field" id="lgEmailField">' +
              '<label class="lg-label" for="lgEmail" data-i18n="login.emailLabel">' + tr('login.emailLabel') + '</label>' +
              '<div class="lg-input-wrap">' +
                '<input class="lg-input" id="lgEmail" type="email" autocomplete="email" inputmode="email" ' +
                  'data-i18n-placeholder="login.emailPlaceholder" placeholder="' + tr('login.emailPlaceholder') + '" />' +
                '<button class="lg-clear" type="button" id="lgEmailClear" ' +
                  'data-i18n-title="login.clearEmail" title="' + tr('login.clearEmail') + '">' +
                  '<img src="assets/binding/clear.svg" width="16" height="16" alt="" />' +
                '</button>' +
              '</div>' +
              '<p class="lg-error" id="lgEmailError"></p>' +
            '</div>' +

            '<button class="lg-btn lg-btn-primary" type="button" id="lgSendCode" disabled ' +
              'data-i18n="login.sendCode">' + tr('login.sendCode') + '</button>' +
            dividerHtml() +
            '<button class="lg-link lg-link-block" type="button" id="lgBackFromEmail" ' +
              'data-i18n="login.backToSignIn">' + tr('login.backToSignIn') + '</button>' +
          '</div>' +

          // ===== Screen 3: verify the code =====
          '<div class="lg-screen" id="lgCodeScreen" hidden>' +
            '<div class="lg-code-boxes" id="lgCodeBoxes" role="group" aria-label="' + tr('login.codeAria') + '">' +
              codeBoxesHtml() +
            '</div>' +
            '<p class="lg-error lg-error-center" id="lgCodeError"></p>' +

            '<button class="lg-btn lg-btn-primary" type="button" id="lgVerify" disabled ' +
              'data-i18n="login.verify">' + tr('login.verify') + '</button>' +

            '<p class="lg-resend">' +
              '<span data-i18n="login.resendPrompt">' + tr('login.resendPrompt') + '</span> ' +
              '<button class="lg-link" type="button" id="lgResend">' + tr('login.resend') + '</button>' +
            '</p>' +
            dividerHtml() +
            '<button class="lg-link lg-link-block" type="button" id="lgBackFromCode" ' +
              'data-i18n="login.backToSignIn">' + tr('login.backToSignIn') + '</button>' +
          '</div>' +

          // ===== Screen 4: linked =====
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

      '<button class="wxbind-skip" type="button" id="wxbindSkip">' +
        '<span data-i18n="binding.skip">' + tr('binding.skip') + '</span>' +
        '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none">' +
          '<path d="M7.5 4.5L13 10l-5.5 5.5" stroke="currentColor" stroke-width="1.8" ' +
            'stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
      '</button>';
  }

  function setError(node, field, message) {
    node.textContent = message || '';
    node.hidden = !message;
    if (field) field.classList.toggle('is-error', !!message);
  }

  function renderHead() {
    var onCode = state.screen === 'code';
    var onRegister = state.screen === 'register';
    var onSuccess = state.screen === 'success';

    // The linked confirmation stands on its own — no sign-in heading or note.
    el.head.hidden = onSuccess;
    if (onSuccess) {
      el.lead.hidden = true;
      el.note.hidden = true;
      return;
    }

    if (onRegister) {
      el.heading.textContent = tr('signup.heading');
      el.signup.hidden = false;
      el.signupLead.textContent = tr('signup.haveAccount');
      el.signupLink.textContent = tr('signup.backToSignIn');
      el.head.classList.remove('is-stacked');
      el.lead.hidden = true;
      el.note.hidden = true;
      if (root) root.classList.add('is-register');
      return;
    }

    if (root) root.classList.remove('is-register');

    el.heading.textContent = onCode ? tr('login.checkInbox') : tr('login.heading');
    el.signup.hidden = onCode;
    el.signupLead.textContent = tr('login.signupLead');
    el.signupLink.textContent = tr('login.signupLink');
    el.head.classList.toggle('is-stacked', onCode);

    if (state.screen === 'email') {
      el.lead.hidden = false;
      el.lead.innerHTML = '';
      el.lead.textContent = tr('login.otpDescription');
    } else if (onCode) {
      el.lead.hidden = false;
      el.lead.innerHTML = '';
      el.lead.appendChild(document.createTextNode(tr('login.codeSentTo') + ' '));
      var strong = document.createElement('strong');
      strong.textContent = state.email;
      el.lead.appendChild(strong);
      el.lead.appendChild(document.createTextNode(tr('login.codeSentHint')));
    } else {
      el.lead.hidden = true;
      el.lead.textContent = '';
    }

    el.note.hidden = onCode;
    el.noteText.textContent = isQimaUser(state.email)
      ? tr('binding.infoQima')
      : tr('binding.infoSupplier');
  }

  function renderPasswordScreen() {
    setError(el.usernameError, el.usernameField, state.usernameError ? tr('login.usernameRequired') : '');
    setError(el.passwordError, el.passwordField, state.passwordError ? tr('login.passwordRequired') : '');
    setError(el.formError, null, state.formError ? tr('login.credentialsMismatch') : '');

    el.passwordInput.type = state.showPassword ? 'text' : 'password';
    el.eye.classList.toggle('is-visible', state.showPassword);
    el.eye.setAttribute('aria-label', tr(state.showPassword ? 'login.hidePassword' : 'login.showPassword'));
    el.keep.checked = state.keepSignedIn;
  }

  function renderRegisterScreen() {
    var us = el.suCountry.value === 'us';
    el.suStateField.hidden = !us;
    if (!us) {
      el.suState.value = '';
      setError(el.suStateError, el.suStateField, '');
    }

    el.suPass.type = state.showRegPassword ? 'text' : 'password';
    el.suEye.classList.toggle('is-visible', state.showRegPassword);
    el.suEye.setAttribute('aria-label', tr(state.showRegPassword ? 'login.hidePassword' : 'login.showPassword'));
  }

  function renderEmailScreen() {
    setError(el.emailError, el.emailField, state.emailError ? tr(state.emailError) : '');
    el.emailClear.hidden = !state.email;

    var canSend = EMAIL_RE.test(state.email);
    el.sendCode.disabled = !canSend;
  }

  function renderCodeScreen() {
    setError(el.codeError, null, state.codeError ? tr('login.codeMismatch') : '');
    el.codeBoxes.classList.toggle('is-error', state.codeError);
    el.verify.disabled = state.code.length !== CODE_LENGTH;

    var waiting = state.remaining > 0;
    el.resend.disabled = waiting;
    el.resend.textContent = waiting
      ? tr('login.resendIn', {
        mm: pad2(Math.floor(state.remaining / 60)),
        ss: pad2(state.remaining % 60)
      })
      : tr('login.resend');
  }

  function render() {
    renderHead();
    if (state.screen === 'password') renderPasswordScreen();
    if (state.screen === 'register') renderRegisterScreen();
    if (state.screen === 'email') renderEmailScreen();
    if (state.screen === 'code') renderCodeScreen();
  }

  function showScreen(name, focusTarget) {
    state.screen = name;
    el.passwordScreen.hidden = name !== 'password';
    el.registerScreen.hidden = name !== 'register';
    el.emailScreen.hidden = name !== 'email';
    el.codeScreen.hidden = name !== 'code';
    el.success.hidden = name !== 'success';
    render();
    if (name === 'register' && root) {
      try { root.scrollTop = 0; } catch (e) { /* ignore */ }
    }
    if (focusTarget) {
      try { focusTarget.focus(); } catch (e) { /* focus is best-effort */ }
    }
  }

  function stopCountdown() {
    clearInterval(timer);
    timer = null;
    state.remaining = 0;
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

  function clearCode() {
    state.code = '';
    state.codeError = false;
    el.codeInputs.forEach(function (input) { input.value = ''; });
  }

  function readCode() {
    return el.codeInputs.map(function (input) { return input.value; }).join('');
  }

  function dismiss(reason) {
    if (!root) return;
    stopCountdown();
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
    stopCountdown();
    if (root) root.classList.remove('is-register');
    var fromRegister = state.screen === 'register';
    var title = root.querySelector('.wxbind-success-title');
    var desc = root.querySelector('.wxbind-success-desc');
    if (title) title.textContent = tr(fromRegister ? 'signup.successTitle' : 'binding.successTitle');
    if (desc) desc.textContent = tr(fromRegister ? 'signup.successDesc' : 'binding.successDesc');
    showScreen('success');
    setTimeout(function () { dismiss('bound'); }, 1800);
  }

  function goToPasswordScreen() {
    stopCountdown();
    clearCode();
    state.emailError = '';
    showScreen('password', el.username);
  }

  function requestCode() {
    if (!isKnownAccount(state.email)) {
      state.emailError = 'login.emailUnknown';
      render();
      el.email.focus();
      return;
    }
    state.emailError = '';
    clearCode();
    showScreen('code', el.codeInputs[0]);
    startCountdown();
  }

  function bindPasswordEvents() {
    el.username.addEventListener('input', function () {
      state.username = el.username.value.trim();
      state.usernameError = false;
      state.formError = false;
      render();
    });

    el.passwordInput.addEventListener('input', function () {
      state.password = el.passwordInput.value;
      state.passwordError = false;
      state.formError = false;
      render();
    });

    el.eye.addEventListener('click', function () {
      state.showPassword = !state.showPassword;
      render();
      el.passwordInput.focus();
    });

    el.keep.addEventListener('change', function () {
      state.keepSignedIn = el.keep.checked;
    });

    el.signIn.addEventListener('click', function () {
      state.usernameError = !state.username;
      state.passwordError = !el.passwordInput.value;
      if (state.usernameError || state.passwordError) {
        state.formError = false;
        render();
        (state.usernameError ? el.username : el.passwordInput).focus();
        return;
      }
      showSuccess();
    });

    el.otpEntry.addEventListener('click', function () {
      state.emailError = '';
      showScreen('email', el.email);
    });

    el.signupLink.addEventListener('click', function () {
      if (state.screen === 'register') {
        goToPasswordScreen();
        return;
      }
      if (state.screen === 'password' || state.screen === 'email') {
        showScreen('register', el.suFirst);
      }
    });
  }

  function clearRegisterErrors() {
    [
      [el.suFirstError, el.suFirstField],
      [el.suLastError, el.suLastField],
      [el.suCompanyError, el.suCompanyField],
      [el.suCountryError, el.suCountryField],
      [el.suStateError, el.suStateField],
      [el.suIndustryError, el.suIndustryField],
      [el.suEmailError, el.suEmailField],
      [el.suUserError, el.suUserField],
      [el.suPassError, el.suPassField],
      [el.suServiceError, el.suServiceField]
    ].forEach(function (pair) {
      setError(pair[0], pair[1], '');
    });
  }

  function bindRegisterEvents() {
    el.suCountry.addEventListener('change', function () { renderRegisterScreen(); });

    el.suEye.addEventListener('click', function () {
      state.showRegPassword = !state.showRegPassword;
      renderRegisterScreen();
      el.suPass.focus();
    });

    el.suRegister.addEventListener('click', function () {
      clearRegisterErrors();
      var first = el.suFirst.value.trim();
      var last = el.suLast.value.trim();
      var company = el.suCompany.value.trim();
      var country = el.suCountry.value;
      var stateVal = el.suState.value;
      var industry = el.suIndustry.value;
      var email = el.suEmail.value.trim();
      var user = el.suUser.value.trim();
      var pass = el.suPass.value;
      var service = el.suService.value;
      var ok = true;
      var focusEl = null;

      function fail(errorNode, field, messageKey, input) {
        setError(errorNode, field, tr(messageKey));
        if (!focusEl && input) focusEl = input;
        ok = false;
      }

      if (!first) fail(el.suFirstError, el.suFirstField, 'signup.required', el.suFirst);
      if (!last) fail(el.suLastError, el.suLastField, 'signup.required', el.suLast);
      if (!company) fail(el.suCompanyError, el.suCompanyField, 'signup.required', el.suCompany);
      if (!country) fail(el.suCountryError, el.suCountryField, 'signup.required', el.suCountry);
      if (country === 'us' && !stateVal) fail(el.suStateError, el.suStateField, 'signup.required', el.suState);
      if (!industry) fail(el.suIndustryError, el.suIndustryField, 'signup.required', el.suIndustry);
      if (!email) fail(el.suEmailError, el.suEmailField, 'signup.required', el.suEmail);
      else if (!EMAIL_RE.test(email)) fail(el.suEmailError, el.suEmailField, 'login.emailInvalid', el.suEmail);
      if (!user) fail(el.suUserError, el.suUserField, 'signup.required', el.suUser);
      if (!pass) fail(el.suPassError, el.suPassField, 'signup.required', el.suPass);
      if (!service) fail(el.suServiceError, el.suServiceField, 'signup.required', el.suService);

      if (!ok) {
        if (focusEl) focusEl.focus();
        return;
      }

      // Demo: creating an account also links WeChat, then lands on home.
      state.email = email;
      showSuccess();
    });
  }

  function bindEmailEvents() {
    el.email.addEventListener('input', function () {
      state.email = el.email.value.trim();
      state.emailError = '';
      render();
    });

    el.email.addEventListener('blur', function () {
      if (!state.email) {
        state.emailError = 'login.emailRequired';
      } else if (!EMAIL_RE.test(state.email)) {
        state.emailError = 'login.emailInvalid';
      }
      render();
    });

    el.emailClear.addEventListener('click', function () {
      el.email.value = '';
      state.email = '';
      state.emailError = '';
      render();
      el.email.focus();
    });

    el.sendCode.addEventListener('click', function () {
      if (el.sendCode.disabled) return;
      requestCode();
    });

    el.backFromEmail.addEventListener('click', goToPasswordScreen);
  }

  function focusBox(index) {
    var input = el.codeInputs[Math.max(0, Math.min(CODE_LENGTH - 1, index))];
    if (input) input.focus();
  }

  /** Spread a multi-digit string (paste or autofill) across the boxes. */
  function distribute(index, digits) {
    digits.split('').slice(0, CODE_LENGTH - index).forEach(function (digit, offset) {
      el.codeInputs[index + offset].value = digit;
    });
    focusBox(index + digits.length);
    state.code = readCode();
    state.codeError = false;
    render();
  }

  function bindCodeEvents() {
    el.codeInputs.forEach(function (input, index) {
      input.addEventListener('focus', function () { input.select(); });

      // maxlength="1" truncates a pasted code, so read the clipboard directly.
      input.addEventListener('paste', function (event) {
        var clipboard = event.clipboardData || global.clipboardData;
        var digits = String(clipboard ? clipboard.getData('text') : '').replace(/\D/g, '');
        if (!digits) return;
        event.preventDefault();
        distribute(index, digits);
      });

      input.addEventListener('input', function () {
        var digits = input.value.replace(/\D/g, '');
        if (digits.length > 1) {
          distribute(index, digits);
          return;
        }
        input.value = digits;
        if (digits) focusBox(index + 1);
        state.code = readCode();
        state.codeError = false;
        render();
      });

      input.addEventListener('keydown', function (event) {
        if (event.key === 'Backspace' && !input.value && index > 0) {
          event.preventDefault();
          el.codeInputs[index - 1].value = '';
          state.code = readCode();
          focusBox(index - 1);
          render();
        }
        if (event.key === 'ArrowLeft') focusBox(index - 1);
        if (event.key === 'ArrowRight') focusBox(index + 1);
      });
    });

    el.verify.addEventListener('click', function () {
      if (el.verify.disabled) return;
      if (state.code === REJECTED_CODE) {
        state.codeError = true;
        render();
        // Boxes keep the rejected digits; each one selects on focus so typing
        // straight over the code replaces it digit by digit.
        focusBox(0);
        return;
      }
      showSuccess();
    });

    el.resend.addEventListener('click', function () {
      if (el.resend.disabled) return;
      clearCode();
      focusBox(0);
      startCountdown();
    });

    el.backFromCode.addEventListener('click', goToPasswordScreen);
  }

  function bindEvents() {
    bindPasswordEvents();
    bindRegisterEvents();
    bindEmailEvents();
    bindCodeEvents();
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
      head: root.querySelector('#lgHead'),
      heading: root.querySelector('#lgHeading'),
      signup: root.querySelector('#lgSignup'),
      signupLead: root.querySelector('#lgSignup [data-i18n="login.signupLead"]') || root.querySelector('#lgSignup span'),
      signupLink: root.querySelector('#lgSignupLink'),
      lead: root.querySelector('#lgLead'),
      note: root.querySelector('#lgNote'),
      noteText: root.querySelector('#wxbindNote'),

      passwordScreen: root.querySelector('#lgPasswordScreen'),
      usernameField: root.querySelector('#lgUsernameField'),
      username: root.querySelector('#lgUsername'),
      usernameError: root.querySelector('#lgUsernameError'),
      passwordField: root.querySelector('#lgPasswordField'),
      passwordInput: root.querySelector('#lgPassword'),
      passwordError: root.querySelector('#lgPasswordError'),
      eye: root.querySelector('#lgEye'),
      keep: root.querySelector('#lgKeep'),
      formError: root.querySelector('#lgFormError'),
      signIn: root.querySelector('#lgSignIn'),
      otpEntry: root.querySelector('#lgOtpEntry'),

      registerScreen: root.querySelector('#lgRegisterScreen'),
      suFirst: root.querySelector('#suFirst'),
      suFirstField: root.querySelector('#suFirstField'),
      suFirstError: root.querySelector('#suFirstError'),
      suLast: root.querySelector('#suLast'),
      suLastField: root.querySelector('#suLastField'),
      suLastError: root.querySelector('#suLastError'),
      suCompany: root.querySelector('#suCompany'),
      suCompanyField: root.querySelector('#suCompanyField'),
      suCompanyError: root.querySelector('#suCompanyError'),
      suCountry: root.querySelector('#suCountry'),
      suCountryField: root.querySelector('#suCountryField'),
      suCountryError: root.querySelector('#suCountryError'),
      suState: root.querySelector('#suState'),
      suStateField: root.querySelector('#suStateField'),
      suStateError: root.querySelector('#suStateError'),
      suIndustry: root.querySelector('#suIndustry'),
      suIndustryField: root.querySelector('#suIndustryField'),
      suIndustryError: root.querySelector('#suIndustryError'),
      suPhone: root.querySelector('#suPhone'),
      suEmail: root.querySelector('#suEmail'),
      suEmailField: root.querySelector('#suEmailField'),
      suEmailError: root.querySelector('#suEmailError'),
      suUser: root.querySelector('#suUser'),
      suUserField: root.querySelector('#suUserField'),
      suUserError: root.querySelector('#suUserError'),
      suPass: root.querySelector('#suPass'),
      suPassField: root.querySelector('#suPassField'),
      suPassError: root.querySelector('#suPassError'),
      suEye: root.querySelector('#suEye'),
      suService: root.querySelector('#suService'),
      suServiceField: root.querySelector('#suServiceField'),
      suServiceError: root.querySelector('#suServiceError'),
      suSubscribe: root.querySelector('#suSubscribe'),
      suRegister: root.querySelector('#suRegister'),

      emailScreen: root.querySelector('#lgEmailScreen'),
      emailField: root.querySelector('#lgEmailField'),
      email: root.querySelector('#lgEmail'),
      emailError: root.querySelector('#lgEmailError'),
      emailClear: root.querySelector('#lgEmailClear'),
      sendCode: root.querySelector('#lgSendCode'),
      backFromEmail: root.querySelector('#lgBackFromEmail'),

      codeScreen: root.querySelector('#lgCodeScreen'),
      codeBoxes: root.querySelector('#lgCodeBoxes'),
      codeInputs: Array.prototype.slice.call(root.querySelectorAll('.lg-code-box')),
      codeError: root.querySelector('#lgCodeError'),
      verify: root.querySelector('#lgVerify'),
      resend: root.querySelector('#lgResend'),
      backFromCode: root.querySelector('#lgBackFromCode'),

      success: root.querySelector('#wxbindSuccess'),
      skip: root.querySelector('#wxbindSkip')
    };

    bindEvents();
    if (global.I18n && typeof global.I18n.applyPageI18n === 'function') {
      global.I18n.applyPageI18n(root);
    }
    showScreen('password');
  }

  function fillCode(value) {
    String(value).split('').slice(0, CODE_LENGTH).forEach(function (digit, index) {
      el.codeInputs[index].value = digit;
    });
    state.code = readCode();
  }

  global.QimaWechatBinding = {
    STORAGE_KEY: STORAGE_KEY,
    reset: function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    },
    /** Debug helper: jump straight to a screen state without typing. */
    goTo: function (stateName) {
      if (!root) return;
      if (stateName === 'password-filled') {
        el.username.value = 'lyon.li';
        el.passwordInput.value = 'demo-password';
        state.username = el.username.value;
        state.password = el.passwordInput.value;
        state.keepSignedIn = true;
      } else if (stateName === 'password-required') {
        state.usernameError = true;
        state.passwordError = true;
      } else if (stateName === 'password-mismatch') {
        el.username.value = 'lyon.li';
        el.passwordInput.value = 'demo-password';
        state.username = el.username.value;
        state.formError = true;
      } else if (stateName === 'email') {
        showScreen('email');
        return;
      } else if (stateName === 'email-filled') {
        showScreen('email');
        el.email.value = '2141243@sunrisetoys.com';
        state.email = el.email.value;
      } else if (stateName === 'email-error') {
        showScreen('email');
        el.email.value = '2141243@qq.com';
        state.email = el.email.value;
        state.emailError = 'login.emailUnknown';
      } else if (stateName === 'code') {
        el.email.value = '2141243@sunrisetoys.com';
        state.email = el.email.value;
        showScreen('code');
        startCountdown();
        return;
      } else if (stateName === 'code-error') {
        el.email.value = '2141243@sunrisetoys.com';
        state.email = el.email.value;
        showScreen('code');
        startCountdown();
        fillCode(REJECTED_CODE);
        state.codeError = true;
      } else if (stateName === 'register') {
        showScreen('register', el.suFirst);
        return;
      } else if (stateName === 'register-filled') {
        showScreen('register');
        el.suFirst.value = 'Lyon';
        el.suLast.value = 'Li';
        el.suCompany.value = 'Sunrise Toys Co., Ltd.';
        el.suCountry.value = 'cn';
        el.suIndustry.value = 'toys';
        el.suEmail.value = 'lyon.li@sunrisetoys.com';
        el.suUser.value = 'lyon.li';
        el.suPass.value = 'DemoPass1';
        el.suService.value = 'lab';
        renderRegisterScreen();
        return;
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
