(() => {
  'use strict';

  const PREFIX = 'kbPrototypeFlow.v1.';


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
    eligibilityRules,
    normalizeMoney,
    getMaxEligibleLoan,
    evaluateLoanEligibility,
    saveForm,
    restoreForm,
    prefill,
    go,
    clear
  });
})();
