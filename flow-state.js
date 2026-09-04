(() => {
  'use strict';

  const PREFIX = 'kbPrototypeFlow.v1.';

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

  function go(url, delay = 420) {
    window.setTimeout(() => { window.location.href = url; }, delay);
  }

  function clear() {
    try {
      Object.keys(window.sessionStorage)
        .filter(key => key.startsWith(PREFIX))
        .forEach(key => window.sessionStorage.removeItem(key));
    } catch (_) {}
  }

  window.KBFlow = Object.freeze({
    get,
    write,
    patch,
    saveForm,
    restoreForm,
    prefill,
    go,
    clear
  });
})();
