// routes/share.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createHash } = require('crypto');

const ShareLink = require('../models/ShareLink');
const Event = require('../models/Event');
const { anyAuth, ensureUserId } = require('../middlewares/authMiddleware');

// Genera refCode corto (compatible con Node antiguos)
function genRefCode() {
  // base64url compatible sin depender de `toString('base64url')`
  return crypto
    .randomBytes(6)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

// Hash helper (privacy-friendly): we never store raw IP/UA
function sha256(input) {
  return createHash('sha256').update(String(input || '')).digest('hex');
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || '';
}

function getRequestBaseUrl(req) {
  // Works behind proxies (Vercel/NGINX) if `trust proxy` is enabled
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

function pickApiBase(req) {
  const envBase = (process.env.API_BASE_URL || '').trim().replace(/\/$/, '');
  if (envBase) return envBase;
  return getRequestBaseUrl(req).replace(/\/$/, '');
}

function pickShareBase(req) {
  // Prefer a public/share domain if provided (e.g. https://nightvibe.life)
  const envShare = (process.env.SHARE_BASE_URL || '').trim().replace(/\/$/, '');
  if (envShare) return envShare;

  // Fallback: use API base (absolute)
  return pickApiBase(req);
}

function joinUrl(base, path) {
  const b = (base || '').replace(/\/$/, '');
  const p = (path || '').startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function pickCreatedByUserId(req) {
  const raw =
    req.userId ||
    req.user?.id ||
    req.user?._id ||
    req.auth?.userId ||
    req.body?.createdByUserId ||
    null;

  return raw ? String(raw) : null;
}

function buildAppEventUrl({ eventId, refCode, channel }) {
  const appScheme = (process.env.APP_SCHEME || 'nightvibe://').trim().replace(/\/$/, '');
  const qs = new URLSearchParams();
  if (refCode) qs.set('ref', refCode);
  if (channel) qs.set('ch', channel);
  const q = qs.toString();
  return `${appScheme}/event/${eventId}${q ? `?${q}` : ''}`;
}

function pickIosStoreUrl() {
  return (process.env.IOS_APP_STORE_URL || 'https://apps.apple.com').trim();
}

function pickAndroidStoreUrl() {
  return (process.env.ANDROID_PLAY_STORE_URL || 'https://play.google.com/store').trim();
}

function isIosUserAgent(ua) {
  const text = String(ua || '').toLowerCase();
  return /iphone|ipad|ipod/.test(text);
}

function isAndroidUserAgent(ua) {
  const text = String(ua || '').toLowerCase();
  return /android/.test(text);
}

function buildShareRedirectHtml({ appUrl, iosStoreUrl, androidStoreUrl, fallbackStoreUrl }) {
  const safeAppUrl = String(appUrl || '').replace(/"/g, '&quot;');
  const safeIosStoreUrl = String(iosStoreUrl || '').replace(/"/g, '&quot;');
  const safeAndroidStoreUrl = String(androidStoreUrl || '').replace(/"/g, '&quot;');
  const safeFallbackStoreUrl = String(fallbackStoreUrl || '').replace(/"/g, '&quot;');

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NightVibe</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: #0d111b;
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 24px;
        text-align: center;
      }
      .card {
        width: 100%;
        max-width: 420px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 18px;
        padding: 24px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 24px;
      }
      p {
        margin: 0 0 18px;
        color: rgba(255,255,255,0.78);
        line-height: 1.45;
      }
      .btn {
        display: inline-block;
        padding: 14px 18px;
        border-radius: 14px;
        background: #00e5ff;
        color: #0d111b;
        text-decoration: none;
        font-weight: 800;
      }
      .links {
        margin-top: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .small {
        color: rgba(255,255,255,0.64);
        font-size: 13px;
        text-decoration: none;
      }
      .hidden {
        display: none;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Abriendo NightVibe…</h1>
      <p>Si no tienes la app instalada, te enviaremos a la tienda para descargarla. Si ya la tienes, también puedes intentar abrirla manualmente.</p>
      <a id="primaryStore" class="btn" href="${safeFallbackStoreUrl}">Descargar la app</a>
      <div class="links">
        <a id="openApp" class="small" href="${safeAppUrl}">Intentar abrir la app</a>
        <a id="iosStore" class="small hidden" href="${safeIosStoreUrl}">Abrir App Store</a>
        <a id="androidStore" class="small hidden" href="${safeAndroidStoreUrl}">Abrir Google Play</a>
        <a id="fallbackStore" class="small hidden" href="${safeFallbackStoreUrl}">Abrir tienda</a>
      </div>
    </div>
    <script>
      (function () {
        var ua = navigator.userAgent || '';
        var isIOS = /iPhone|iPad|iPod/i.test(ua);
        var isAndroid = /Android/i.test(ua);
        var iosStoreUrl = ${JSON.stringify(String(iosStoreUrl || ''))};
        var androidStoreUrl = ${JSON.stringify(String(androidStoreUrl || ''))};
        var fallbackStoreUrl = ${JSON.stringify(String(fallbackStoreUrl || ''))};
        var targetStoreUrl = isIOS ? iosStoreUrl : (isAndroid ? androidStoreUrl : fallbackStoreUrl);

        var primaryStore = document.getElementById('primaryStore');
        var iosLink = document.getElementById('iosStore');
        var androidLink = document.getElementById('androidStore');
        var fallbackLink = document.getElementById('fallbackStore');

        if (primaryStore && targetStoreUrl) {
          primaryStore.href = targetStoreUrl;
          primaryStore.textContent = isIOS
            ? 'Descargar en App Store'
            : isAndroid
            ? 'Descargar en Google Play'
            : 'Descargar la app';
        }

        if (isIOS && iosLink) iosLink.classList.remove('hidden');
        if (isAndroid && androidLink) androidLink.classList.remove('hidden');
        if (!isIOS && !isAndroid && fallbackLink) fallbackLink.classList.remove('hidden');
      })();
    </script>
  </body>
</html>`;
}

// GET /api/share/r/:refCode
// Registra click (+ unique aproximado) y muestra landing con intento de abrir app / tienda
router.get('/r/:refCode', async (req, res) => {
  try {
    const refCode = typeof req.params.refCode === 'string' ? req.params.refCode.trim().slice(0, 64) : '';
    if (!refCode) return res.status(400).send('Bad ref');

    const link = await ShareLink.findOne({ refCode });
    if (!link) return res.status(404).send('Not found');

    // Total clicks
    link.clicks = (link.clicks || 0) + 1;
    link.lastClickedAt = new Date();

    // Unique clicks (approx): hash(ip + ua) with daily salt window (today)
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';
    const day = new Date().toISOString().slice(0, 10);
    const uniqueKey = sha256(`${day}|${ip}|${ua}`);

    // cookie-based unique (24h)
    const cookieName = `nv_uc_${refCode}`;
    const hasCookie = typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`${cookieName}=`);

    if (!hasCookie) {
      link.uniqueClicks = (link.uniqueClicks || 0) + 1;
      res.cookie(cookieName, uniqueKey, {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
    }

    await link.save();

    const appUrl = buildAppEventUrl({
      eventId: String(link.eventId),
      refCode: link.refCode,
      channel: link.channel ? String(link.channel) : null,
    });
    const iosStoreUrl = pickIosStoreUrl();
    const androidStoreUrl = pickAndroidStoreUrl();
    const fallbackStoreUrl = isIosUserAgent(ua)
      ? iosStoreUrl
      : isAndroidUserAgent(ua)
      ? androidStoreUrl
      : iosStoreUrl || androidStoreUrl;

    const html = buildShareRedirectHtml({
      appUrl,
      iosStoreUrl,
      androidStoreUrl,
      fallbackStoreUrl,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (e) {
    console.error('[share/r]', e);
    return res.status(500).send('server_error');
  }
});

// POST /api/share/create
// body: { eventId, channel? }
router.post('/create', anyAuth, ensureUserId, async (req, res) => {
  try {
    const { eventId, channel } = req.body || {};
    if (!eventId) return res.status(400).json({ ok: false, error: 'eventId required' });

    const event = await Event.findById(eventId).lean();
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });

    const clubId = String(event.clubId || event.createdBy || event.userId || '');

    const createdByUserId = pickCreatedByUserId(req);
    if (!createdByUserId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    let link = await ShareLink.findOne({
      eventId: String(eventId),
      createdByUserId,
      channel: channel ? String(channel) : null,
    });

    if (!link) {
      let refCode = genRefCode();
      while (await ShareLink.findOne({ refCode })) refCode = genRefCode();

      link = await ShareLink.create({
        refCode,
        eventId: String(eventId),
        clubId,
        createdByUserId,
        channel: channel ? String(channel) : null,
      });
    }

    const shareBase = pickShareBase(req);

    // Public tracking URL to share with others
    const shareUrl = joinUrl(shareBase, `/r/${encodeURIComponent(link.refCode)}`);

    // App deep-link for internal use / debugging
    const appUrl = buildAppEventUrl({
      eventId: String(eventId),
      refCode: link.refCode,
      channel: link.channel ? String(channel) : null,
    });

    return res.json({ ok: true, refCode: link.refCode, shareUrl, appUrl });
  } catch (e) {
    console.error('[share/create]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
