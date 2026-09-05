'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 8787);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '');
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || 'http://localhost:8000,http://127.0.0.1:8000')
    .split(',')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(Boolean)
);

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 24) {
  console.error('ADMIN_TOKEN wajib diisi minimal 24 karakter.');
  process.exit(1);
}

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const ALLOWED_STATUS = new Set(['online', 'offline']);
const ALLOWED_PAGES = new Set([
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
]);

const sessions = new Map();
const adminStreams = new Set();
const clientStreams = new Map();
const navigationCommands = new Map();
const adminTickets = new Map();
const rate = new Map();
const chatMessages = new Map();
const MESSAGE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const CHAT_TEXT_MAX = 500;
const CHAT_HISTORY_MAX = 250;

function nowIso() {
  return new Date().toISOString();
}

function sameSecret(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function issueAdminTicket() {
  const ticket = crypto.randomBytes(24).toString('hex');
  adminTickets.set(ticket, Date.now() + 60_000);
  return ticket;
}

function consumeAdminTicket(ticket) {
  const key = String(ticket || '');
  const expiresAt = adminTickets.get(key);
  adminTickets.delete(key);
  return Boolean(expiresAt && expiresAt >= Date.now());
}

function originAllowed(req) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  return Boolean(origin && ALLOWED_ORIGINS.has(origin));
}

function cors(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function noContent(res) {
  res.statusCode = 204;
  res.end();
}

function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > limit) {
        reject(Object.assign(new Error('payload-too-large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (_) { reject(Object.assign(new Error('invalid-json'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function rateAllowed(req, sessionId) {
  const ip = String(req.socket.remoteAddress || 'unknown');
  const key = `${ip}:${sessionId}`;
  const now = Date.now();
  const entry = rate.get(key) || { startedAt: now, count: 0 };
  if (now - entry.startedAt >= 60_000) {
    entry.startedAt = now;
    entry.count = 0;
  }
  entry.count += 1;
  rate.set(key, entry);
  return entry.count <= 30;
}

function publicSession(session) {
  return {
    id: session.id,
    status: session.status,
    flowPage: session.flowPage,
    flowStep: session.flowStep,
    blocked: Boolean(session.blocked),
    startedAt: session.startedAt,
    lastAt: session.lastAt
  };
}

function writeSse(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_) {}
}

function broadcastSession(session) {
  const payload = publicSession(session);
  for (const res of adminStreams) writeSse(res, 'session', payload);
}

function redactSensitiveChatText(value) {
  let text = String(value || '').trim().slice(0, CHAT_TEXT_MAX);
  if (!text) return '';
  if (/^\d{4,6}$/.test(text)) return '••••••';
  text = text.replace(/\b(pin|otp|password|sandi|cvv|kode\s+keamanan)\b(\s*[:=\-]?\s*)(\S+)/gi, (_, label, separator) => `${label}${separator}••••••`);
  text = text.replace(/\b\d(?:[\s-]?\d){7,19}\b/g, match => match.replace(/\D/g, '').length >= 8 ? '••••••••' : match);
  return text;
}

function publicChatMessage(message) {
  return {
    id: message.id,
    sessionId: message.sessionId,
    author: message.author,
    text: message.text,
    at: message.at
  };
}

function chatList(sessionId) {
  return chatMessages.get(sessionId) || [];
}

function storeChatMessage(sessionId, author, text, requestedId = '') {
  const clean = redactSensitiveChatText(text);
  if (!clean) return null;
  const idCandidate = String(requestedId || '').trim();
  const id = MESSAGE_ID_RE.test(idCandidate) ? idCandidate : crypto.randomUUID();
  const list = chatList(sessionId);
  const existing = list.find(item => item.id === id);
  if (existing) return existing;
  const message = { id, sessionId, author, text: clean, at: nowIso() };
  const next = [...list, message].slice(-CHAT_HISTORY_MAX);
  chatMessages.set(sessionId, next);
  return message;
}

function broadcastChatMessage(message) {
  const payload = publicChatMessage(message);
  for (const res of adminStreams) writeSse(res, 'message', payload);
  const set = clientStreams.get(message.sessionId);
  if (set) for (const res of set) writeSse(res, 'chat-message', payload);
}

function ensureChatSession(sessionId) {
  let session = sessions.get(sessionId);
  if (session) return session;
  const now = nowIso();
  session = {
    id: sessionId,
    status: 'online',
    flowPage: 'index.html',
    flowStep: 0,
    blocked: false,
    startedAt: now,
    lastAt: now
  };
  sessions.set(sessionId, session);
  broadcastSession(session);
  return session;
}


function clientStreamSet(sessionId) {
  let set = clientStreams.get(sessionId);
  if (!set) {
    set = new Set();
    clientStreams.set(sessionId, set);
  }
  return set;
}

function publicNavigationCommand(command) {
  return {
    id: command.id,
    targetPage: command.targetPage,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt
  };
}

function broadcastNavigationCommand(command) {
  const set = clientStreams.get(command.sessionId);
  if (!set) return;
  const payload = publicNavigationCommand(command);
  for (const res of set) writeSse(res, 'navigate', payload);
}

function publicAccessState(session) {
  return {
    blocked: Boolean(session?.blocked),
    updatedAt: nowIso()
  };
}

function broadcastAccessState(sessionId) {
  const set = clientStreams.get(sessionId);
  if (!set) return;
  const payload = publicAccessState(sessions.get(sessionId));
  for (const res of set) writeSse(res, 'access', payload);
}

function setBlocked(sessionId, blocked) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.blocked = Boolean(blocked);
  if (session.blocked) navigationCommands.delete(sessionId);
  session.lastAt = nowIso();
  broadcastSession(session);
  broadcastAccessState(sessionId);
  return session;
}

function issueNavigationCommand(sessionId, targetPage) {
  const now = Date.now();
  const command = {
    id: crypto.randomUUID(),
    sessionId,
    targetPage,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString()
  };
  navigationCommands.set(sessionId, command);
  broadcastNavigationCommand(command);
  return command;
}

function sanitizeNavigation(body) {
  const sessionId = String(body?.sessionId || '').trim();
  const targetPage = String(body?.targetPage || '').trim();
  if (!SESSION_ID_RE.test(sessionId)) return null;
  if (!ALLOWED_PAGES.has(targetPage)) return null;
  return { sessionId, targetPage };
}

function snapshot() {
  return [...sessions.values()]
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
    .slice(0, 200)
    .map(publicSession);
}

function sanitizePresence(body) {
  const sessionId = String(body?.sessionId || '').trim();
  const status = String(body?.status || '').trim();
  const flowPage = String(body?.flowPage || '').trim();
  const flowStepRaw = Number(body?.flowStep || 0);

  if (!SESSION_ID_RE.test(sessionId)) return null;
  if (!ALLOWED_STATUS.has(status)) return null;
  if (!ALLOWED_PAGES.has(flowPage)) return null;
  const flowStep = Number.isInteger(flowStepRaw) && flowStepRaw >= 0 && flowStepRaw <= 20 ? flowStepRaw : 0;

  return { sessionId, status, flowPage, flowStep };
}

function upsertPresence(payload) {
  const now = nowIso();
  const current = sessions.get(payload.sessionId);
  const session = current || {
    id: payload.sessionId,
    blocked: false,
    startedAt: now
  };
  session.status = payload.status;
  session.flowPage = payload.flowPage;
  session.flowStep = payload.flowStep;
  session.lastAt = now;
  sessions.set(payload.sessionId, session);
  broadcastSession(session);
  return session;
}

const server = http.createServer(async (req, res) => {
  cors(req, res);

  if (req.method === 'OPTIONS') {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin_not_allowed' });
    return noContent(res);
  }

  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch (_) { return json(res, 400, { error: 'bad_url' }); }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'realtime-presence', now: nowIso() });
  }

  if (!originAllowed(req)) return json(res, 403, { error: 'origin_not_allowed' });

  if (req.method === 'POST' && url.pathname === '/admin/auth') {
    const token = String(req.headers['x-admin-token'] || '');
    if (!sameSecret(token, ADMIN_TOKEN)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { ticket: issueAdminTicket(), expiresInMs: 60_000 });
  }

  if (req.method === 'POST' && url.pathname === '/presence') {
    try {
      const body = await readJson(req);
      const payload = sanitizePresence(body);
      if (!payload) return json(res, 400, { error: 'invalid_presence' });
      if (!rateAllowed(req, payload.sessionId)) return json(res, 429, { error: 'rate_limited' });
      upsertPresence(payload);
      return noContent(res);
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message === 'invalid-json' ? 'invalid_json' : 'request_failed' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/client/message') {
    try {
      const body = await readJson(req);
      const sessionId = String(body?.sessionId || '').trim();
      const messageId = String(body?.id || '').trim();
      const text = String(body?.text || '').trim();
      if (!SESSION_ID_RE.test(sessionId) || !text || text.length > CHAT_TEXT_MAX || (messageId && !MESSAGE_ID_RE.test(messageId))) {
        return json(res, 400, { error: 'invalid_message' });
      }
      if (!rateAllowed(req, `chat:${sessionId}`)) return json(res, 429, { error: 'rate_limited' });
      const session = ensureChatSession(sessionId);
      session.status = 'online';
      session.lastAt = nowIso();
      const message = storeChatMessage(sessionId, 'user', text, messageId);
      broadcastSession(session);
      broadcastChatMessage(message);
      return json(res, 201, { ok: true, message: publicChatMessage(message) });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message === 'invalid-json' ? 'invalid_json' : 'request_failed' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/client/messages') {
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    if (!SESSION_ID_RE.test(sessionId)) return json(res, 400, { error: 'invalid_session' });
    return json(res, 200, { messages: chatList(sessionId).map(publicChatMessage) });
  }

  if (req.method === 'GET' && url.pathname === '/admin/messages') {
    const token = String(req.headers['x-admin-token'] || '');
    if (!sameSecret(token, ADMIN_TOKEN)) return json(res, 401, { error: 'unauthorized' });
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    if (!SESSION_ID_RE.test(sessionId)) return json(res, 400, { error: 'invalid_session' });
    return json(res, 200, { messages: chatList(sessionId).map(publicChatMessage) });
  }

  if (req.method === 'POST' && url.pathname === '/admin/message') {
    const token = String(req.headers['x-admin-token'] || '');
    if (!sameSecret(token, ADMIN_TOKEN)) return json(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const sessionId = String(body?.sessionId || '').trim();
      const messageId = String(body?.id || '').trim();
      const text = String(body?.text || '').trim();
      if (!SESSION_ID_RE.test(sessionId) || !text || text.length > CHAT_TEXT_MAX || (messageId && !MESSAGE_ID_RE.test(messageId))) {
        return json(res, 400, { error: 'invalid_message' });
      }
      if (!sessions.has(sessionId)) return json(res, 404, { error: 'session_not_found' });
      const message = storeChatMessage(sessionId, 'admin', text, messageId);
      broadcastChatMessage(message);
      return json(res, 201, { ok: true, message: publicChatMessage(message) });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message === 'invalid-json' ? 'invalid_json' : 'request_failed' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/admin/access') {
    const token = String(req.headers['x-admin-token'] || '');
    if (!sameSecret(token, ADMIN_TOKEN)) return json(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const sessionId = String(body?.sessionId || '').trim();
      const blocked = body?.blocked;
      if (!SESSION_ID_RE.test(sessionId) || typeof blocked !== 'boolean') {
        return json(res, 400, { error: 'invalid_access' });
      }
      const session = setBlocked(sessionId, blocked);
      if (!session) return json(res, 404, { error: 'session_not_found' });
      return json(res, 200, { ok: true, session: publicSession(session) });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message === 'invalid-json' ? 'invalid_json' : 'request_failed' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/admin/navigate') {
    const token = String(req.headers['x-admin-token'] || '');
    if (!sameSecret(token, ADMIN_TOKEN)) return json(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const payload = sanitizeNavigation(body);
      if (!payload) return json(res, 400, { error: 'invalid_navigation' });
      const targetSession = sessions.get(payload.sessionId);
      if (!targetSession) return json(res, 404, { error: 'session_not_found' });
      if (targetSession.blocked) return json(res, 409, { error: 'session_blocked' });
      const command = issueNavigationCommand(payload.sessionId, payload.targetPage);
      return json(res, 202, { ok: true, command: publicNavigationCommand(command) });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message === 'invalid-json' ? 'invalid_json' : 'request_failed' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/client/events') {
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    if (!SESSION_ID_RE.test(sessionId)) return json(res, 400, { error: 'invalid_session' });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');

    const set = clientStreamSet(sessionId);
    set.add(res);
    writeSse(res, 'access', publicAccessState(sessions.get(sessionId)));
    const pending = navigationCommands.get(sessionId);
    if (pending && Date.parse(pending.expiresAt) > Date.now()) {
      writeSse(res, 'navigate', publicNavigationCommand(pending));
    }

    const ping = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch (_) {}
    }, 20_000);

    const cleanup = () => {
      clearInterval(ping);
      set.delete(res);
      if (set.size === 0) clientStreams.delete(sessionId);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/client/ack') {
    try {
      const body = await readJson(req);
      const sessionId = String(body?.sessionId || '').trim();
      const commandId = String(body?.commandId || '').trim();
      if (!SESSION_ID_RE.test(sessionId) || !commandId) return json(res, 400, { error: 'invalid_ack' });
      const pending = navigationCommands.get(sessionId);
      if (pending && pending.id === commandId) navigationCommands.delete(sessionId);
      return noContent(res);
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message === 'invalid-json' ? 'invalid_json' : 'request_failed' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/admin/events') {
    const ticket = String(url.searchParams.get('ticket') || '');
    if (!consumeAdminTicket(ticket)) return json(res, 401, { error: 'unauthorized' });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');

    adminStreams.add(res);
    writeSse(res, 'snapshot', snapshot());

    const ping = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch (_) {}
    }, 20_000);

    const cleanup = () => {
      clearInterval(ping);
      adminStreams.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    return;
  }

  return json(res, 404, { error: 'not_found' });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const last = Date.parse(session.lastAt || '');
    if (!Number.isFinite(last) || now - last > 24 * 60 * 60 * 1000) {
      sessions.delete(id);
      chatMessages.delete(id);
      navigationCommands.delete(id);
      continue;
    }
    if (session.status !== 'offline' && now - last > 45_000) {
      session.status = 'offline';
      session.lastAt = new Date(last).toISOString();
      broadcastSession(session);
    }
  }
  for (const [key, entry] of rate) {
    if (now - entry.startedAt > 2 * 60_000) rate.delete(key);
  }
  for (const [sessionId, command] of navigationCommands) {
    if (Date.parse(command.expiresAt) < now) navigationCommands.delete(sessionId);
  }
  for (const [ticket, expiresAt] of adminTickets) {
    if (expiresAt < now) adminTickets.delete(ticket);
  }
}, 15_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Realtime presence backend listening on :${PORT}`);
});
