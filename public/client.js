// public/client.js
(function () {
  const ORIGIN = window.__ORIGIN_URL || location.href;
  const HOST = (()=>{ try { return new URL(ORIGIN).hostname; } catch { try { return new URL(location.href).hostname; } catch { return ''; } } })();
  const HEAVY_HOSTS = ['instagram.com','www.instagram.com','facebook.com','www.facebook.com','x.com','twitter.com','www.x.com','www.twitter.com','poki.com','www.poki.com'];

  const toAbs = (u) => { try { return new URL(u, ORIGIN).toString(); } catch { return u; } };
  const isProxied = (u) => typeof u === 'string' && u.startsWith('/p?url=');
  const isSkippable = (u) => typeof u === 'string' && /^(?:\s*$|#|data:|blob:|about:|mailto:|tel:|javascript:)/i.test(u);
  const proxify = (u) => {
    if (!u || isSkippable(u) || isProxied(u)) return u;
    try { return '/p?url=' + encodeURIComponent(toAbs(u)); } catch { return u; }
  };

  // window.open
  const _open = window.open;
  window.open = function (u, t, f) {
    if (typeof u === 'string') u = proxify(u);
    if (HEAVY_HOSTS.includes(HOST)) t = '_self';
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

  // Location
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

  // a[href]
  document.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || /^javascript:|^#/.test(href)) return;

    const px = proxify(href);
    if (px !== href) {
      e.preventDefault();
      const heavy = HEAVY_HOSTS.includes(HOST);
      const tgt = a.getAttribute('target');
      if (heavy) return location.assign(px);
      if (tgt && tgt !== '_self') window.open(px, tgt || '_blank'); else location.assign(px);
    }
  }, true);

  // setAttribute
  (function () {
    const _setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        const n = String(name).toLowerCase();
        if ((n === 'href' || n === 'src' || n === 'action' || n === 'poster') && typeof value === 'string') {
          const px = proxify(value);
          return _setAttr.call(this, name, px);
        }
        if (n === 'srcset' && typeof value === 'string') {
          return _setAttr.call(this, name, rewriteSrcset(value));
        }
        if (HEAVY_HOSTS.includes(HOST) && n === 'style' && typeof value === 'string') {
          return _setAttr.call(this, name, rewriteStyleUrls(value));
        }
      } catch {}
      return _setAttr.call(this, name, value);
    };
  })();

  // form submit（submitter対応）
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    if (HEAVY_HOSTS.includes(HOST)) { try { f.setAttribute('target','_self'); } catch {} }

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

  // 直接 submit()
  (function () {
    const _submit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      try {
        if (HEAVY_HOSTS.includes(HOST)) { try { this.setAttribute('target','_self'); } catch {} }
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

  // fetch / XHR
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

  // HEAVY: 対象ドメインのみ追加の監視
  if (HEAVY_HOSTS.includes(HOST)) {
    try { for (const el of document.querySelectorAll('a[target],form[target]')) el.setAttribute('target','_self'); } catch {}

    const wrapProp = (proto, prop, conv) => {
      if (!proto) return;
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      try {
        Object.defineProperty(proto, prop, {
          configurable: true,
          get: d.get ? function(){ return d.get.call(this); } : function(){ return undefined; },
          set: function(v){ try { v = conv(v); } catch {} return d.set.call(this, v); }
        });
      } catch {}
    };
    wrapProp(HTMLAnchorElement.prototype, 'href', proxify);
    wrapProp(HTMLLinkElement.prototype, 'href', proxify);
    wrapProp(HTMLImageElement.prototype, 'src', proxify);
    wrapProp(HTMLScriptElement.prototype, 'src', proxify);
    wrapProp(HTMLIFrameElement.prototype, 'src', proxify);
    if (window.HTMLMediaElement) wrapProp(HTMLMediaElement.prototype, 'src', proxify);
    if (window.HTMLVideoElement) wrapProp(HTMLVideoElement.prototype, 'poster', proxify);
    wrapProp(HTMLFormElement.prototype, 'action', proxify);

    if (window.HTMLImageElement) {
      const d1 = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset');
      if (d1 && d1.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'srcset', {
          configurable: true,
          get(){ return d1.get ? d1.get.call(this) : ''; },
          set(v){ try { return d1.set.call(this, rewriteSrcset(v)); } catch { return d1.set.call(this, v); } }
        });
      }
    }
    if (window.HTMLSourceElement) {
      const d2 = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'srcset');
      if (d2 && d2.set) {
        Object.defineProperty(HTMLSourceElement.prototype, 'srcset', {
          configurable: true,
          get(){ return d2.get ? d2.get.call(this) : ''; },
          set(v){ try { return d2.set.call(this, rewriteSrcset(v)); } catch { return d2.set.call(this, v); } }
        });
      }
    }

    if (window.CSSStyleDeclaration) {
      const _setProp = CSSStyleDeclaration.prototype.setProperty;
      CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
        try { if (typeof value === 'string') value = rewriteStyleUrls(value); } catch {}
        return _setProp.call(this, name, value, priority);
      };
    }

    const rewriteAttrs = (el) => {
      try {
        const tag = (el.tagName || '').toLowerCase();
        if (!tag) return;
        const fix = (attr) => {
          const v = el.getAttribute(attr);
          if (!v) return;
          if (attr === 'srcset') el.setAttribute(attr, rewriteSrcset(v));
          else if (attr === 'style') el.setAttribute(attr, rewriteStyleUrls(v));
          else el.setAttribute(attr, proxify(v));
        };
        if (tag === 'a' || tag === 'link') fix('href');
        if (tag === 'img' || tag === 'script' || tag === 'iframe' || tag === 'source') fix('src');
        if (tag === 'img' || tag === 'source') fix('srcset');
        if (tag === 'video') fix('poster');
        if (tag === 'form') fix('action');
        if (el.hasAttribute && el.hasAttribute('style')) fix('style');
        if (tag === 'a' || tag === 'form') el.setAttribute('target','_self');
      } catch {}
    };
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'attributes') rewriteAttrs(m.target);
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) {
              rewriteAttrs(n);
              const all = n.querySelectorAll ? n.querySelectorAll('[href],[src],[srcset],[action],[style],a[target],form[target]') : [];
              for (const el of all) rewriteAttrs(el);
            }
          }
        }
      }
    });
    mo.observe(document.documentElement, { attributes:true, attributeFilter:['href','src','srcset','action','style','target'], subtree:true, childList:true });
  }

  function rewriteSrcset(s) {
    try {
      return String(s).split(',').map(it=>{
        const [url,size] = it.trim().split(/\s+/,2);
        const px = proxify(url);
        return size ? `${px} ${size}` : px;
      }).join(', ');
    } catch { return s; }
  }

  function rewriteStyleUrls(text) {
    try {
      return String(text).replace(/url$\s*(?:'([^']*)'|"([^"]*)"|([^)]+))\s*$/gi,(m,s1,s2,s3)=>{
        let raw=(s1||s2||s3||'').trim();
        if(!raw||raw.startsWith('#')||/^(data:|blob:|about:|mailto:|tel:|javascript:)/i.test(raw)) return m;
        return `url(${proxify(raw)})`;
      });
    } catch { return text; }
  }
})();
