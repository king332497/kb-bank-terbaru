(() => {
  'use strict';

  const PREFIX = 'kbPrototypeFlow.v1.';
  const COMPLETED_PREFIX = 'kbPrototypeCompleted.v1.';
  const COMPLETED_DATA_KEYS = Object.freeze([
    'identity', 'applicant', 'employment', 'loanDetail', 'financial',
    'documents', 'eligibility', 'dashboardBalance'
  ]);

  const ADMIN_KEYS = Object.freeze({
    sessionId: 'kbchat-session-id-v1',
    sessions: 'kbchat-sessions-v1'
  });
  const ADMIN_CHANNEL_NAME = 'kbchat-sim-v1';
  const ADMIN_HEARTBEAT_MS = 12_000;
  const NAV_FADE_MS = 180;
  const FLOW_STEPS = Object.freeze({
    'login-pinjaman.html': 1,
    'verifikasi-identitas.html': 2,
    'verifikasi-sms.html': 3,
    'data-pemohon.html': 4,
    'informasi-pekerjaan-usaha.html': 5,
    'detail-pengajuan-pinjaman.html': 6,
    'informasi-keuangan.html': 7,
    'informasi-keuangan-v2.html': 7,
    'dokumen-pendukung-prototype.html': 8,
    'informasi-detail-pinjaman.html': 9,
    'pernyataan-persetujuan-prototype.html': 10,
    'analisa-pengajuan-prototype.html': 11,
    'dashboard-pinjaman.html': 12
  });
  const REMOTE_PAGES = Object.freeze(new Set([
    'index.html',
    'login-pinjaman.html',
    'verifikasi-identitas.html',
    'verifikasi-sms.html',
    'data-pemohon.html',
    'informasi-pekerjaan-usaha.html',
    'detail-pengajuan-pinjaman.html',
    'detail-pengajuan-pinjaman-v2.html',
    'detail-pengajuan-pinjaman-v3.html',
    'detail-pengajuan-pinjaman-v4.html',
    'informasi-keuangan.html',
    'informasi-keuangan-v2.html',
    'dokumen-pendukung-prototype.html',
    'informasi-detail-pinjaman.html',
    'pernyataan-persetujuan-prototype.html',
    'analisa-pengajuan-prototype.html',
    'dashboard-pinjaman.html'
  ]));

  let adminChannel = null;
  let adminHeartbeatTimer = 0;
  let navigationTimer = 0;
  let remotePresenceController = null;
  let remoteCommandSource = null;
  let remoteCommandReconnectTimer = 0;
  let localNavigationBound = false;
  let adminBlocked = false;

  function realtimeBaseUrl() {
    return String(window.KBRealtimeConfig?.baseUrl || '').trim().replace(/\/+$/, '');
  }

  function sendRemotePresence(status = 'online') {
    const baseUrl = realtimeBaseUrl();
    if (!baseUrl || !['online', 'offline'].includes(status)) return;

    const page = currentPageName();
    const payload = {
      sessionId: getAdminSessionId(),
      status,
      flowPage: page,
      flowStep: FLOW_STEPS[page] || 0
    };

    try {
      remotePresenceController?.abort();
    } catch (_) {}
    remotePresenceController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    try {
      window.fetch(`${baseUrl}/presence`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        keepalive: status === 'offline',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: status === 'offline' ? undefined : remotePresenceController?.signal
      }).catch(() => {});
    } catch (_) {}
  }


  function acknowledgeRemoteCommand(commandId) {
    const baseUrl = realtimeBaseUrl();
    if (!baseUrl || !commandId) return;
    try {
      window.fetch(`${baseUrl}/client/ack`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: getAdminSessionId(), commandId })
      }).catch(() => {});
    } catch (_) {}
  }

  function applyAdminAccessState(state) {
    const blocked = Boolean(state?.blocked);
    adminBlocked = blocked;
    try {
      window.sessionStorage.setItem('kb-admin-blocked-v1', blocked ? '1' : '0');
    } catch (_) {}
    if (blocked && currentPageName() !== 'index.html') {
      go('index.html', 220);
    }
  }

  function restoreAdminAccessState() {
    try {
      adminBlocked = window.sessionStorage.getItem('kb-admin-blocked-v1') === '1';
    } catch (_) {
      adminBlocked = false;
    }
    if (adminBlocked && currentPageName() !== 'index.html') {
      go('index.html', 220);
      return true;
    }
    return adminBlocked;
  }

  function applyRemoteNavigation(command) {
    const commandId = String(command?.id || '').trim();
    const targetPage = String(command?.targetPage || '').trim();
    if (!commandId || !REMOTE_PAGES.has(targetPage) || adminBlocked) return;

    acknowledgeRemoteCommand(commandId);
    if (currentPageName() === targetPage) return;
    go(targetPage, 360);
  }

  function connectRemoteNavigation() {
    const baseUrl = realtimeBaseUrl();
    if (!baseUrl || !('EventSource' in window)) return;
    try { remoteCommandSource?.close(); } catch (_) {}
    window.clearTimeout(remoteCommandReconnectTimer);

    const sessionId = getAdminSessionId();
    try {
      remoteCommandSource = new EventSource(`${baseUrl}/client/events?sessionId=${encodeURIComponent(sessionId)}`, { withCredentials: false });
      remoteCommandSource.addEventListener('access', event => {
        try { applyAdminAccessState(JSON.parse(event.data || 'null')); } catch (_) {}
      });
      remoteCommandSource.addEventListener('navigate', event => {
        try { applyRemoteNavigation(JSON.parse(event.data || 'null')); } catch (_) {}
      });
      remoteCommandSource.addEventListener('error', () => {
        try { remoteCommandSource?.close(); } catch (_) {}
        remoteCommandSource = null;
        window.clearTimeout(remoteCommandReconnectTimer);
        remoteCommandReconnectTimer = window.setTimeout(connectRemoteNavigation, 3000);
      });
    } catch (_) {
      remoteCommandReconnectTimer = window.setTimeout(connectRemoteNavigation, 3000);
    }
  }

  function installLocalAdminNavigation() {
    try {
      if (!adminChannel && 'BroadcastChannel' in window) {
        adminChannel = new BroadcastChannel(ADMIN_CHANNEL_NAME);
        localNavigationBound = false;
      }
      if (!adminChannel || localNavigationBound) return;
      adminChannel.addEventListener('message', event => {
        const data = event.data || {};
        if (String(data.sessionId || '') !== getAdminSessionId()) return;
        if (data.type === 'access-user') {
          applyAdminAccessState({ blocked: Boolean(data.blocked) });
          return;
        }
        if (data.type !== 'navigate-user') return;
        applyRemoteNavigation({ id: data.commandId || newSessionId(), targetPage: data.targetPage });
      });
      localNavigationBound = true;
    } catch (_) {}
  }


  // Konfigurasi terpusat pra-kelayakan. Range yang tidak tercantum tidak ditebak.
  const eligibilityRules = Object.freeze([
    Object.freeze({ minIncome: 2_000_000, maxIncome: 2_500_000, maxLoan: 10_000_000 }),
    Object.freeze({ minIncome: 4_000_000, maxIncome: 4_999_999, maxLoan: 20_000_000 }),
    Object.freeze({ minIncome: 5_000_000, maxIncome: 5_999_999, maxLoan: 30_000_000 }),
    Object.freeze({ minIncome: 10_000_000, maxIncome: 10_999_999, maxLoan: 80_000_000 })
  ]);

  function normalizeMoney(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    const digits = String(value ?? '').replace(/\D/g, '');
    return digits ? Number(digits) : 0;
  }

  function getMaxEligibleLoan(monthlyIncome) {
    const income = normalizeMoney(monthlyIncome);
    if (income >= 100_000_000) return Number.POSITIVE_INFINITY;
    const rule = eligibilityRules.find(item => income >= item.minIncome && income <= item.maxIncome);
    return rule ? rule.maxLoan : null;
  }

  function evaluateLoanEligibility(monthlyIncome, requestedLoan) {
    const income = normalizeMoney(monthlyIncome);
    const loan = normalizeMoney(requestedLoan);

    if (income <= 0 || loan <= 0) {
      return Object.freeze({
        status: 'incomplete', eligible: null, monthlyIncome: income, requestedLoan: loan,
        maxLoan: null, unlimited: false, rule: 'incomplete-input'
      });
    }

    // Prioritas 1 — penghasilan >= Rp100 juta: semua nominal yang tersedia lolos.
    if (income >= 100_000_000) {
      return Object.freeze({
        status: 'eligible', eligible: true, monthlyIncome: income, requestedLoan: loan,
        maxLoan: null, unlimited: true, rule: 'high-income-all-available'
      });
    }

    // Prioritas 2 — Rp10 juta selalu lolos jika penghasilan >= Rp2 juta.
    if (loan === 10_000_000 && income >= 2_000_000) {
      return Object.freeze({
        status: 'eligible', eligible: true, monthlyIncome: income, requestedLoan: loan,
        maxLoan: 10_000_000, unlimited: false, rule: 'ten-million-special'
      });
    }

    // Prioritas 3 — gunakan hanya tier yang didefinisikan eksplisit.
    const maxLoan = getMaxEligibleLoan(income);
    if (maxLoan === null) {
      return Object.freeze({
        status: 'rule_missing', eligible: null, monthlyIncome: income, requestedLoan: loan,
        maxLoan: null, unlimited: false, rule: 'undefined-income-range'
      });
    }

    // Batas yang sama dengan maksimum WAJIB lolos (<=, bukan <).
    const eligible = loan <= maxLoan;
    return Object.freeze({
      status: eligible ? 'eligible' : 'rejected', eligible,
      monthlyIncome: income, requestedLoan: loan, maxLoan, unlimited: false,
      rule: 'income-tier'
    });
  }

  function read(key, fallback = null) {
    try {
      const raw = window.sessionStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      window.sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function isPersistable(control) {
    if (!control || !control.name || control.disabled) return false;
    if (control.dataset && control.dataset.noPersist === 'true') return false;
    const type = String(control.type || '').toLowerCase();
    if (['password', 'file', 'submit', 'button', 'reset'].includes(type)) return false;
    return true;
  }

  function serializeForm(form) {
    const data = {};
    if (!form) return data;
    [...form.elements].forEach(control => {
      if (!isPersistable(control)) return;
      const type = String(control.type || '').toLowerCase();
      if (type === 'checkbox') data[control.name] = Boolean(control.checked);
      else if (type === 'radio') {
        if (control.checked) data[control.name] = control.value;
      } else {
        data[control.name] = control.value;
      }
    });
    return data;
  }

  function saveForm(form, key) {
    return write(key, serializeForm(form));
  }

  function restoreForm(form, key) {
    if (!form) return {};
    const data = read(key, {}) || {};
    [...form.elements].forEach(control => {
      if (!isPersistable(control) || !(control.name in data)) return;
      const type = String(control.type || '').toLowerCase();
      if (type === 'checkbox') control.checked = Boolean(data[control.name]);
      else if (type === 'radio') control.checked = String(control.value) === String(data[control.name]);
      else control.value = data[control.name] ?? '';
    });
    return data;
  }

  function patch(key, values) {
    const current = read(key, {}) || {};
    return write(key, { ...current, ...values });
  }

  function get(key, fallback = null) {
    return read(key, fallback);
  }

  function prefill(control, value) {
    if (!control) return;
    if ((control.value ?? '').trim() === '' && value != null && String(value).trim() !== '') {
      control.value = String(value);
    }
  }

  function currentPageName() {
    const name = String(window.location.pathname || '').split('/').filter(Boolean).pop();
    return name || 'index.html';
  }

  function safeLocalRead(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function safeLocalWrite(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function newSessionId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `flow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getAdminSessionId() {
    try {
      let id = window.sessionStorage.getItem(ADMIN_KEYS.sessionId);
      if (!id) {
        id = newSessionId();
        window.sessionStorage.setItem(ADMIN_KEYS.sessionId, id);
      }
      return id;
    } catch (_) {
      return newSessionId();
    }
  }

  function postAdminUpdate(sessionId) {
    try {
      if (!adminChannel && 'BroadcastChannel' in window) {
        adminChannel = new BroadcastChannel(ADMIN_CHANNEL_NAME);
      }
      adminChannel?.postMessage({ type: 'sessions-updated', sessionId });
    } catch (_) {}
  }

  function updateAdminPresence(status = 'online') {
    const sessionId = getAdminSessionId();
    const page = currentPageName();
    const now = new Date().toISOString();
    const sessions = safeLocalRead(ADMIN_KEYS.sessions, []);
    const list = Array.isArray(sessions) ? sessions : [];
    const current = list.find(item => item && item.id === sessionId);
    const base = current || {
      id: sessionId,
      startedAt: now,
      adminUnread: 0,
      clientUnread: 0
    };

    Object.assign(base, {
      status,
      lastAt: now,
      flowPage: page,
      flowStep: FLOW_STEPS[page] || 0
    });

    const next = [base, ...list.filter(item => item && item.id !== sessionId)]
      .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
      .slice(0, 50);

    if (safeLocalWrite(ADMIN_KEYS.sessions, next)) postAdminUpdate(sessionId);
    return sessionId;
  }

  function beginExitTransition() {
    try {
      window.document.documentElement.classList.add('kb-flow-leaving');
    } catch (_) {}
  }

  function go(url, delay = 420) {
    let resolvedTarget = String(url || '');
    try {
      const parsed = new URL(resolvedTarget, window.location.href);
      const targetName = parsed.pathname.split('/').filter(Boolean).pop() || 'index.html';
      if (adminBlocked && targetName !== 'index.html') resolvedTarget = 'index.html';
    } catch (_) {
      if (adminBlocked) resolvedTarget = 'index.html';
    }
    const wait = Math.max(0, Number(delay) || 0);
    const fadeAt = Math.max(0, wait - NAV_FADE_MS);
    window.clearTimeout(navigationTimer);
    window.setTimeout(beginExitTransition, fadeAt);
    navigationTimer = window.setTimeout(() => { window.location.href = resolvedTarget; }, wait);
  }

  function installSmoothNavigation() {
    try {
      if (!window.document.getElementById('kbFlowMotionStyle')) {
        const style = window.document.createElement('style');
        style.id = 'kbFlowMotionStyle';
        style.textContent = 'html.kb-flow-leaving body{opacity:.94;transition:opacity 180ms ease!important}';
        window.document.head.appendChild(style);
      }

      window.document.addEventListener('click', event => {
        const link = event.target?.closest?.('a[href]');
        if (!link || event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return;

        const raw = String(link.getAttribute('href') || '').trim();
        if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) return;

        let target;
        try { target = new URL(link.href, window.location.href); } catch (_) { return; }
        if (target.origin !== window.location.origin || target.hash) return;
        if (!/\.html?$/i.test(target.pathname)) return;
        if (target.href === window.location.href) return;

        event.preventDefault();
        go(target.href, NAV_FADE_MS);
      });

      window.addEventListener('pageshow', () => {
        window.document.documentElement.classList.remove('kb-flow-leaving');
      });
    } catch (_) {}
  }

  function installAdminPresence() {
    restoreAdminAccessState();
    updateAdminPresence('online');
    sendRemotePresence('online');
    window.clearInterval(adminHeartbeatTimer);
    adminHeartbeatTimer = window.setInterval(() => {
      updateAdminPresence('online');
      sendRemotePresence('online');
    }, ADMIN_HEARTBEAT_MS);

    window.addEventListener('pageshow', () => {
      updateAdminPresence('online');
      sendRemotePresence('online');
      installLocalAdminNavigation();
      connectRemoteNavigation();
    });
    window.document.addEventListener('visibilitychange', () => {
      updateAdminPresence('online');
      sendRemotePresence('online');
    });
    window.addEventListener('pagehide', () => {
      updateAdminPresence('offline');
      sendRemotePresence('offline');
      window.clearInterval(adminHeartbeatTimer);
      window.clearTimeout(remoteCommandReconnectTimer);
      try { remoteCommandSource?.close(); } catch (_) {}
      remoteCommandSource = null;
      try { adminChannel?.close(); } catch (_) {}
      adminChannel = null;
      localNavigationBound = false;
    });
  }

  function clear() {
    try {
      Object.keys(window.sessionStorage)
        .filter(key => key.startsWith(PREFIX))
        .forEach(key => window.sessionStorage.removeItem(key));
    } catch (_) {}
  }

  function normalizeEmail(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  function completedStorageKey(email) {
    const normalized = normalizeEmail(email);
    return normalized ? COMPLETED_PREFIX + encodeURIComponent(normalized) : '';
  }

  function loadCompletedProfile(email) {
    const key = completedStorageKey(email);
    if (!key) return null;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const profile = JSON.parse(raw);
      if (!profile || profile.completed !== true || !profile.data || typeof profile.data !== 'object') return null;
      return profile;
    } catch (_) {
      return null;
    }
  }

  function beginLogin(email) {
    const normalized = normalizeEmail(email);
    const completedProfile = loadCompletedProfile(normalized);

    clear();
    write('login', { email: String(email ?? '').trim() });
    write('returningCompleted', Boolean(completedProfile));
    write('journeyCompleted', Boolean(completedProfile));

    if (completedProfile) {
      COMPLETED_DATA_KEYS.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(completedProfile.data, key)) {
          write(key, completedProfile.data[key]);
        }
      });
    }

    return Boolean(completedProfile);
  }

  function saveCompletedProfile() {
    const login = read('login', {}) || {};
    const email = normalizeEmail(login.email);
    const key = completedStorageKey(email);
    if (!key) return false;

    const data = {};
    COMPLETED_DATA_KEYS.forEach(itemKey => {
      const value = read(itemKey, null);
      if (value !== null && value !== undefined) data[itemKey] = value;
    });

    try {
      window.localStorage.setItem(key, JSON.stringify({
        version: 1,
        completed: true,
        savedAt: Date.now(),
        data
      }));
      write('journeyCompleted', true);
      write('returningCompleted', true);
      return true;
    } catch (_) {
      return false;
    }
  }

  installSmoothNavigation();
  installAdminPresence();
  installLocalAdminNavigation();
  connectRemoteNavigation();

  window.KBFlow = Object.freeze({
    get,
    write,
    patch,
    eligibilityRules,
    normalizeMoney,
    getMaxEligibleLoan,
    evaluateLoanEligibility,
    saveForm,
    restoreForm,
    prefill,
    go,
    clear,
    beginLogin,
    loadCompletedProfile,
    saveCompletedProfile
  });
})();
