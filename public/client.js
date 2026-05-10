(function () {
  const ORIGIN = window.__ORIGIN_URL || location.href;

  const toAbs = (u) => { try { return new URL(u, ORIGIN).toString(); } catch { return u; } };
  const isProxied = (u) => typeof u === 'string' && u.startsWith('/p?url=');
  const isSkippable = (u) => typeof u === 'string' && /^(?:\s*$|#|data:|blob:|about:|mailto:|tel:|javascript:)/i.test(u);
  const proxify = (u) => {
    if (!u || isSkippable(u) || isProxied(u)) return u;
    try { return '/p?url=' + encodeURIComponent(toAbs(u)); } catch { return u; }
  };

  // window.open → URLだけ必ず /p?url=... 化（targetは尊重）
  const _open = window.open;
  window.open = function (u, t, f) {
    if (typeof u === 'string') u = proxify(u);
    return _open ? _open.call(window, u, t, f) : null;
  };

  // History API
  const _push = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    if (typeof url === 'string') url = proxify(url);
    return _push(state, title, url);
  };
  const _replace = history.replaceState.bind(history);
  history.replaceState = function (state, title, url) {
    if (typeof url === 'string') url = proxify(url);
    return _replace(state, title, url);
  };

  // Location assign/replace/href セッター
  try {
    const _assign = Location.prototype.assign;
    Location.prototype.assign = function (u) { return _assign.call(this, proxify(u)); };
    const _repl = Location.prototype.replace;
    Location.prototype.replace = function (u) { return _repl.call(this, proxify(u)); };
    try {
      const desc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      if (!desc || desc.configurable) {
        Object.defineProperty(Location.prototype, 'href', {
          set(v) { this.assign(v); },
          get() { try { return this.toString(); } catch { return ''; } }
        });
      }
    } catch {}
  } catch {}

  // a[href] のクリック捕捉（キャプチャ段階）
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || /^javascript:|^#/.test(href)) return;

    const px = proxify(href);
    if (px !== href) {
      e.preventDefault();
      const tgt = a.getAttribute('target');
      if (tgt && tgt !== '_self') window.open(px, tgt || '_blank');
      else location.assign(px);
    }
  }, true);

  // setAttribute で後付けされる href/src/action/srcset を捕捉
  (function () {
    const _setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        const n = String(name).toLowerCase();
        if ((n === 'href' || n === 'src' || n === 'action') && typeof value === 'string') {
          const px = proxify(value);
          if (px === value) return _setAttr.call(this, name, value);
          return _setAttr.call(this, name, px);
        }
        if (n === 'srcset' && typeof value === 'string') {
          return _setAttr.call(this, name, rewriteSrcset(value));
        }
      } catch {}
      return _setAttr.call(this, name, value);
    };
  })();

  // フォーム送信（GETはURL再構成 / POSTは action を proxify）— submitter 対応
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;

    const method = (f.method || 'GET').toUpperCase();
    const action = f.action || ORIGIN;

    if (method === 'GET') {
      e.preventDefault();
      const fd = ('submitter' in e && e.submitter) ? new FormData(f, e.submitter) : new FormData(f);
      const usp = new URLSearchParams();
      for (const [k, v] of fd.entries()) usp.append(k, v);
      const abs = toAbs(action);
      const qs = usp.toString();
      const finalUrl = abs + (abs.includes('?') ? (qs ? '&' : '') : '?') + qs;
      location.assign('/p?url=' + encodeURIComponent(finalUrl));
    } else {
      f.action = proxify(action);
    }
  }, true);

  // 直接 form.submit()
  (function () {
    const _submit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      try {
        const method = (this.method || 'GET').toUpperCase();
        const action = this.action || ORIGIN;
        if (method === 'GET') {
          const fd = new FormData(this);
          const usp = new URLSearchParams();
          for (const [k, v] of fd.entries()) usp.append(k, v);
          const abs = toAbs(action);
          const qs = usp.toString();
          const finalUrl = abs + (abs.includes('?') ? (qs ? '&' : '') : '?') + qs;
          return location.assign('/p?url=' + encodeURIComponent(finalUrl));
        } else {
          this.action = proxify(action);
          return _submit.call(this);
        }
      } catch {
        return _submit.call(this);
      }
    };
  })();

  // fetch / XHR を /p?url=... に
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string' || input instanceof URL) {
        return _fetch(proxify(String(input)), init);
      } else if (input && input.url) {
        const reqInit = Object.assign({}, input, init);
        return _fetch(proxify(input.url), reqInit);
      }
    } catch {}
    return _fetch(input, init);
  };
  const _openX = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { url = proxify(url); } catch {}
    return _openX.call(this, method, url, ...rest);
  };

  function rewriteSrcset(s) {
    try {
      return String(s).split(',').map(it=>{
        const [url,size] = it.trim().split(/\s+/,2);
        const px = proxify(url);
        return size ? `${px} ${size}` : px;
      }).join(', ');
    } catch { return s; }
  }
})();
