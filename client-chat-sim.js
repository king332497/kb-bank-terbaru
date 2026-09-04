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
  };

  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('kbchat-sim-v1') : null;

  const now = () => new Date().toISOString();
  const safeParse = (value, fallback) => {
    try { return JSON.parse(value); } catch { return fallback; }
  };
  const load = (key, fallback) => safeParse(localStorage.getItem(key), fallback);
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

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

  const updateSession = (patch = {}) => {
    const sessions = load(KEYS.sessions, []);
    const current = sessions.find(item => item.id === sessionId);
    const base = current || {
      id: sessionId,
      startedAt: now(),
      lastAt: now(),
      adminUnread: 0,
      clientUnread: 0,
      status: 'online'
    };
    Object.assign(base, patch, { lastAt: patch.lastAt || now() });
    const next = [base, ...sessions.filter(item => item.id !== sessionId)]
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
      .slice(0, 50);
    save(KEYS.sessions, next);
    channel?.postMessage({ type: 'sessions-updated', sessionId });
    return base;
  };

  const getSession = () => load(KEYS.sessions, []).find(item => item.id === sessionId) || null;
  const getMessages = () => load(messageKey, []);

  const appendStoredMessage = (author, text) => {
    const clean = String(text || '').trim().slice(0, 500);
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
    if (messages.querySelector(`[data-message-id="${CSS.escape(item.id)}"]`)) return;
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

  input?.addEventListener('input', () => {
    if (send) send.disabled = !input.value.trim();
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const item = appendStoredMessage('user', input?.value);
    if (!item) return;
    renderMessage(item);
    input.value = '';
    if (send) send.disabled = true;
    input.focus();
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

  window.addEventListener('pagehide', () => {
    updateSession({ status: 'offline' });
    channel?.close();
  });

  if (status) status.textContent = 'Simulasi lokal • aktif';
  updateSession({ status: 'online' });
  renderStoredMessages();
  updateUnread();
})();
