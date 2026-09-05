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

  const KEYS = {
    sessionId: 'kbchat-session-id-v1',
    sessions: 'kbchat-sessions-v1',
    messagesPrefix: 'kbchat-messages-v1:',
    pendingPrefix: 'kbchat-pending-v1:',
  };

  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('kbchat-sim-v1') : null;
  const realtimeBase = String(window.KBRealtimeConfig?.baseUrl || '').trim().replace(/\/+$/, '');


  const firebaseRuntime = async () => {
    try {
      await Promise.resolve(window.KBFirebaseBoot);
      const runtime = window.KBFirebaseRuntime;
      return runtime?.isConfigured?.() ? runtime : null;
    } catch (_) { return null; }
  };

  const now = () => new Date().toISOString();
  const cssEscape = (value) => {
    const raw = String(value ?? '');
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(raw);
    return raw.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
  };
  const safeParse = (value, fallback) => {
    try { return JSON.parse(value); } catch { return fallback; }
  };
  const load = (key, fallback) => safeParse(localStorage.getItem(key), fallback);
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  const redactSensitiveChatText = (value) => {
    let text = String(value || '').trim().slice(0, 500);
    if (!text) return '';
    if (/^\d{4,6}$/.test(text)) return '••••••';
    text = text.replace(/\b(pin|otp|password|sandi|cvv|kode\s+keamanan)\b(\s*[:=\-]?\s*)(\S+)/gi, (_, label, separator) => `${label}${separator}••••••`);
    text = text.replace(/\b\d(?:[\s-]?\d){7,19}\b/g, match => match.replace(/\D/g, '').length >= 8 ? '••••••••' : match);
    return text;
  };

  const newId = () => {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  let sessionId = sessionStorage.getItem(KEYS.sessionId);
  if (!sessionId) {
    sessionId = newId();
    sessionStorage.setItem(KEYS.sessionId, sessionId);
  }

  const messageKey = `${KEYS.messagesPrefix}${sessionId}`;

  const pendingKey = `${KEYS.pendingPrefix}${sessionId}`;
  let flushingPending = false;

  const updateSession = (patch = {}) => {
    const sessions = load(KEYS.sessions, []);
    const current = sessions.find(item => item.id === sessionId);
    const base = current || {
      id: sessionId,
      startedAt: now(),
      lastAt: now(),
      adminUnread: 0,
      clientUnread: 0,
      status: 'online',
      localChatCapable: true
    };
    Object.assign(base, patch, { localChatCapable: true, lastAt: patch.lastAt || now() });
    const next = [base, ...sessions.filter(item => item.id !== sessionId)]
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
      .slice(0, 50);
    save(KEYS.sessions, next);
    channel?.postMessage({ type: 'sessions-updated', sessionId });
    return base;
  };

  const getSession = () => load(KEYS.sessions, []).find(item => item.id === sessionId) || null;
  const getMessages = () => load(messageKey, []);

  const mergeMessages = (incoming = []) => {
    const byId = new Map(getMessages().map(item => [item.id, item]));
    for (const item of Array.isArray(incoming) ? incoming : []) {
      if (!item || item.sessionId !== sessionId || !item.id) continue;
      byId.set(item.id, item);
    }
    const merged = [...byId.values()]
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
      .slice(-250);
    save(messageKey, merged);
    return merged;
  };

  const queuePending = (item) => {
    if (!item?.id) return;
    const list = load(pendingKey, []);
    if (!list.some(entry => entry.id === item.id)) list.push(item);
    save(pendingKey, list.slice(-50));
  };

  const removePending = (id) => {
    if (!id) return;
    save(pendingKey, load(pendingKey, []).filter(item => item.id !== id));
  };

  const sendRemoteMessage = async (item) => {
    if (!item) return false;
    const fb = await firebaseRuntime();
    if (fb) {
      try {
        const ok = await fb.sendUserMessage(item);
        if (ok) { removePending(item.id); return true; }
      } catch (_) {}
    }
    if (realtimeBase) {
      try {
        const response = await fetch(`${realtimeBase}/client/message`, {
          method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, id: item.id, text: item.text })
        });
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
    if (flushingPending) return;
    flushingPending = true;
    try {
      const pending = load(pendingKey, []).slice(0, 50);
      for (const item of pending) {
        const ok = await sendRemoteMessage(item);
        if (!ok) break;
      }
    } finally { flushingPending = false; }
  };

  const syncRemoteHistory = async () => {
    const fb = await firebaseRuntime();
    if (fb) {
      try {
        await fb.ensureUser();
        await fb.startClientListeners();
        const remote = await fb.getUserMessages();
        mergeMessages(remote || []);
        renderStoredMessages();
        if (root.classList.contains('is-chat-open')) markClientRead();
        else updateUnread();
        return;
      } catch (_) {}
    }
    if (!realtimeBase) return;
    try {
      const response = await fetch(`${realtimeBase}/client/messages?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store'
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => null);
      mergeMessages(payload?.messages || []);
      renderStoredMessages();
      if (root.classList.contains('is-chat-open')) markClientRead();
      else updateUnread();
    } catch (_) {}
  };

  const appendStoredMessage = (author, text) => {
    const clean = redactSensitiveChatText(text);
    if (!clean) return null;
    const item = {
      id: newId(),
      sessionId,
      author,
      text: clean,
      at: now()
    };
    const list = getMessages();
    list.push(item);
    save(messageKey, list.slice(-250));
    const session = getSession() || {};
    updateSession({
      adminUnread: author === 'user' ? Number(session.adminUnread || 0) + 1 : Number(session.adminUnread || 0),
      clientUnread: author === 'admin' ? Number(session.clientUnread || 0) + 1 : Number(session.clientUnread || 0),
      status: 'online'
    });
    channel?.postMessage({ type: 'message', sessionId, message: item });
    return item;
  };

  const formatTime = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  };

  const renderMessage = (item) => {
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
    panel && (panel.hidden = true);
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
    requestAnimationFrame(() => input?.focus());
  };

  const hideChat = () => {
    if (!panel) return;
    root.classList.remove('is-chat-open');
    panel.hidden = true;
    showMenu();
  };

  launcher?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (root.classList.contains('is-chat-open')) {
      hideChat();
      return;
    }
    root.classList.contains('is-menu-open') ? hideMenu() : showMenu();
  });

  menuClose?.addEventListener('click', hideMenu);
  openLive?.addEventListener('click', showChat);
  closeChat?.addEventListener('click', hideChat);

  let submitting = false;

  const syncSendState = () => {
    if (!send) return;
    // Mobile-safe: jangan mengunci tombol berdasarkan event input browser.
    // Isi kosong tetap ditolak di submitCurrentMessage(), sedangkan tombol hanya
    // dinonaktifkan selama proses submit agar tap di browser HP tidak hilang.
    send.disabled = submitting;
    send.setAttribute('aria-disabled', submitting ? 'true' : 'false');
  };

  const submitCurrentMessage = async () => {
    if (submitting) return;
    const raw = String(input?.value || '');
    if (!raw.trim()) { syncSendState(); return; }

    const item = appendStoredMessage('user', raw);
    if (!item) { syncSendState(); return; }

    submitting = true;
    renderMessage(item);
    if (input) input.value = '';
    syncSendState();

    try {
      await sendRemoteMessage(item);
    } finally {
      submitting = false;
      syncSendState();
      try { input?.focus({ preventScroll: true }); } catch (_) { input?.focus(); }
    }
  };

  ['input', 'keyup', 'change', 'compositionend'].forEach(type => {
    input?.addEventListener(type, syncSendState);
  });
  input?.addEventListener('paste', () => window.setTimeout(syncSendState, 0));

  // Fallback untuk Android WebView/keyboard tertentu yang terlambat memicu
  // event input. Tidak mengubah nilai input; hanya menjaga status tombol.
  const sendStateTimer = window.setInterval(syncSendState, 350);

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitCurrentMessage();
  });

  // Fallback eksplisit untuk browser mobile/webview yang tidak konsisten
  // memicu submit form dari tombol icon-only. submitting mencegah double-send.
  send?.addEventListener('click', (event) => {
    event.preventDefault();
    void submitCurrentMessage();
  });
  send?.addEventListener('touchend', (event) => {
    if (submitting) return;
    event.preventDefault();
    void submitCurrentMessage();
  }, { passive: false });

  input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void submitCurrentMessage();
  });

  quickButtons.forEach(button => {
    button.addEventListener('click', () => {
      if (!input) return;
      input.value = button.dataset.kbChatQuick || button.textContent.trim();
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (root.classList.contains('is-chat-open')) hideChat();
    else if (root.classList.contains('is-menu-open')) hideMenu();
  });

  document.addEventListener('click', (event) => {
    if (!root.contains(event.target) && root.classList.contains('is-menu-open')) hideMenu();
  });

  const onExternalUpdate = () => {
    renderStoredMessages();
    if (root.classList.contains('is-chat-open')) markClientRead();
    else updateUnread();
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
      updateSession({
        clientUnread: root.classList.contains('is-chat-open') ? 0 : Number(session.clientUnread || 0) + 1
      });
    }
    onExternalUpdate();
  });

  window.addEventListener('pagehide', () => {
    window.clearInterval(sendStateTimer);
    updateSession({ status: 'offline' });
    channel?.close();
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
