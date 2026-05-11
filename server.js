// server.js (CommonJS)

const http = require('http');
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const { pipeline } = require('stream');
const iconv = require('iconv-lite');

// got v12（ESM）を動的import
let gotPromise;
async function getGot() {
  if (!gotPromise) gotPromise = import('got').then(m => m.default || m);
  return gotPromise;
}

const app = express();
const BUILD_ID = process.env.BUILD_ID || Math.random().toString(36).slice(2);

const UPSTREAM_PROXY_URL = process.env.UPSTREAM_PROXY_URL || '';
const { ProxyAgent } = require('proxy-agent');
const proxyAgent = UPSTREAM_PROXY_URL ? new ProxyAgent({ getProxyForUrl: () => UPSTREAM_PROXY_URL }) : null;

// 基本ミドルウェア
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false
}));
app.use(compression());
app.use(morgan('tiny'));
app.use(cookieParser());

// 静的ファイル（client.jsはno-store）
app.use('/public', express.static(path.join(__dirname, 'public'), {
  setHeaders(res, fp) {
    const noStore = fp.endsWith('client.js');
    res.setHeader('Cache-Control', noStore ? 'no-store' : 'public, max-age=600');
  }
}));

// 画面
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// “アドレス固定”シェル: /s?url=...
app.get('/s', (req, res) => {
  const raw = req.query.url || 'https://www.google.com/';
  let abs;
  try { abs = new URL(raw).toString(); } catch { return res.status(400).send('Invalid url'); }

  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Proxy Shell</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html,body{height:100%;margin:0}
    #bar{display:flex;gap:8px;align-items:center;padding:8px;border-bottom:1px solid #ddd;box-sizing:border-box}
    #url{flex:1;padding:6px 8px;border:1px solid #bbb;border-radius:4px}
    #view{width:100%;height:calc(100% - 50px);border:0;display:block}
  </style>
</head>
<body>
  <div id="bar">
    <form id="f" action="/s" method="get" style="display:flex;gap:8px;flex:1">
      <input id="url" type="text" name="url" value="${abs.replace(/"/g,'&quot;')}" placeholder="https://example.com">
      <button type="submit">開く</button>
      <button type="button" id="back">戻る</button>
      <button type="button" id="fwd">進む</button>
    </form>
  </div>
  <iframe id="view"
    sandbox="allow-scripts allow-forms allow-same-origin"
    referrerpolicy="no-referrer"
    src="/p?url=${encodeURIComponent(abs)}"></iframe>
  <script>
    (function(){
      const v = document.getElementById('view');
      const u = document.getElementById('url');
      const back = document.getElementById('back');
      const fwd = document.getElementById('fwd');

      const updateBar = () => { try { u.value = v.contentWindow.location.href; } catch {} };
      v.addEventListener('load', updateBar);

      back.onclick = () => { try { v.contentWindow.history.back(); } catch {} };
      fwd.onclick  = () => { try { v.contentWindow.history.forward(); } catch {} };

      v.addEventListener('load', () => {
        try {
          const w = v.contentWindow;
          const _open = w.open;
          w.open = function(u,t,f){
            try { if (typeof u === 'string') u = '/p?url=' + encodeURIComponent(new URL(u, w.location.href).toString()); } catch {}
            w.location.href = u;
            return null;
          };
        } catch {}
      });
    })();
  </script>
</body>
</html>`;
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
});

// 入力ショートカット
app.get('/go', (req, res) => {
  const { q, url } = req.query;
  if (url) return res.redirect(302, `/p?url=${encodeURIComponent(url)}`);
  if (q)  return res.redirect(302, `/p?url=${encodeURIComponent('https://duckduckgo.com/?q=' + encodeURIComponent(q))}`);
  res.redirect('/');
});

// セッションCookieJar/最後の基準URL
const jars = new Map();        // psid -> CookieJar
const lastBaseUrl = new Map(); // psid -> URL

function getJar(req, res) {
  let id = req.cookies.psid;
  if (!id) {
    id = Math.random().toString(36).slice(2);
    res.cookie('psid', id, { httpOnly: true, sameSite: 'Lax' });
  }
  if (!jars.has(id)) jars.set(id, new CookieJar());
  return { id, jar: jars.get(id) };
}

// /p サルベージ（Google対策: /p へ q=... が飛んできた場合）
app.get('/p', (req, res, next) => {
  if (req.query.url) return next();
  const { id } = getJar(req, res);
  const base = lastBaseUrl.get(id);
  const qs = (req.originalUrl.split('?')[1] || '');
  if (base && (req.method === 'GET' || req.method === 'HEAD')) {
    // Googleなら /search にQSを付け直す。それ以外は base にQSを連結
    let final;
    if (/(^|\.)google\./i.test(base.hostname)) {
      final = new URL('/search', base);
      final.search = qs;
      normalizeGoogle(final);
    } else {
      final = new URL(base.href);
      if (qs) {
        const cur = final.search ? (final.search + '&' + qs) : ('?' + qs);
        final.search = cur.replace(/^\?+/, '?');
      }
    }
    return res.redirect(302, '/p?url=' + encodeURIComponent(final.toString()));
  }
  return res.status(400).send('Missing url param');
});

// 中核プロキシ（Cookieは手動管理）
app.all('/p', async (req, res) => {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).send('Missing url param');

    let targetUrl;
    try { targetUrl = new URL(raw); } catch { return res.status(400).send('Invalid url'); }
    if (!/^https?:$/.test(targetUrl.protocol)) return res.status(400).send('Only http/https supported');

    if ((/(^|\.)google\./i.test(targetUrl.hostname))) normalizeGoogle(targetUrl);

    // 上流へ渡すヘッダ（不要・危険なものは除外）
    const outboundHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (v === undefined) continue;
      const low = k.toLowerCase();
      if (['host','accept-encoding','content-length','cookie','connection','upgrade-insecure-requests','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user'].includes(low)) continue;
      outboundHeaders[low] = v;
    }
    // referer/originは可能ならターゲット同一オリジンへ
    if (req.headers.referer && req.headers.referer.includes('/p?url=')) {
      try {
        const u = new URL(decodeURIComponent(req.headers.referer.split('/p?url=')[1]));
        outboundHeaders.referer = u.toString();
        outboundHeaders.origin = u.origin;
      } catch {}
    }

    const method = (req.method || 'GET').toUpperCase();
    const hasBody = !['GET','HEAD','OPTIONS'].includes(method);
    const { id, jar } = getJar(req, res);
    lastBaseUrl.set(id, targetUrl);

    // Cookie を手動付与
    try {
      const cookieStr = await jar.getCookieString(targetUrl.toString());
      if (cookieStr) outboundHeaders.cookie = cookieStr;
    } catch {}

    const got = await getGot();
    const opts = {
      method,
      headers: outboundHeaders,
      throwHttpErrors: false,
      followRedirect: false,
      decompress: true,
      http2: false,
      timeout: { connect: 8000, request: 25000 }
    };
    if (hasBody) opts.body = req;
    if (proxyAgent) opts.agent = { http: proxyAgent, https: proxyAgent };

    const upstream = got.stream(targetUrl.toString(), opts);

    upstream.once('response', async (upRes) => {
      // Set-Cookie をサーバ内jarへ格納（クライアントへは返さない）
      const setCookies = upRes.headers['set-cookie'];
      if (setCookies) {
        const list = Array.isArray(setCookies) ? setCookies : [setCookies];
        for (const sc of list) { try { await jar.setCookie(sc, targetUrl.toString()); } catch {} }
      }

      // リダイレクトは /p?url=... に
      if (upRes.headers.location) {
        try {
          const loc = new URL(upRes.headers.location, targetUrl).toString();
          upRes.headers.location = `/p?url=${encodeURIComponent(loc)}`;
        } catch {}
      }

      // ブラウザ挙動を阻害するヘッダ＋Set-Cookie を除去
      [
        'content-security-policy','content-security-policy-report-only','x-frame-options',
        'cross-origin-opener-policy','cross-origin-embedder-policy','permissions-policy',
        'referrer-policy','etag','content-length','content-encoding','set-cookie'
      ].forEach(h => delete upRes.headers[h]);

      const ct = (upRes.headers['content-type'] || '').toLowerCase();

      if (ct.includes('text/html')) {
        const bufs = [];
        upstream.on('data', c => bufs.push(Buffer.from(c)));
        upstream.on('end', () => {
          try {
            const rawBuf = Buffer.concat(bufs);
            const charset = detectCharset(ct, rawBuf) || 'utf-8';
            const html = iconv.decode(rawBuf, charset);
            const rewritten = rewriteHTML(html, targetUrl);
            const out = Buffer.from(rewritten, 'utf8');
            res.status(upRes.statusCode || 200);
            res.set({ ...upRes.headers, 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', 'content-length': out.length });
            res.send(out);
          } catch (e) { if (!res.headersSent) res.status(500).send('Rewrite error: ' + e.message); }
        });
        upstream.on('error', (e) => { if (!res.headersSent) res.status(502).send('Upstream error: ' + e.message); });
        return;
      }

      if (ct.includes('text/css')) {
        const bufs = [];
        upstream.on('data', c => bufs.push(Buffer.from(c)));
        upstream.on('end', () => {
          try {
            const rawBuf = Buffer.concat(bufs);
            const charset = detectCharset(ct, rawBuf) || 'utf-8';
            const css = iconv.decode(rawBuf, charset);
            const rewritten = rewriteCSS(css, targetUrl);
            const out = Buffer.from(rewritten, 'utf8');
            res.status(upRes.statusCode || 200);
            res.set({ ...upRes.headers, 'content-type':'text/css; charset=utf-8', 'cache-control':'public, max-age=600', 'content-length': out.length });
            res.send(out);
          } catch (e) { if (!res.headersSent) res.status(500).send('Rewrite error: ' + e.message); }
        });
        upstream.on('error', (e) => { if (!res.headersSent) res.status(502).send('Upstream error: ' + e.message); });
        return;
      }

      // その他はそのままストリーム
      res.status(upRes.statusCode || 200);
      Object.entries(upRes.headers).forEach(([k, v]) => { if (v !== undefined) res.setHeader(k, v); });
      pipeline(upstream, res, (err) => { if (err && !res.headersSent) res.status(502).end('Stream error'); });
    });

    upstream.on('error', (e) => { if (!res.headersSent) res.status(502).send('Fetch error: ' + e.message); });
  } catch (e) {
    if (!res.headersSent) res.status(500).send('Server error: ' + e.message);
  }
});

// Global fallback（直叩き救済: /p 以外のGETを最後の基準URLから復元）
app.use((req, res, next) => {
  if (!(req.method === 'GET' || req.method === 'HEAD')) return next();
  const p = req.path || '';
  if (p === '/p' || p.startsWith('/public') || p === '/healthz' || p === '/go' || p === '/s' || p === '/') return next();
  try {
    const sid = req.cookies.psid;
    const base = sid && lastBaseUrl.get(sid);
    if (!base) return next();
    const abs = new URL(req.originalUrl, base);
    return res.redirect(302, '/p?url=' + encodeURIComponent(abs.toString()));
  } catch { next(); }
});

// Google 安定化
function normalizeGoogle(u) {
  const setIfNone = (k, v) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v); };
  setIfNone('gbv','1'); setIfNone('hl','ja'); setIfNone('gl','JP'); setIfNone('pccc','1'); setIfNone('udm','14');
}

// HTML/CSS リライタ
function rewriteHTML(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const prox = (u) => `/p?url=${encodeURIComponent(new URL(u, baseUrl).toString())}`;

  $('base').remove();
  $('meta[name="referrer"]').remove();
  $('meta[http-equiv="content-security-policy"]').remove();

  const attrs = [
    ['a','href'],['link','href'],['script','src'],['img','src'],['iframe','src'],['frame','src'],
    ['video','src'],['audio','src'],['source','src'],['track','src'],['form','action'],['video','poster']
  ];
  for (const [tag, attr] of attrs) {
    $(tag).each((_, el) => {
      const $el = $(el); const val = $el.attr(attr);
      if (val && !/^(data:|blob:|mailto:|tel:|about:|javascript:)/i.test(val)) {
        try { $el.attr(attr, prox(val)); } catch {}
      }
      if (attr === 'src' || attr === 'href') $el.removeAttr('integrity');
    });
  }

  $('img[srcset],source[srcset]').each((_, el) => {
    const $el = $(el); const s = $el.attr('srcset'); if (!s) return;
    $el.attr('srcset', s.split(',').map(it => {
      const [url, size] = it.trim().split(/\s+/, 2);
      try { return `${prox(url)}${size ? ' ' + size : ''}`; } catch { return it; }
    }).join(', '));
  });

  $('[style]').each((_, el) => {
    const st = $(el).attr('style'); if (!st) return;
    $(el).attr('style', rewriteCSS(st, baseUrl));
  });
  $('style').each((_, el) => {
    const css = $(el).html() || '';
    $(el).html(rewriteCSS(css, baseUrl));
  });

  $('meta[http-equiv="refresh"]').each((_, el) => {
    const c = $(el).attr('content'); if (!c) return;
    const m = c.match(/^\s*\d+\s*;\s*url=(.+)$/i);
    if (m) { try { $(el).attr('content', c.replace(m[1], prox(m[1]))); } catch {} }
  });

  // 直リンク化を下げる軽い対策
  $('link[rel="preconnect"],link[rel="dns-prefetch"],link[rel="prerender"]').remove();

  if ($('head').length === 0) $('html').prepend('<head></head>');
  $('head').prepend(
    '<script>window.__ORIGIN_URL=' + JSON.stringify(baseUrl.toString()) + ';</script>' +
    '<script src="/public/client.js?v=' + BUILD_ID + '"></script>'
  );

  return $.html();
}

function rewriteCSS(css, baseUrl) {
  return css.replace(/url$\s*(?:'([^']*)'|"([^"]*)"|([^)]+))\s*$/gi, (m, s1, s2, s3) => {
    let raw = (s1 || s2 || s3 || '').trim();
    if (!raw || raw.startsWith('#') || /^(data:|blob:|about:|mailto:|tel:|javascript:)/i.test(raw)) return m;
    try { return `url(/p?url=${encodeURIComponent(new URL(raw, baseUrl).toString())})`; }
    catch { return m; }
  });
}

// 文字コード簡易判定
function detectCharset(ctHeader, buf) {
  const m = /charset=([\w\-:]+)/i.exec(ctHeader || ''); if (m) return m[1].toLowerCase();
  const head = buf.slice(0, 4096).toString('ascii');
  let mm = head.match(/<meta\s+charset=["']?([\w\-:]+)["']?/i); if (mm) return mm[1].toLowerCase();
  mm = head.match(/<meta\s+http-equiv=["']content-type["'][^>]*charset=([\w\-:]+)/i); if (mm) return mm[1].toLowerCase();
  return null;
}

// 起動
const PORT = process.env.PORT || 3000;
http.createServer(app).listen(PORT, () => console.log('Proxy listening on ' + PORT + ' BUILD_ID=' + BUILD_ID));
