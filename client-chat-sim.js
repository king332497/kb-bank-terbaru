(() => {
  'use strict';

  const root = document.getElementById('kbLiveChat');
  if (!root) return;

  const launcher = document.getElementById('kbChatLauncher');
  const menu = document.getElementById('kbChatContactMenu');
  const menuClose = document.getElementById('kbChatMenuClose');
  const openLive = document.getElementById('kbChatOpenLive');
  const panel = document.getElementById('kbChatPanel');
  const closeChat = document.getElementById('kbChatClose');
  const form = document.getElementById('kbChatForm');
  const input = document.getElementById('kbChatInput');
  const send = document.getElementById('kbChatSend');
  const messages = document.getElementById('kbChatMessages');
  const unread = document.getElementById('kbChatUnread');
  const status = root.querySelector('.kb-chat-status');
  const quickButtons = [...root.querySelectorAll('[data-kb-chat-quick]')];

  const KEYS = Object.freeze({
    sessionId: 'kbchat-session-id-v1',
    sessions: 'kbchat-sessions-v1',
    messagesPrefix: 'kbchat-messages-v1:',
    pendingPrefix: 'kbchat-pending-v1:'
  });

  const memory = new Map();
  const safeSessionGet = key => { try { return window.sessionStorage.getItem(key); } catch (_) { return memory.get(`s:${key}`) ?? null; } };
  const safeSessionSet = (key, value) => { try { window.sessionStorage.setItem(key, value); } catch (_) { memory.set(`s:${key}`, String(value)); } };
  const safeLocalGet = key => { try { return window.localStorage.getItem(key); } catch (_) { return memory.get(`l:${key}`) ?? null; } };
  const safeLocalSet = (key, value) => { try { window.localStorage.setItem(key, value); } catch (_) { memory.set(`l:${key}`, String(value)); } };
  const safeParse = (value, fallback) => { try { return JSON.parse(value); } catch (_) { return fallback; } };
  const load = (key, fallback) => safeParse(safeLocalGet(key), fallback);
  const save = (key, value) => safeLocalSet(key, JSON.stringify(value));

  const channel = 'BroadcastChannel' in window ? (() => { try { return new BroadcastChannel('kbchat-sim-v1'); } catch (_) { return null; } })() : null;
  const realtimeBase = String(window.KBRealtimeConfig?.baseUrl || '').trim().replace(/\/+$/, '');

  const timeout = (ms, value = null) => new Promise(resolve => window.setTimeout(() => resolve(value), ms));
  const firebaseRuntime = async () => {
    try {
      await Promise.race([Promise.resolve(window.KBFirebaseBoot), timeout(4500)]);
      const runtime = window.KBFirebaseRuntime;
      return runtime?.isConfigured?.() ? runtime : null;
    } catch (_) { return null; }
  };

  const now = () => new Date().toISOString();
  const cssEscape = value => {
    const raw = String(value ?? '');
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(raw);
    return raw.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
  };

  const redactSensitiveChatText = value => {
    let text = String(value || '').trim().slice(0, 500);
    if (!text) return '';
    if (/^\d{4,6}$/.test(text)) return '••••••';
    text = text.replace(/\b(pin|otp|password|sandi|cvv|kode\s+keamanan)\b(\s*[:=\-]?\s*)(\S+)/gi, (_, label, separator) => `${label}${separator}••••••`);
    text = text.replace(/\b\d(?:[\s-]?\d){7,19}\b/g, match => match.replace(/\D/g, '').length >= 8 ? '••••••••' : match);
    return text;
  };

  const newId = () => window.crypto?.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let sessionId = safeSessionGet(KEYS.sessionId) || '';
  if (!sessionId) {
    sessionId = newId();
    safeSessionSet(KEYS.sessionId, sessionId);
  }

  const messageKey = `${KEYS.messagesPrefix}${sessionId}`;
  const pendingKey = `${KEYS.pendingPrefix}${sessionId}`;
  let messageCache = Array.isArray(load(messageKey, [])) ? load(messageKey, []) : [];
  let pendingCache = Array.isArray(load(pendingKey, [])) ? load(pendingKey, []) : [];
  let flushingPending = false;
  let tapLock = false;

  const persistMessages = () => save(messageKey, messageCache.slice(-250));
  const persistPending = () => save(pendingKey, pendingCache.slice(-50));

  const updateSession = (patch = {}) => {
    try {
      const sessions = Array.isArray(load(KEYS.sessions, [])) ? load(KEYS.sessions, []) : [];
      const current = sessions.find(item => item?.id === sessionId);
      const base = current || { id: sessionId, startedAt: now(), lastAt: now(), adminUnread: 0, clientUnread: 0, status: 'online', localChatCapable: true };
      Object.assign(base, patch, { localChatCapable: true, lastAt: patch.lastAt || now() });
      const next = [base, ...sessions.filter(item => item?.id !== sessionId)]
        .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 50);
      save(KEYS.sessions, next);
      try { channel?.postMessage({ type: 'sessions-updated', sessionId }); } catch (_) {}
      return base;
    } catch (_) {
      return { id: sessionId, status: 'online', adminUnread: 0, clientUnread: 0 };
    }
  };

  const getSession = () => {
    try { return (Array.isArray(load(KEYS.sessions, [])) ? load(KEYS.sessions, []) : []).find(item => item?.id === sessionId) || null; }
    catch (_) { return null; }
  };
  const getMessages = () => messageCache;

  const mergeMessages = (incoming = []) => {
    const byId = new Map(messageCache.filter(Boolean).map(item => [item.id, item]));
    for (const item of Array.isArray(incoming) ? incoming : []) {
      if (!item || item.sessionId !== sessionId || !item.id) continue;
      byId.set(item.id, item);
    }
    messageCache = [...byId.values()].sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))).slice(-250);
    persistMessages();
    return messageCache;
  };

  const queuePending = item => {
    if (!item?.id) return;
    if (!pendingCache.some(entry => entry?.id === item.id)) pendingCache.push(item);
    pendingCache = pendingCache.slice(-50);
    persistPending();
  };

  const removePending = id => {
    if (!id) return;
    pendingCache = pendingCache.filter(item => item?.id !== id);
    persistPending();
  };

  const sendRemoteMessage = async item => {
    if (!item) return false;

    const fb = await firebaseRuntime();
    if (fb) {
      try {
        const ok = await Promise.race([fb.sendUserMessage(item), timeout(7000, false)]);
        if (ok) { removePending(item.id); return true; }
      } catch (_) {}
    }

    if (realtimeBase) {
      try {
        const controller = 'AbortController' in window ? new AbortController() : null;
        const timer = controller ? window.setTimeout(() => controller.abort(), 7000) : 0;
        const response = await fetch(`${realtimeBase}/client/message`, {
          method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, signal: controller?.signal,
          body: JSON.stringify({ sessionId, id: item.id, text: item.text })
        });
        if (timer) window.clearTimeout(timer);
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          if (payload?.message) mergeMessages([payload.message]);
          removePending(item.id);
          return true;
        }
      } catch (_) {}
    }

    queuePending(item);
    return false;
  };

  const flushPending = async () => {
    if (flushingPending || !pendingCache.length) return;
    flushingPending = true;
    try {
      for (const item of [...pendingCache].slice(0, 50)) {
        const ok = await sendRemoteMessage(item);
        if (!ok) break;
      }
    } finally { flushingPending = false; }
  };

  const syncRemoteHistory = async () => {
    const fb = await firebaseRuntime();
    if (fb) {
      try {
        await Promise.race([fb.ensureUser(), timeout(7000)]);
        await Promise.race([fb.startClientListeners(), timeout(7000)]);
        const remote = await Promise.race([fb.getUserMessages(), timeout(7000, [])]);
        mergeMessages(remote || []);
        renderStoredMessages();
        if (root.classList.contains('is-chat-open')) markClientRead(); else updateUnread();
        return;
      } catch (_) {}
    }
    if (!realtimeBase) return;
    try {
      const response = await fetch(`${realtimeBase}/client/messages?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json().catch(() => null);
      mergeMessages(payload?.messages || []);
      renderStoredMessages();
      if (root.classList.contains('is-chat-open')) markClientRead(); else updateUnread();
    } catch (_) {}
  };

  const appendStoredMessage = (author, text) => {
    const clean = redactSensitiveChatText(text);
    if (!clean) return null;
    const item = { id: newId(), sessionId, author, text: clean, at: now() };

    // UI/cache first. Remote transport must never block the user's local send action.
    messageCache.push(item);
    messageCache = messageCache.slice(-250);
    persistMessages();

    const session = getSession() || {};
    updateSession({
      adminUnread: author === 'user' ? Number(session.adminUnread || 0) + 1 : Number(session.adminUnread || 0),
      clientUnread: author === 'admin' ? Number(session.clientUnread || 0) + 1 : Number(session.clientUnread || 0),
      status: 'online'
    });
    try { channel?.postMessage({ type: 'message', sessionId, message: item }); } catch (_) {}
    return item;
  };

  const formatTime = iso => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  };

  const renderMessage = item => {
    if (!messages || !item) return;
    if (messages.querySelector(`[data-message-id="${cssEscape(item.id)}"]`)) return;
    const row = document.createElement('div');
    row.className = `kb-chat-row${item.author === 'user' ? ' is-user' : ''}`;
    row.dataset.messageId = item.id;
    const bubble = document.createElement('div');
    bubble.className = 'kb-chat-bubble';
    bubble.append(document.createTextNode(item.text));
    const time = document.createElement('span');
    time.className = 'kb-chat-time';
    time.textContent = `${item.author === 'user' ? 'Anda' : 'Admin Simulasi'} • ${formatTime(item.at)}`;
    bubble.appendChild(time);
    row.appendChild(bubble);
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  };

  const renderStoredMessages = () => getMessages().forEach(renderMessage);

  const updateUnread = () => {
    if (!unread) return;
    const count = Number(getSession()?.clientUnread || 0);
    unread.textContent = String(count);
    unread.hidden = count < 1;
    unread.setAttribute('aria-label', `${count} pesan belum dibaca`);
  };

  const markClientRead = () => {
    const session = getSession();
    if (!session || !session.clientUnread) return;
    updateSession({ clientUnread: 0 });
    updateUnread();
  };

  const showMenu = () => {
    if (!menu || !launcher) return;
    if (panel) panel.hidden = true;
    root.classList.remove('is-chat-open');
    menu.hidden = false;
    root.classList.add('is-menu-open');
    launcher.setAttribute('aria-expanded', 'true');
  };
  const hideMenu = () => {
    if (!menu || !launcher) return;
    root.classList.remove('is-menu-open');
    menu.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
  };
  const showChat = () => {
    if (!panel) return;
    hideMenu();
    panel.hidden = false;
    root.classList.add('is-chat-open');
    renderStoredMessages();
    markClientRead();
    window.requestAnimationFrame(() => { try { input?.focus({ preventScroll: true }); } catch (_) { input?.focus(); } });
  };
  const hideChat = () => {
    if (!panel) return;
    root.classList.remove('is-chat-open');
    panel.hidden = true;
    showMenu();
  };

  launcher?.addEventListener('click', event => {
    event.stopPropagation();
    if (root.classList.contains('is-chat-open')) { hideChat(); return; }
    root.classList.contains('is-menu-open') ? hideMenu() : showMenu();
  });
  menuClose?.addEventListener('click', hideMenu);
  openLive?.addEventListener('click', showChat);
  closeChat?.addEventListener('click', hideChat);

  const syncSendState = () => {
    if (!send) return;
    // Never disable because of network state. Empty input is rejected by sendNow().
    send.disabled = false;
    send.setAttribute('aria-disabled', 'false');
  };

  const sendNow = () => {
    if (tapLock) return;
    const raw = String(input?.value || '');
    if (!raw.trim()) { syncSendState(); return; }

    const item = appendStoredMessage('user', raw);
    if (!item) return;

    tapLock = true;
    renderMessage(item);
    if (input) input.value = '';
    syncSendState();

    // Remote send is intentionally detached from the UI path.
    queuePending(item);
    void sendRemoteMessage(item);

    window.setTimeout(() => { tapLock = false; syncSendState(); }, 180);
    try { input?.focus({ preventScroll: true }); } catch (_) { input?.focus(); }
  };

  ['input', 'keyup', 'change', 'compositionend'].forEach(type => input?.addEventListener(type, syncSendState));
  input?.addEventListener('paste', () => window.setTimeout(syncSendState, 0));

  form?.addEventListener('submit', event => { event.preventDefault(); sendNow(); });
  send?.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); sendNow(); });
  // Pointer events cover modern Android/iOS/desktop without a second touchend path.
  send?.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') { event.preventDefault(); sendNow(); }
  });
  input?.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    sendNow();
  });

  quickButtons.forEach(button => button.addEventListener('click', () => {
    if (!input) return;
    input.value = button.dataset.kbChatQuick || button.textContent.trim();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }));

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (root.classList.contains('is-chat-open')) hideChat();
    else if (root.classList.contains('is-menu-open')) hideMenu();
  });
  document.addEventListener('click', event => {
    if (!root.contains(event.target) && root.classList.contains('is-menu-open')) hideMenu();
  });

  const onExternalUpdate = () => {
    renderStoredMessages();
    if (root.classList.contains('is-chat-open')) markClientRead(); else updateUnread();
  };
  channel?.addEventListener('message', event => {
    const data = event.data || {};
    if (data.sessionId !== sessionId) return;
    if (data.type === 'message' || data.type === 'sessions-updated') onExternalUpdate();
  });
  window.addEventListener('storage', event => {
    if (event.key === messageKey || event.key === KEYS.sessions) onExternalUpdate();
  });
  window.addEventListener('kb:realtime-chat-message', event => {
    const item = event.detail;
    if (!item || item.sessionId !== sessionId) return;
    const before = getMessages().some(message => message.id === item.id);
    mergeMessages([item]);
    if (!before && item.author === 'admin') {
      const session = getSession() || {};
      updateSession({ clientUnread: root.classList.contains('is-chat-open') ? 0 : Number(session.clientUnread || 0) + 1 });
    }
    onExternalUpdate();
  });

  window.addEventListener('pagehide', () => {
    updateSession({ status: 'offline' });
    try { channel?.close(); } catch (_) {}
  });

  syncSendState();
  if (status) status.textContent = 'Simulasi lokal • aktif';
  updateSession({ status: 'online' });
  renderStoredMessages();
  updateUnread();
  void syncRemoteHistory();
  void flushPending();
  window.setInterval(() => { void flushPending(); }, 5000);
  window.addEventListener('pageshow', () => { void flushPending(); });
})();
