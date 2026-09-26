// routes/registrationRoutes.js
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Club = require('../models/Club');
const ClubApplication = require('../models/ClubApplication');
const sendSimpleEmail = require('../utils/sendSimpleEmail');

let User = null;
try { User = require('../models/User'); } catch { /* opcional */ }

const router = express.Router();

const cleanEmail = (e='') => e.toLowerCase().trim();
const frontendBase = () =>
  (process.env.CLUBS_FRONTEND_URL || process.env.FRONTEND_URL || 'https://clubs.nightvibe.life').replace(/\/+$/, '');

// ✅ Comprobación rápida
router.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * POST /api/registration/apply
 * Crea una solicitud y (si es posible) envía email con enlace de verificación.
 */
router.post('/apply', async (req, res) => {
  try {
    const { email, clubName: clubNameRaw, name, contactName, phone, website, instagram } = req.body || {};
    const clubNameNorm = String(clubNameRaw || name || '').trim();
    if (!email || !clubNameNorm) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    const emailNorm = cleanEmail(email);

    // token de verificación  (válido 48h)
    const verifyToken = crypto.randomBytes(20).toString('base64url');
    const verifyTokenExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    await ClubApplication.findOneAndUpdate(
      { email: emailNorm },
      {
        email: emailNorm,
        clubName: clubNameNorm,
        contactName,
        phone,
        website,
        instagram,
        verifyToken,
        verifyTokenExpiresAt,
        status: 'pending',
      },
      { upsert: true, new: true }
    );

    // link al frontend (página /register/verify)
    const link = `${frontendBase()}/register/verify?token=${verifyToken}`;

    // No bloquees el flujo si el email falla
    try {
      await sendSimpleEmail({
        to: emailNorm,
        subject: 'Verifica tu email – NightVibe Clubs',
        html: `
          <p>Hola ${contactName || ''},</p>
          <p>Para continuar con el registro de <b>${clubNameNorm}</b>, confirma tu correo:</p>
          <p><a href="${link}">Verificar email</a></p>
          <p>Enlace válido durante 48 horas.</p>
        `,
      });
    } catch (err) {
      console.error('sendSimpleEmail error:', err?.message || err);
      // Si quieres informar al frontend, podrías devolver mail:false
    }

    return res.json({ ok: true, mail: true });
  } catch (e) {
    console.error('apply error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * POST /api/registration/verify
 * Marca la solicitud como email_verified si el token es válido.
 */
router.post('/verify', async (req, res) => {
  try {
    const token = (req.body && req.body.token) || (req.query && req.query.token);
    if (!token) return res.status(400).json({ ok: false, error: 'missing_token' });

    const appDoc = await ClubApplication.findOne({ verifyToken: token });
    if (!appDoc) return res.status(404).json({ ok: false, error: 'invalid_token' });
    if (!appDoc.verifyTokenExpiresAt || appDoc.verifyTokenExpiresAt < new Date()) {
      return res.status(400).json({ ok: false, error: 'token_expired' });
    }

    appDoc.status = 'email_verified';
    await appDoc.save();

    res.json({ ok: true });
  } catch (e) {
    console.error('verify error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * GET /api/registration/applications (ADMIN)
 */
router.get('/applications', async (req, res) => {
  try {
    // TODO: proteger con tu middleware admin
    const { status } = req.query;
    const filter = status ? { status } : {};
    const list = await ClubApplication.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, items: list });
  } catch (e) {
    console.error('list apps', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * POST /api/registration/applications/:id/approve (ADMIN)
 * Crea el Club + genera scannerApiKey y envía link para crear contraseña.
 */
router.post('/applications/:id/approve', async (req, res) => {
  try {
    // TODO: proteger con tu middleware admin
    const { id } = req.params;
    const appDoc = await ClubApplication.findById(id);
    if (!appDoc) return res.status(404).json({ ok: false, error: 'not_found' });

    // generar slug básico
    const base =
      (appDoc.clubName || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'club';
    const slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;

    // scanner key por club
    const scannerApiKey = crypto.randomBytes(24).toString('base64url');

    const club = await Club.create({
      name: appDoc.clubName,
      slug,
      ownerUserId: appDoc.email, // podrás actualizarlo a UID real si usas Firebase
      managers: [],
      stripeAccountId: null,
      scannerApiKey,
      status: 'active',
    });

    // Cambiamos estado + generamos token para set-password (48h)
    appDoc.status = 'approved';
    appDoc.approvedAt = new Date();
    appDoc.passwordToken = crypto.randomBytes(24).toString('base64url');
    appDoc.passwordTokenExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await appDoc.save();

    const panelUrl = frontendBase();
    const setPasswordLink = `${panelUrl}/register/set-password?token=${appDoc.passwordToken}`;

    // Email de bienvenida ÚNICO
    try {
      await sendSimpleEmail({
        to: appDoc.email,
        subject: 'Tu cuenta de organizador ha sido aprobada 🎉',
        html: `
          <p>¡Enhorabuena!</p>
          <p>Tu panel: <a href="${panelUrl}">${panelUrl}</a></p>
          <p>Clave del escáner (guárdala): <code>${scannerApiKey}</code></p>
          <p><b>Último paso:</b> crea tu contraseña aquí:<br>
            <a href="${setPasswordLink}">${setPasswordLink}</a>
          </p>
          <p>Luego podrás iniciar sesión y conectar Stripe desde el dashboard para cobrar.</p>
        `,
      });
    } catch (err) {
      console.error('sendSimpleEmail (approve) error:', err?.message || err);
      // No cortamos: el club ya está creado
    }

    res.json({ ok: true, club });
  } catch (e) {
    console.error('approve error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * POST /api/registration/applications/:id/reject (ADMIN)
 */
router.post('/applications/:id/reject', async (req, res) => {
  try {
    // TODO: proteger con tu middleware admin
    const { id } = req.params;
    const { reason = '' } = req.body || {};
    const appDoc = await ClubApplication.findById(id);
    if (!appDoc) return res.status(404).json({ ok: false, error: 'not_found' });

    appDoc.status = 'rejected';
    appDoc.notes = reason;
    await appDoc.save();

    try {
      await sendSimpleEmail({
        to: appDoc.email,
        subject: 'Solicitud rechazada',
        html: `<p>Lo sentimos, tu solicitud ha sido rechazada.</p><p>${reason}</p>`,
      });
    } catch (err) {
      console.error('sendSimpleEmail (reject) error:', err?.message || err);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('reject error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * POST /api/registration/set-password
 * Body: { token, password, name? }
 * Crea/actualiza el usuario (role: "club") y consume el token.
 */
router.post('/set-password', async (req, res) => {
  try {
    const { token, password, name } = req.body || {};
    if (!token || !password) return res.status(400).json({ ok:false, error:'missing_fields' });

    const appDoc = await ClubApplication.findOne({ passwordToken: token });
    if (!appDoc) return res.status(404).json({ ok:false, error:'invalid_token' });
    if (!appDoc.passwordTokenExpiresAt || appDoc.passwordTokenExpiresAt < new Date())
      return res.status(400).json({ ok:false, error:'token_expired' });
    if (!User) return res.status(500).json({ ok:false, error:'user_model_missing' });

    // Buscar o crear
    const emailNorm = cleanEmail(appDoc.email);
    let user = await User.findOne({ email: emailNorm });

    if (!user) {
      user = new User({
        email: emailNorm,
        username: (name || appDoc.contactName || appDoc.clubName || emailNorm.split('@')[0] || 'user').trim(),
        role: 'club',
        entName: appDoc.clubName || '',
        entityName: appDoc.clubName || '',
      });
    } else {
      // Actualiza nombre si llega y el actual es demasiado genérico
      if (name && (!user.username || user.username.startsWith('user_'))) {
        user.username = name.trim();
      }
      if (!user.entityName && appDoc.clubName) user.entityName = appDoc.clubName;
      if (!user.entName && appDoc.clubName) user.entName = appDoc.clubName;
      user.role = 'club';
    }

    // Fijar contraseña usando helper del modelo si existe
    if (typeof user.setPassword === 'function') {
      await user.setPassword(password);
    } else {
      const hash = await bcrypt.hash(password, 10);
      user.password = hash; // el toJSON ya oculta password
    }

    await user.save();

    // Consumir token
    appDoc.passwordToken = null;
    appDoc.passwordTokenExpiresAt = null;
    await appDoc.save();

    res.json({ ok:true, userId: user._id });
  } catch (e) {
    console.error('set-password error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
