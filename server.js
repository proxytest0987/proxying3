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

// got は ESM（import() で default を取得）
let gotPromise;
function getGot() {
  if (!gotPromise) gotPromise = import('got').then(m => m.default || m);
  return gotPromise;
}

const app = express();
const BUILD_ID = process.env.BUILD_ID || Math.random().toString(36).slice(2);

// 上流プロキシ（任意）
const UPSTREAM_PROXY_URL = process.env.UPSTREAM_PROXY_URL || '';
const { ProxyAgent } = require('proxy-agent');
const proxyAgent = UPSTREAM_PROXY_URL ? new ProxyAgent({ getProxyForUrl: () => UPSTREAM_PROXY_URL }) : null;

// 基本ミドルウェア
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy:false, crossOriginEmbedderPolicy:false, crossOriginOpenerPolicy:false, crossOriginResourcePolicy:false }));
app.use(compression());
app.use(morgan('tiny'));
app.use(cookieParser());

// /public は client.js を no-store
app.use('/public', express.static(path.join(__dirname, 'public'), {
  setHeaders(res, fp) { res.setHeader('Cache-Control', fp.endsWith('client.js') ? 'no-store' : 'public, max-age=600'); }
}));

// セッションごとの CookieJar / 最後の基準URL
const jars = new Map();        // psid -> CookieJar
const lastBaseUrl = new Map(); // psid -> URL

function getJar(req, res) {
  let id = req.cookies.psid;
  if (!id) {
    id = Math.random().toString(36).slice(2);
    res.cookie('psid', id, { httpOnly:true, sameSite:'Lax' });
  }
  if (!jars.has(id)) jars.set(id, new CookieJar());
  return { id, jar: jars.get(id) };
}

// 画面
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// 入力ショートカット
app.get('/go', (req, res) => {
  const { q, url } = req.query;
  if (url) return res.redirect(302, `/p?url=${encodeURIComponent(url)}`);
  if (q)  return res.redirect(302, `/p?url=${encodeURIComponent('https://duckduckgo.com/?q=' + encodeURIComponent(q))}`);
  res.redirect('/');
});

// /p salvage（Google の Missing url param 救済）
app.get('/p', (req, res, next) => {
  if (req.query.url) return next();
  const { id } = getJar(req, res);
  const base = lastBaseUrl.get(id);
  if (base && /(^|\.)google\./i.test(base.hostname) && (req.method === 'GET' || req.method === 'HEAD')) {
    const final = new URL('/search', base);
    const idx = (req.originalUrl || '').indexOf('?');
    if (idx >= 0) final.search = req.originalUrl.slice(idx + 1);
    normalizeGoogle(final);
    return res.redirect(302, '/p?url=' + encodeURIComponent(final.toString()));
  }
  return res.status(400).send('Missing url param');
});

// 中核プロキシ（Cookieは「手動管理」）
app.all('/p', async (req, res) => {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).send('Missing url param');

    let targetUrl;
    try { targetUrl = new URL(raw); } catch { return res.status(400).send('Invalid url'); }
    if (!/^https?:$/.test(targetUrl.protocol)) return res.status(400).send('Only http/https supported');

    // Google 安定化（軽量HTML＋日本語）
    if ((/(^|\.)google\./i.test(targetUrl.hostname))) normalizeGoogle(targetUrl);

    // 上流へ渡すヘッダ（undefined排除・Cookieはつけない＝後でjarから付与）
    const outboundHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (v === undefined) continue;
      const low = k.toLowerCase();
      if (low === 'host' || low === 'accept-encoding' || low === 'content-length' || low === 'cookie') continue;
      outboundHeaders[low] = v;
    }
    // referer/origin は偽装しない（そのまま or 無し）

    const method = (req.method || 'GET').toUpperCase();
    const hasBody = !['GET','HEAD','OPTIONS'].includes(method);
    const { id, jar } = getJar(req, res);
    lastBaseUrl.set(id, targetUrl);

    // jar→Cookieヘッダ手動付与
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
      timeout: { connect: 8000, request: 20000 },
      isStream: true
    };
    if (hasBody) opts.body = req;
    if (proxyAgent) opts.agent = { http: proxyAgent, https: proxyAgent };

    const upstream = got(targetUrl.toString(), opts);

    upstream.once('response', async (upRes) => {
      // 受信Set-Cookieをサーバ側jarへ格納（クライアントへは返さない）
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
      ['content-security-policy','content-security-policy-report-only','x-frame-options',
       'cross-origin-opener-policy','cross-origin-embedder-policy','permissions-policy',
       'referrer-policy','etag','content-length','content-encoding','set-cookie'
      ].forEach(h => delete upRes.headers[h]);

      const ct = (upRes.headers['content-type'] || '').toLowerCase();

      // HTML：文字コード判定→UTF-8→書換え→ORIGIN/client.js 注入
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
            res.set({ ...upRes.headers, 'content-type':'text/html; charset=utf-8', 'content-length': out.length });
            res.send(out);
          } catch (e) { if (!res.headersSent) res.status(500).send('Rewrite error: ' + e.message); }
        });
        upstream.on('error', (e) => { if (!res.headersSent) res.status(502).send('Upstream error: ' + e.message); });
        return;
      }

      // CSS：url(...) を確実に /p?url=... に
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
            res.set({ ...upRes.headers, 'content-type':'text/css; charset=utf-8', 'content-length': out.length });
            res.send(out);
          } catch (e) { if (!res.headersSent) res.status(500).send('Rewrite error: ' + e.message); }
        });
        upstream.on('error', (e) => { if (!res.headersSent) res.status(502).send('Upstream error: ' + e.message); });
        return;
      }

      // その他はストリーム転送
      res.status(upRes.statusCode || 200);
      Object.entries(upRes.headers).forEach(([k,v]) => { if (v !== undefined) res.setHeader(k, v); });
      pipeline(upstream, res, (err)=>{ if (err && !res.headersSent) res.status(502).end('Stream error'); });
    });

    upstream.on('error', (e) => { if (!res.headersSent) res.status(502).send('Fetch error: ' + e.message); });
  } catch (e) {
    if (!res.headersSent) res.status(500).send('Server error: ' + e.message);
  }
});

// Google 安定化
function normalizeGoogle(u) {
  const setIfNone = (k, v) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v); };
  setIfNone('gbv','1'); setIfNone('hl','ja'); setIfNone('gl','JP'); setIfNone('pccc','1'); setIfNone('udm','14');
}

// HTML/CSS リライタ
function rewriteHTML(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities:false });
  const prox = (u) => `/p?url=${encodeURIComponent(new URL(u, baseUrl).toString())}`;

  $('base').remove();
  $('meta[name="referrer"]').remove();

  const attrs = [
    ['a','href'],['link','href'],['script','src'],['img','src'],['iframe','src'],['frame','src'],
    ['video','src'],['audio','src'],['source','src'],['track','src'],['form','action'],['video','poster']
  ];
  for (const [tag,attr] of attrs) {
    $(tag).each((_,el)=>{
      const $el=$(el); const val=$el.attr(attr);
      if (val && !/^(data:|blob:|mailto:|tel:|about:|javascript:)/i.test(val)) {
        try { $el.attr(attr, prox(val)); } catch {}
      }
      if (attr==='src' || attr==='href') $el.removeAttr('integrity');
    });
  }

  // 新規: target を強制 _self（新規タブで直リンク化するのを封じる）
  $('a[target], form[target]').each((_,el)=>{ try { $(el).attr('target','_self'); } catch{} });

  $('img[srcset],source[srcset]').each((_,el)=>{
    const $el=$(el); const s=$el.attr('srcset'); if(!s) return;
    $el.attr('srcset', s.split(',').map(it=>{
      const [url,size]=it.trim().split(/\s+/,2);
      try { return `${prox(url)}${size?' '+size:''}`; } catch { return it; }
    }).join(', '));
  });

  $('[style]').each((_,el)=>{
    const st=$(el).attr('style'); if(!st) return;
    $(el).attr('style', rewriteCSS(st, baseUrl));
  });
  $('style').each((_,el)=>{
    const css=$(el).html()||''; $(el).html(rewriteCSS(css, baseUrl));
  });

  $('meta[http-equiv="refresh"]').each((_,el)=>{
    const c=$(el).attr('content'); if(!c) return;
    const m=c.match(/^\s*\d+\s*;\s*url=(.+)$/i);
    if (m) { try { $(el).attr('content', c.replace(m[1], prox(m[1]))); } catch{} }
  });

  $('meta[http-equiv="content-security-policy"]').remove();

  // 余計なプリフェッチ系は削除（直リンク防止）
  $('link[rel="preconnect"],link[rel="dns-prefetch"],link[rel="prerender"]').remove();

  if ($('head').length===0) $('html').prepend('<head></head>');
  $('head').prepend(
    '<script>window.__ORIGIN_URL='+JSON.stringify(baseUrl.toString())+';</script>'+
    '<script src="/public/client.js?v='+BUILD_ID+'"></script>'
  );

  return $.html();
}

function rewriteCSS(css, baseUrl){
  return css.replace(/url$\s*(?:'([^']*)'|"([^"]*)"|([^)]+))\s*$/gi,(m,s1,s2,s3)=>{
    let raw=(s1||s2||s3||'').trim();
    if(!raw||raw.startsWith('#')||/^(data:|blob:|about:|mailto:|tel:|javascript:)/i.test(raw)) return m;
    try { return `url(/p?url=${encodeURIComponent(new URL(raw, baseUrl).toString())})`; }
    catch { return m; }
  });
}

// 文字コード簡易判定
function detectCharset(ctHeader, buf){
  const m = /charset=([\w\-:]+)/i.exec(ctHeader||''); if (m) return m[1].toLowerCase();
  const head = buf.slice(0,4096).toString('ascii');
  let mm = head.match(/<meta\s+charset=["']?([\w\-:]+)["']?/i); if (mm) return mm[1].toLowerCase();
  mm = head.match(/<meta\s+http-equiv=["']content-type["'][^>]*charset=([\w\-:]+)/i); if (mm) return mm[1].toLowerCase();
  return null;
}

// Global fallback（直叩き救済）
app.use((req,res,next)=>{
  if (!(req.method==='GET'||req.method==='HEAD')) return next();
  const p=req.path||'';
  if (p==='/p'||p.startsWith('/public')||p==='/healthz'||p==='/go') return next();
  try {
    const sid=req.cookies.psid; const base=sid && lastBaseUrl.get(sid);
    if (!base) return next();
    const abs = new URL(req.originalUrl, base);
    return res.redirect(302, '/p?url='+encodeURIComponent(abs.toString()));
  } catch { next(); }
});

// 起動
const PORT = process.env.PORT || 3000;
http.createServer(app).listen(PORT, ()=>console.log('Proxy listening on '+PORT+' BUILD_ID='+BUILD_ID));
