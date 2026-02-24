// jp-translate.js — janapress Translation Plugin v1.0.0
// OMNI-OPS Framework: Plugin tier — augments without modifying host
// Usage: <script src="jp-translate.js" defer></script>
// Public API: window.jpTranslate.translate('de') | .clearCache() | .langs | .version

(function JanaPressTranslate() {
  'use strict';

  const PLUGIN_ID  = 'jp-translate';
  const VERSION    = '1.0.0';
  const CACHE_KEY  = 'jp_xlat_cache';
  const QWEN_URL   = 'http://localhost:1234/v1/chat/completions';
  const GTRANS    = 'https://translate.googleapis.com/translate_a/single';

  // Language roster — builtin:true → delegate to janapress native setLang
  const LANGS = [
    { code: 'en', label: 'English',     flag: '🇬🇧', builtin: true },
    { code: 'sk', label: 'Slovenčina',  flag: '🇸🇰', builtin: true },
    { code: 'de', label: 'Deutsch',     flag: '🇩🇪' },
    { code: 'fr', label: 'Français',    flag: '🇫🇷' },
    { code: 'cs', label: 'Čeština',     flag: '🇨🇿' },
    { code: 'hu', label: 'Magyar',      flag: '🇭🇺' },
    { code: 'pl', label: 'Polski',      flag: '🇵🇱' },
    { code: 'es', label: 'Español',     flag: '🇪🇸' },
    { code: 'it', label: 'Italiano',    flag: '🇮🇹' },
    { code: 'uk', label: 'Українська',  flag: '🇺🇦' },
    { code: 'ro', label: 'Română',      flag: '🇷🇴' },
    { code: 'hr', label: 'Hrvatski',    flag: '🇭🇷' },
  ];

  let _activeLang  = 'en';   // tracks current active language code
  let _cancelToken = false;  // set true to abort an in-progress translation
  let _wrapEl      = null;   // the #jp-translate-wrap DOM element
  let _panelOpen   = false;
  let _progressEl  = null;

  // ── OMNI-OPS DevBridge (BroadcastChannel) ──────────────────────────────
  // Intelligence lives in the scaffolding — any external system can control
  // the plugin via: new BroadcastChannel('janapress-translate').postMessage({type:'translate',code:'de'})
  const bridge = new BroadcastChannel('janapress-translate');
  bridge.onmessage = ({ data }) => {
    if (!data?.type) return;
    if (data.type === 'translate' && data.code) translate(data.code);
    if (data.type === 'clear_cache') clearCache();
    if (data.type === 'get_status') {
      bridge.postMessage({
        type: 'status', plugin: PLUGIN_ID, version: VERSION,
        active: _activeLang,
        langs: LANGS.map(l => l.code),
        cached: Object.keys(_loadCache()),
      });
    }
  };

  // ── CACHE ───────────────────────────────────────────────────────────────
  function _loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
    catch { return {}; }
  }

  function _saveCache(cache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) { /* quota */ }
  }

  function clearCache() {
    localStorage.removeItem(CACHE_KEY);
    _showToast('Translation cache cleared.');
    _refreshPanel();
    bridge.postMessage({ type: 'cache_cleared', plugin: PLUGIN_ID });
  }

  // ── TOAST ────────────────────────────────────────────────────────────────
  function _showToast(msg) {
    // Prefer janapress native toast if available
    if (typeof window.toast === 'function') { window.toast(msg); return; }
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', bottom: '24px', left: '50%',
      transform: 'translateX(-50%)', background: '#1A1210', color: '#fff',
      padding: '8px 18px', borderRadius: '100px', fontSize: '13px',
      zIndex: '99999', fontFamily: 'var(--sans, system-ui)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  // ── PROGRESS UI ──────────────────────────────────────────────────────────
  function _showProgress(label) {
    if (_progressEl) _progressEl.remove();
    _progressEl = document.createElement('div');
    _progressEl.id = 'jp-translate-progress';
    _progressEl.innerHTML = `
      <span class="jp-prog-spinner">↻</span>
      <span class="jp-prog-label">${label}</span>
      <div class="jp-prog-bar-wrap"><div class="jp-prog-bar" style="width:0%"></div></div>
      <button class="jp-prog-cancel" id="jp-cancel-btn">Cancel</button>
    `;
    document.body.appendChild(_progressEl);
    const cancelBtn = document.getElementById('jp-cancel-btn');
    if (cancelBtn) cancelBtn.onclick = _cancel;
  }

  function _updateProgress(pct, label) {
    if (!_progressEl) return;
    const bar = _progressEl.querySelector('.jp-prog-bar');
    const lbl = _progressEl.querySelector('.jp-prog-label');
    if (bar) bar.style.width = Math.round(pct) + '%';
    if (lbl && label) lbl.textContent = label;
  }

  function _hideProgress() {
    if (_progressEl) { _progressEl.remove(); _progressEl = null; }
  }

  // ── TRANSLATION ENGINES ──────────────────────────────────────────────────

  // Engine 1: Qwen local LLM — translates full dict in one call
  // OMNI-OPS principle: intelligence lives in scaffolding, model just executes
  async function _translateViaQwen(dict, langLabel) {
    const keys   = Object.keys(dict);
    const values = keys.map(k => dict[k]);
    const prompt = [
      'You are a professional translator.',
      `Translate the following ${values.length} UI strings from English to ${langLabel}.`,
      'Rules: preserve formatting, quotes, arrows (→, ←), ellipsis (…), special chars.',
      'Return ONLY a valid JSON array of translated strings in the same order.',
      'No markdown, no explanation, no extra text.',
      '',
      JSON.stringify(values),
    ].join('\n');

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 25000);

    try {
      const res = await fetch(QWEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body:    JSON.stringify({
          model:        'qwen3-8b',
          messages:     [{ role: 'user', content: '/no_think ' + prompt }],
          temperature:  0.1,
          max_tokens:   4096,
          stream:       false,
        }),
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error('Qwen HTTP ' + res.status);
      const data = await res.json();
      const raw  = (data.choices?.[0]?.message?.content || '').trim();
      // Strip <think>…</think> blocks and markdown fences
      const cleaned = raw
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/^```[^\n]*\n?/, '')
        .replace(/\n?```$/, '')
        .trim();
      const translated = JSON.parse(cleaned);
      if (!Array.isArray(translated) || translated.length !== keys.length) {
        throw new Error('Qwen length mismatch');
      }
      const out = {};
      keys.forEach((k, i) => { out[k] = typeof translated[i] === 'string' ? translated[i] : dict[k]; });
      return out;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Engine 2: Google Translate unofficial — per-string with rate limiting
  async function _translateViaGoogle(dict, targetCode) {
    const keys = Object.keys(dict);
    const out  = {};
    const _delay = ms => new Promise(r => setTimeout(r, ms));

    for (let i = 0; i < keys.length; i++) {
      if (_cancelToken) throw new Error('cancelled');
      const k = keys[i];
      const v = dict[k];
      _updateProgress((i / keys.length) * 100, `Translating… (${i + 1}/${keys.length})`);
      try {
        const url = `${GTRANS}?client=gtx&sl=en&tl=${encodeURIComponent(targetCode)}&dt=t&q=${encodeURIComponent(v)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        // Google returns: [[["translated","original",...],null,...],...]
        const translated = data?.[0]?.map(x => x?.[0]).filter(Boolean).join('') || v;
        out[k] = translated;
      } catch (_) {
        out[k] = v; // keep original on individual string error
      }
      if (i < keys.length - 1) await _delay(80); // ~12 req/s — polite rate limit
    }
    return out;
  }

  // ── MAIN TRANSLATE FUNCTION ──────────────────────────────────────────────
  async function translate(code) {
    const lang = LANGS.find(l => l.code === code);
    if (!lang) { _showToast('Unknown language: ' + code); return; }

    // Built-in: delegate directly to janapress
    if (lang.builtin) {
      if (typeof window.setLang === 'function') window.setLang(code);
      // _activeLang updated by wrapped setLang
      _refreshPanel();
      return;
    }

    // Check cache — instant apply
    const cache = _loadCache();
    if (cache[code]) {
      window.L[code] = cache[code];
      if (typeof window.setLang === 'function') window.setLang(code);
      _refreshPanel();
      _showToast(`${lang.flag} ${lang.label} (cached)`);
      bridge.postMessage({ type: 'lang_applied', code, source: 'cache', plugin: PLUGIN_ID });
      return;
    }

    // Need to fetch translation
    _cancelToken = false;
    const sourceDict = window.L?.en || {};
    _closePanel();
    _showProgress(`Connecting to OMNI LLM…`);

    try {
      let translated;

      // Engine 1: Qwen (OMNI-OPS local LLM — zero cost, privacy-safe)
      try {
        _updateProgress(10, 'OMNI LLM: translating…');
        translated = await _translateViaQwen(sourceDict, lang.label);
        _updateProgress(100, `OMNI LLM complete ✓`);
        bridge.postMessage({ type: 'translated', code, source: 'qwen', plugin: PLUGIN_ID });
      } catch (_e) {
        // Engine 2: Google Translate fallback
        if (_cancelToken) throw new Error('cancelled');
        _updateProgress(5, 'OMNI LLM offline — Google Translate…');
        await new Promise(r => setTimeout(r, 500));
        translated = await _translateViaGoogle(sourceDict, code);
        bridge.postMessage({ type: 'translated', code, source: 'google', plugin: PLUGIN_ID });
      }

      if (_cancelToken) { _hideProgress(); return; }

      // Persist to cache, inject into L, apply
      cache[code] = translated;
      _saveCache(cache);
      window.L[code] = translated;
      if (typeof window.setLang === 'function') window.setLang(code);
      _refreshPanel();
      _hideProgress();
      _showToast(`${lang.flag} ${lang.label} applied`);

    } catch (e) {
      _hideProgress();
      if (e.message !== 'cancelled') {
        _showToast('Translation failed: ' + e.message);
        bridge.postMessage({ type: 'error', code, error: e.message, plugin: PLUGIN_ID });
      }
    }
  }

  function _cancel() {
    _cancelToken = true;
    _hideProgress();
    _showToast('Translation cancelled.');
  }

  // ── STYLES ────────────────────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById('jp-translate-styles')) return;
    const s = document.createElement('style');
    s.id = 'jp-translate-styles';
    s.textContent = `
      /* jp-translate.js — OMNI-OPS plugin styles */
      #jp-translate-wrap {
        position: relative;
      }
      .jp-translate-btn {
        display: flex; align-items: center; gap: 5px;
        padding: 5px 10px;
        background: var(--surface2, #F7F2EE);
        border: 1px solid var(--border, #EBE4DC);
        border-radius: 100px;
        font-family: var(--sans, system-ui);
        font-size: 0.72rem; font-weight: 600;
        color: var(--muted, #7A6A60);
        cursor: pointer; transition: all 0.15s;
        white-space: nowrap;
      }
      .jp-translate-btn:hover {
        border-color: var(--pink, #C84060);
        color: var(--pink, #C84060);
      }
      .jp-translate-btn.jp-active {
        background: var(--pink, #C84060);
        border-color: var(--pink, #C84060);
        color: #fff;
      }
      #jp-translate-panel {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        background: var(--surface, #fff);
        border: 1px solid var(--border, #EBE4DC);
        border-radius: 12px;
        padding: 8px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        min-width: 200px;
        z-index: 9999;
        display: none;
        flex-direction: column;
        gap: 2px;
      }
      #jp-translate-panel.jp-open { display: flex; }
      .jp-panel-section-label {
        font-size: 10px; font-weight: 600; letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--muted2, #B8A898);
        padding: 4px 10px 2px;
      }
      .jp-lang-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.12s;
        user-select: none;
      }
      .jp-lang-row:hover { background: var(--surface2, #F7F2EE); }
      .jp-lang-row.jp-active {
        background: var(--pink-pale, #FDF0F3);
        color: var(--pink, #C84060);
      }
      .jp-lang-flag { font-size: 15px; line-height: 1; }
      .jp-lang-name { font-size: 12.5px; flex: 1; font-family: var(--sans, system-ui); }
      .jp-lang-badge {
        font-size: 10px; color: var(--green, #4A9A5A);
        background: #EDF7EF; border-radius: 4px;
        padding: 1px 5px; font-weight: 600;
      }
      .jp-divider {
        height: 1px;
        background: var(--border, #EBE4DC);
        margin: 4px 2px;
      }
      .jp-panel-footer {
        font-size: 11px; color: var(--muted2, #B8A898);
        padding: 4px 10px 2px;
        cursor: pointer; border-radius: 6px;
        transition: color 0.12s;
      }
      .jp-panel-footer:hover { color: var(--pink, #C84060); }
      /* Progress overlay */
      #jp-translate-progress {
        position: fixed;
        bottom: 72px; left: 50%;
        transform: translateX(-50%);
        background: var(--surface, #fff);
        border: 1px solid var(--border, #EBE4DC);
        border-radius: 14px;
        padding: 14px 18px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.13);
        min-width: 260px; max-width: 340px;
        z-index: 99998;
        display: flex; flex-direction: column; gap: 10px;
        font-family: var(--sans, system-ui);
      }
      .jp-prog-spinner {
        font-size: 18px;
        display: inline-block;
        animation: jp-spin 1s linear infinite;
        color: var(--pink, #C84060);
        align-self: flex-start;
      }
      @keyframes jp-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .jp-prog-label {
        font-size: 13px; color: var(--text, #1A1210);
        line-height: 1.4;
      }
      .jp-prog-bar-wrap {
        width: 100%; height: 4px;
        background: var(--border, #EBE4DC);
        border-radius: 2px; overflow: hidden;
      }
      .jp-prog-bar {
        height: 100%;
        background: var(--pink, #C84060);
        border-radius: 2px;
        transition: width 0.3s ease;
      }
      .jp-prog-cancel {
        align-self: flex-start;
        background: transparent;
        border: 1px solid var(--border, #EBE4DC);
        border-radius: 6px;
        padding: 3px 12px;
        cursor: pointer;
        font-size: 12px;
        color: var(--muted, #7A6A60);
        font-family: var(--sans, system-ui);
        transition: all 0.12s;
      }
      .jp-prog-cancel:hover {
        border-color: var(--pink, #C84060);
        color: var(--pink, #C84060);
      }
    `;
    document.head.appendChild(s);
  }

  // ── UI BUILD ─────────────────────────────────────────────────────────────
  function _buildUI() {
    _injectStyles();

    _wrapEl = document.createElement('div');
    _wrapEl.id = 'jp-translate-wrap';

    // Toggle button
    const btn = document.createElement('button');
    btn.id = 'jp-translate-btn';
    btn.className = 'jp-translate-btn';
    btn.title = 'Translate janapress to another language';
    btn.innerHTML = '🌐 <span>Translate</span>';
    btn.addEventListener('click', e => { e.stopPropagation(); _togglePanel(); });
    _wrapEl.appendChild(btn);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'jp-translate-panel';

    // Built-in section
    const builtinLabel = document.createElement('div');
    builtinLabel.className = 'jp-panel-section-label';
    builtinLabel.textContent = 'Built-in';
    panel.appendChild(builtinLabel);
    LANGS.filter(l => l.builtin).forEach(l => panel.appendChild(_buildLangRow(l)));

    // Divider
    panel.appendChild(_buildDivider());

    // AI-translated section
    const aiLabel = document.createElement('div');
    aiLabel.className = 'jp-panel-section-label';
    aiLabel.textContent = 'AI Translated';
    panel.appendChild(aiLabel);
    LANGS.filter(l => !l.builtin).forEach(l => panel.appendChild(_buildLangRow(l)));

    // Footer — cache clear
    panel.appendChild(_buildDivider());
    const footer = document.createElement('div');
    footer.className = 'jp-panel-footer';
    footer.textContent = '× Clear translation cache';
    footer.addEventListener('click', () => { clearCache(); _closePanel(); });
    panel.appendChild(footer);

    _wrapEl.appendChild(panel);

    // Insert before #lang-wrap in the topbar
    const langWrap = document.getElementById('lang-wrap');
    if (langWrap && langWrap.parentNode) {
      langWrap.parentNode.insertBefore(_wrapEl, langWrap);
    } else {
      // Fallback: append to topbar-actions
      const ta = document.querySelector('.topbar-actions');
      if (ta) ta.appendChild(_wrapEl);
    }

    // Close on outside click
    document.addEventListener('click', e => {
      if (_panelOpen && _wrapEl && !_wrapEl.contains(e.target)) _closePanel();
    });
  }

  function _buildDivider() {
    const d = document.createElement('div');
    d.className = 'jp-divider';
    return d;
  }

  function _buildLangRow(lang) {
    const row = document.createElement('div');
    row.className = 'jp-lang-row';
    row.dataset.code = lang.code;
    _updateRowState(row, lang);
    row.addEventListener('click', () => { translate(lang.code); _closePanel(); });
    return row;
  }

  function _updateRowState(row, lang) {
    const code     = lang.code;
    const cache    = _loadCache();
    const isCached = !lang.builtin && !!cache[code];
    const isActive = _activeLang === code;
    row.classList.toggle('jp-active', isActive);
    row.innerHTML = `
      <span class="jp-lang-flag">${lang.flag}</span>
      <span class="jp-lang-name">${lang.label}</span>
      ${isCached ? '<span class="jp-lang-badge">cached</span>' : ''}
    `;
    // Re-attach click (innerHTML wiped it)
    row.addEventListener('click', () => { translate(lang.code); _closePanel(); });
  }

  function _refreshPanel() {
    if (!_wrapEl) return;
    // Update all lang rows
    _wrapEl.querySelectorAll('.jp-lang-row').forEach(row => {
      const code = row.dataset.code;
      const lang = LANGS.find(l => l.code === code);
      if (lang) _updateRowState(row, lang);
    });
    // Update toggle button active state
    const btn = document.getElementById('jp-translate-btn');
    if (btn) {
      const isAI = _activeLang && !LANGS.find(l => l.code === _activeLang)?.builtin;
      btn.classList.toggle('jp-active', !!isAI);
      const label = LANGS.find(l => l.code === _activeLang);
      btn.innerHTML = isAI && label
        ? `${label.flag} <span>${label.label}</span>`
        : '🌐 <span>Translate</span>';
    }
  }

  function _togglePanel() { _panelOpen ? _closePanel() : _openPanel(); }

  function _openPanel() {
    _refreshPanel();
    const panel = document.getElementById('jp-translate-panel');
    if (panel) panel.classList.add('jp-open');
    _panelOpen = true;
  }

  function _closePanel() {
    const panel = document.getElementById('jp-translate-panel');
    if (panel) panel.classList.remove('jp-open');
    _panelOpen = false;
  }

  // ── WRAP JANAPRESS setLang TO TRACK ACTIVE LANGUAGE ──────────────────────
  // Intelligence lives in scaffolding: we intercept the native call without
  // modifying host code — host machinery does all the rendering work.
  function _wrapSetLang() {
    const orig = window.setLang;
    if (!orig || orig._jpWrapped) return;
    window.setLang = function (code) {
      _activeLang = code;
      orig.call(this, code);
      // Refresh our panel to reflect new active state
      // (minor: _refreshPanel reads DOM so safe to call here)
      setTimeout(_refreshPanel, 0);
    };
    window.setLang._jpWrapped = true;
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────────
  window.jpTranslate = {
    /** Translate janapress to a language code (e.g. 'de', 'fr', 'es') */
    translate,
    /** Clear the localStorage translation cache */
    clearCache,
    /** Full language roster */
    langs: LANGS,
    /** Plugin version */
    version: VERSION,
    /** Cancel an in-progress translation */
    _cancel,
    /** Returns currently active language code */
    active: () => _activeLang,
  };

  // ── INIT ──────────────────────────────────────────────────────────────────
  // Poll until janapress has loaded its L object and setLang function.
  // Works whether this script loads before or after index.html's inline script.
  function _init() {
    if (!window.L || !window.setLang || !document.getElementById('lang-wrap')) {
      setTimeout(_init, 150);
      return;
    }
    _wrapSetLang();
    // Detect current language from localStorage (mirrors janapress's own boot logic)
    _activeLang = localStorage.getItem('jp_lang') || 'en';
    _buildUI();
    bridge.postMessage({ type: 'ready', plugin: PLUGIN_ID, version: VERSION, v: VERSION });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    setTimeout(_init, 0);
  }

})();
