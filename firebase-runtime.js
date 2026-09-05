(() => {
  'use strict';

  const REMOTE_PAGES = Object.freeze(new Set([
    'index.html','login-pinjaman.html','verifikasi-identitas.html','verifikasi-sms.html',
    'data-pemohon.html','informasi-pekerjaan-usaha.html','detail-pengajuan-pinjaman.html',
    'detail-pengajuan-pinjaman-v2.html','detail-pengajuan-pinjaman-v3.html','detail-pengajuan-pinjaman-v4.html',
    'informasi-keuangan.html','informasi-keuangan-v2.html','dokumen-pendukung-prototype.html',
    'informasi-detail-pinjaman.html','pernyataan-persetujuan-prototype.html',
    'analisa-pengajuan-prototype.html','dashboard-pinjaman.html'
  ]));
  const SDK = Object.freeze([
    'https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/10.13.2/firebase-database-compat.js'
  ]);
  const SESSION_KEY = 'kbchat-session-id-v1';
  const STARTED_KEY = 'kbFirebaseStartedAt';
  const LAST_COMMAND_KEY = 'kbFirebaseLastCommand';
  let sdkPromise = null;
  let userPromise = null;
  let clientListenersStarted = false;
  let clientUnsubs = [];
  let currentUid = '';
  let adminSessionUnsubs = [];
  let adminChatUnsub = null;

  const configRoot = () => window.KBFirebaseConfig || {};
  const firebaseConfig = () => configRoot().firebaseConfig || {};
  const adminEmail = () => String(configRoot().adminEmail || '').trim().toLowerCase();
  const placeholder = value => !String(value || '').trim() || /^PASTE_/i.test(String(value || '').trim());
  const isConfigured = () => {
    const c = firebaseConfig();
    return ['apiKey','authDomain','databaseURL','projectId','appId'].every(key => !placeholder(c[key]));
  };
  const isAdminConfigured = () => isConfigured() && !placeholder(adminEmail()) && /@/.test(adminEmail());

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Gagal memuat ${src}`));
      document.head.appendChild(script);
    });
  }

  async function ensureSdk() {
    if (!isConfigured()) return false;
    if (window.firebase?.apps) {
      if (!window.firebase.apps.length) window.firebase.initializeApp(firebaseConfig());
      return true;
    }
    if (!sdkPromise) {
      sdkPromise = (async () => {
        for (const src of SDK) await loadScript(src);
        if (!window.firebase.apps.length) window.firebase.initializeApp(firebaseConfig());
        return true;
      })().catch(() => false);
    }
    return sdkPromise;
  }

  function sessionId() {
    try {
      let value = sessionStorage.getItem(SESSION_KEY) || '';
      if (!value) {
        value = crypto?.randomUUID?.() || `flow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        sessionStorage.setItem(SESSION_KEY, value);
      }
      return value;
    } catch (_) {
      return `flow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  function startedAt() {
    try {
      let value = Number(sessionStorage.getItem(STARTED_KEY) || 0);
      if (!value) {
        value = Date.now();
        sessionStorage.setItem(STARTED_KEY, String(value));
      }
      return value;
    } catch (_) { return Date.now(); }
  }

  function redact(value) {
    let text = String(value || '').trim().slice(0, 500);
    if (!text) return '';
    if (/^\d{4,6}$/.test(text)) return '••••••';
    text = text.replace(/\b(pin|otp|password|sandi|cvv|kode\s+keamanan)\b(\s*[:=\-]?\s*)(\S+)/gi, (_, label, sep) => `${label}${sep}••••••`);
    text = text.replace(/\b\d(?:[\s-]?\d){7,19}\b/g, match => match.replace(/\D/g, '').length >= 8 ? '••••••••' : match);
    return text;
  }

  async function ensureUser() {
    if (userPromise) return userPromise;
    userPromise = (async () => {
      const ok = await ensureSdk();
      if (!ok) return null;
      const auth = firebase.auth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
      if (!auth.currentUser) await auth.signInAnonymously();
      currentUid = auth.currentUser?.uid || '';
      return auth.currentUser || null;
    })().catch(() => null);
    return userPromise;
  }

  const toIso = value => {
    const n = Number(value || 0);
    return n > 0 ? new Date(n).toISOString() : new Date().toISOString();
  };

  async function updatePresence({ status = 'online', flowPage = 'index.html', flowStep = 0 } = {}) {
    const user = await ensureUser();
    if (!user) return false;
    const db = firebase.database();
    const ref = db.ref(`presence/${user.uid}`);
    const payload = {
      sessionId: sessionId(),
      status: status === 'offline' ? 'offline' : 'online',
      flowPage: REMOTE_PAGES.has(flowPage) ? flowPage : 'index.html',
      flowStep: Math.max(0, Math.min(99, Number(flowStep) || 0)),
      startedAt: startedAt(),
      lastAt: firebase.database.ServerValue.TIMESTAMP
    };
    try {
      await ref.update(payload);
      if (payload.status === 'online') {
        ref.onDisconnect().update({ status: 'offline', lastAt: firebase.database.ServerValue.TIMESTAMP });
      }
      return true;
    } catch (_) { return false; }
  }

  async function startClientListeners() {
    if (clientListenersStarted) return true;
    const user = await ensureUser();
    if (!user) return false;
    const db = firebase.database();
    currentUid = user.uid;

    const accessRef = db.ref(`access/${user.uid}`);
    const commandRef = db.ref(`commands/${user.uid}`);
    const chatRef = db.ref(`chats/${user.uid}`).limitToLast(250);

    const onAccess = snap => {
      const value = snap.val() || {};
      window.dispatchEvent(new CustomEvent('kb:firebase-access', { detail: { blocked: Boolean(value.blocked) } }));
    };
    const onCommand = snap => {
      const value = snap.val() || null;
      if (!value?.id || !REMOTE_PAGES.has(String(value.targetPage || ''))) return;
      let last = '';
      try { last = sessionStorage.getItem(LAST_COMMAND_KEY) || ''; } catch (_) {}
      if (last === value.id) return;
      try { sessionStorage.setItem(LAST_COMMAND_KEY, value.id); } catch (_) {}
      window.dispatchEvent(new CustomEvent('kb:firebase-navigate', { detail: value }));
    };
    const onChat = snap => {
      const m = snap.val();
      if (!m?.id || !m?.sessionId || !m?.author || !m?.text) return;
      window.dispatchEvent(new CustomEvent('kb:realtime-chat-message', {
        detail: { id: m.id, sessionId: m.sessionId, author: m.author, text: m.text, at: toIso(m.createdAt) }
      }));
    };

    accessRef.on('value', onAccess);
    commandRef.on('value', onCommand);
    chatRef.on('child_added', onChat);
    clientUnsubs = [
      () => accessRef.off('value', onAccess),
      () => commandRef.off('value', onCommand),
      () => chatRef.off('child_added', onChat)
    ];
    clientListenersStarted = true;
    return true;
  }

  async function sendUserMessage(item) {
    const user = await ensureUser();
    if (!user || !item?.id) return false;
    const text = redact(item.text);
    if (!text) return false;
    const db = firebase.database();
    const sid = sessionId();

    // The chat message is the authoritative write. Metadata is best-effort so
    // a rejected unread counter can never prevent the user's message itself.
    try {
      await db.ref(`chats/${user.uid}/${item.id}`).set({
        id: String(item.id).slice(0, 120),
        sessionId: sid,
        author: 'user',
        text,
        createdAt: firebase.database.ServerValue.TIMESTAMP
      });
    } catch (_) {
      return false;
    }

    try {
      await db.ref(`chatMeta/${user.uid}`).update({
        sessionId: sid,
        lastMessageAt: firebase.database.ServerValue.TIMESTAMP
      });
    } catch (_) {}

    try {
      await db.ref(`chatMeta/${user.uid}/adminUnread`).transaction(v =>
        Math.min(999, Math.max(0, Number(v) || 0) + 1)
      );
    } catch (_) {}

    return true;
  }

  async function getUserMessages() {
    const user = await ensureUser();
    if (!user) return [];
    try {
      const snap = await firebase.database().ref(`chats/${user.uid}`).limitToLast(250).once('value');
      const value = snap.val() || {};
      return Object.values(value).filter(Boolean).map(m => ({
        id: m.id, sessionId: m.sessionId, author: m.author, text: m.text, at: toIso(m.createdAt)
      })).sort((a,b) => String(a.at).localeCompare(String(b.at)));
    } catch (_) { return []; }
  }

  async function signInAdminEmailPassword(email, password) {
    if (!isAdminConfigured()) throw new Error('Firebase Admin belum dikonfigurasi.');
    const ok = await ensureSdk();
    if (!ok) throw new Error('Firebase SDK tidak tersedia.');
    const expected = adminEmail();
    const inputEmail = String(email || '').trim().toLowerCase();
    if (!inputEmail || inputEmail !== expected) throw new Error('Email Admin tidak diizinkan.');
    if (!String(password || '')) throw new Error('Kata sandi Admin wajib diisi.');
    const auth = firebase.auth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
    const result = await auth.signInWithEmailAndPassword(inputEmail, String(password));
    const signedEmail = String(result?.user?.email || '').toLowerCase();
    if (signedEmail !== expected) {
      await auth.signOut();
      throw new Error('Akun ini tidak memiliki akses Admin.');
    }
    return result.user;
  }

  async function signInAdminGoogle() {
    if (!isAdminConfigured()) throw new Error('Firebase Admin belum dikonfigurasi.');
    const ok = await ensureSdk();
    if (!ok) throw new Error('Firebase SDK tidak tersedia.');
    const auth = firebase.auth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await auth.signInWithPopup(provider);
    const email = String(result?.user?.email || '').toLowerCase();
    if (email !== adminEmail()) {
      await auth.signOut();
      throw new Error('Akun Google ini tidak memiliki akses Admin.');
    }
    return result.user;
  }

  async function requireAdmin() {
    if (!isAdminConfigured()) return null;
    const ok = await ensureSdk();
    if (!ok) return null;
    const auth = firebase.auth();
    await new Promise(resolve => {
      const stop = auth.onAuthStateChanged(() => { stop(); resolve(); });
    });
    const user = auth.currentUser;
    return user && String(user.email || '').toLowerCase() === adminEmail() ? user : null;
  }

  async function signOutAdmin() {
    if (!(await ensureSdk())) return;
    try { await firebase.auth().signOut(); } catch (_) {}
  }

  async function listenAdminSessions(callback) {
    const admin = await requireAdmin();
    if (!admin) return () => {};
    const db = firebase.database();
    let presence = {};
    let access = {};
    let meta = {};
    const emit = () => {
      const ids = new Set([...Object.keys(presence || {}), ...Object.keys(access || {}), ...Object.keys(meta || {})]);
      const list = [...ids].map(uid => {
        const p = presence?.[uid] || {};
        const a = access?.[uid] || {};
        const m = meta?.[uid] || {};
        return {
          firebaseUid: uid,
          id: String(p.sessionId || m.sessionId || uid),
          status: p.status === 'offline' ? 'offline' : 'online',
          flowPage: String(p.flowPage || '-'),
          flowStep: Number(p.flowStep || 0),
          startedAt: toIso(p.startedAt),
          lastAt: toIso(p.lastAt),
          blocked: Boolean(a.blocked),
          adminUnread: Number(m.adminUnread || 0),
          rtManaged: true,
          firebaseManaged: true
        };
      }).sort((a,b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 100);
      callback(list);
    };
    const pr = db.ref('presence');
    const ar = db.ref('access');
    const mr = db.ref('chatMeta');
    const pFn = s => { presence = s.val() || {}; emit(); };
    const aFn = s => { access = s.val() || {}; emit(); };
    const mFn = s => { meta = s.val() || {}; emit(); };
    pr.on('value', pFn); ar.on('value', aFn); mr.on('value', mFn);
    const unsub = () => { pr.off('value', pFn); ar.off('value', aFn); mr.off('value', mFn); };
    adminSessionUnsubs.push(unsub);
    return unsub;
  }

  async function listenAdminMessages(uid, callback) {
    const admin = await requireAdmin();
    if (!admin || !uid) return () => {};
    if (adminChatUnsub) { try { adminChatUnsub(); } catch (_) {} adminChatUnsub = null; }
    const ref = firebase.database().ref(`chats/${uid}`).limitToLast(250);
    const fn = snap => {
      const value = snap.val() || {};
      const list = Object.values(value).filter(Boolean).map(m => ({
        id: m.id, sessionId: m.sessionId, author: m.author, text: m.text, at: toIso(m.createdAt)
      })).sort((a,b) => String(a.at).localeCompare(String(b.at)));
      callback(list);
    };
    ref.on('value', fn);
    adminChatUnsub = () => ref.off('value', fn);
    return adminChatUnsub;
  }

  async function markAdminRead(uid) {
    const admin = await requireAdmin();
    if (!admin || !uid) return false;
    try {
      await firebase.database().ref(`chatMeta/${uid}`).update({ adminUnread: 0, adminReadAt: firebase.database.ServerValue.TIMESTAMP });
      return true;
    } catch (_) { return false; }
  }

  async function sendAdminMessage(uid, session, item) {
    const admin = await requireAdmin();
    if (!admin || !uid || !item?.id) return false;
    const text = redact(item.text);
    if (!text) return false;
    try {
      const db = firebase.database();
      await db.ref(`chats/${uid}/${item.id}`).set({
        id: String(item.id).slice(0, 120),
        sessionId: String(session || '').slice(0, 120),
        author: 'admin',
        text,
        createdAt: firebase.database.ServerValue.TIMESTAMP
      });
      await db.ref(`chatMeta/${uid}`).update({ sessionId: String(session || '').slice(0, 120), lastMessageAt: firebase.database.ServerValue.TIMESTAMP });
      return true;
    } catch (_) { return false; }
  }

  async function navigateUser(uid, targetPage) {
    const admin = await requireAdmin();
    if (!admin || !uid || !REMOTE_PAGES.has(targetPage)) return false;
    const id = crypto?.randomUUID?.() || `nav-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await firebase.database().ref(`commands/${uid}`).set({ id, targetPage, createdAt: firebase.database.ServerValue.TIMESTAMP });
      return true;
    } catch (_) { return false; }
  }

  async function setBlocked(uid, blocked) {
    const admin = await requireAdmin();
    if (!admin || !uid) return false;
    try {
      await firebase.database().ref(`access/${uid}`).set({ blocked: Boolean(blocked), updatedAt: firebase.database.ServerValue.TIMESTAMP });
      return true;
    } catch (_) { return false; }
  }

  function stopClientListeners() {
    clientUnsubs.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
    clientListenersStarted = false;
  }


  function normalizeDormantConfig(value) {
    const input = value && typeof value === 'object' ? value : {};
    const text = (key, max) => String(input[key] || '').trim().slice(0, max);
    const seconds = Math.max(60, Math.min(86400, Math.round(Number(input.countdownSeconds) || 7200)));
    return {
      title: text('title', 100),
      message: text('message', 500),
      noticeTitle: text('noticeTitle', 100),
      noticeBody: text('noticeBody', 500),
      countdownSeconds: seconds,
      updatedAt: Number(input.updatedAt || 0)
    };
  }

  async function listenUserDormantConfig(callback) {
    const user = await ensureUser();
    if (!user || typeof callback !== 'function') return () => {};
    const ref = firebase.database().ref(`dormantConfig/${user.uid}`);
    const fn = snap => callback(snap.exists() ? normalizeDormantConfig(snap.val()) : null);
    ref.on('value', fn);
    return () => ref.off('value', fn);
  }

  async function listenAdminDormantConfig(uid, callback) {
    const admin = await requireAdmin();
    if (!admin || !uid || typeof callback !== 'function') return () => {};
    const ref = firebase.database().ref(`dormantConfig/${uid}`);
    const fn = snap => callback(snap.exists() ? normalizeDormantConfig(snap.val()) : null);
    ref.on('value', fn);
    return () => ref.off('value', fn);
  }

  async function saveAdminDormantConfig(uid, value) {
    const admin = await requireAdmin();
    if (!admin || !uid) return false;
    const cfg = normalizeDormantConfig(value);
    if (!cfg.title || !cfg.message || !cfg.noticeTitle || !cfg.noticeBody) return false;
    try {
      await firebase.database().ref(`dormantConfig/${uid}`).set({
        title: cfg.title,
        message: cfg.message,
        noticeTitle: cfg.noticeTitle,
        noticeBody: cfg.noticeBody,
        countdownSeconds: cfg.countdownSeconds,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
      });
      return true;
    } catch (_) { return false; }
  }

  async function resetAdminDormantConfig(uid) {
    const admin = await requireAdmin();
    if (!admin || !uid) return false;
    try { await firebase.database().ref(`dormantConfig/${uid}`).remove(); return true; }
    catch (_) { return false; }
  }

  window.KBFirebaseRuntime = Object.freeze({
    isConfigured,
    isAdminConfigured,
    adminEmail,
    ensureSdk,
    ensureUser,
    updatePresence,
    startClientListeners,
    stopClientListeners,
    sendUserMessage,
    getUserMessages,
    signInAdminEmailPassword,
    signInAdminGoogle,
    requireAdmin,
    signOutAdmin,
    listenAdminSessions,
    listenAdminMessages,
    markAdminRead,
    sendAdminMessage,
    navigateUser,
    setBlocked,
    listenUserDormantConfig,
    listenAdminDormantConfig,
    saveAdminDormantConfig,
    resetAdminDormantConfig,
    remotePages: REMOTE_PAGES
  });
})();
