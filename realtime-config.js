(() => {
  'use strict';

  // Set satu kali saat backend sudah dideploy, contoh:
  // const DEPLOYED_BACKEND_URL = 'https://realtime.example.com';
  const DEPLOYED_BACKEND_URL = '';
  const STORAGE_KEY = 'kbRealtimeBackendUrl';

  function normalize(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return url.origin + url.pathname.replace(/\/+$/, '');
    } catch (_) {
      return '';
    }
  }

  let override = '';
  try { override = window.localStorage.getItem(STORAGE_KEY) || ''; } catch (_) {}

  let baseUrl = normalize(override || DEPLOYED_BACKEND_URL);
  if (!baseUrl && ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    baseUrl = `http://${window.location.hostname}:8787`;
  }

  window.KBRealtimeConfig = Object.freeze({
    baseUrl,
    storageKey: STORAGE_KEY
  });
})();

(() => {
  'use strict';
  function load(src) {
    return new Promise(resolve => {
      if ([...document.scripts].some(s => s.getAttribute('src') === src || s.src.endsWith('/' + src))) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = resolve;
      document.head.appendChild(script);
    });
  }
  window.KBFirebaseBoot = (async () => {
    await load('firebase-config.js');
    await load('firebase-runtime.js');
    return window.KBFirebaseRuntime || null;
  })();
})();
