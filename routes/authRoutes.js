// routes/authRoutes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const router = express.Router();

const User = require("../models/User");
const Event = require("../models/Event"); // <- para /me/attending
const multer = require("../uploads/multerConfig"); // si lo usas así
const authController = require("../controllers/authController");
const {
  authenticateToken,
  anyAuth,
  ensureUserId,
  verifyFirebaseIdToken,
} = require("../middlewares/authMiddleware");

const mongoose = require("mongoose");
const { Types: { ObjectId } } = mongoose;

function isValidObjectId(v) {
  return typeof v === "string" && ObjectId.isValid(v) && (new ObjectId(v)).toString() === v;
}

async function resolveUserFromRequest(req) {
  // 1) JWT legacy con ObjectId válido
  if (req.user && req.user.id && isValidObjectId(req.user.id)) {
    const u = await User.findById(req.user.id);
    if (u) return u;
  }
  // 2) Firebase: por firebaseUid o por teléfono
  const fu = req.firebaseUser;
  if (fu && fu.uid) {
    let u = await User.findOne({ firebaseUid: fu.uid });
    if (u) return u;
    if (fu.phone_number) {
      u = await User.findOne({ phoneNumber: fu.phone_number });
      if (u) return u;
    }
  }
  // 3) JWT con id no-ObjectId: probar como firebaseUid
  if (req.user && req.user.id && !isValidObjectId(req.user.id)) {
    const u = await User.findOne({ firebaseUid: req.user.id });
    if (u) return u;
  }
  return null;
}

/* ===================== Helpers ===================== */
const cleanEmail = (e) => (e || "").toLowerCase().trim();

function issueSessionToken(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );
}

/* ================= Middlewares base ================= */
const authorizeRole = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Acceso denegado" });
  }
  next();
};

/* ====================== RUTAS ======================= */

/* -------- Registro manual (clubs) -------- */
router.post("/register", async (req, res) => {
  try {
    const { username, email, entityName, password } = req.body;
    const normEmail = cleanEmail(email);

    const userExists = await User.findOne({ email: normEmail });
    if (userExists)
      return res.status(400).json({ message: "El correo ya está registrado" });

    const user = new User({
      username: (username || normEmail.split("@")[0]).trim(),
      email: normEmail,
      entName: entityName,
      entityName, // por si quieres ya sincronizado
      password,   // hook del modelo lo hashea
      role: "club",
    });

    await user.save();

    res.status(201).json({ message: "Usuario registrado correctamente" });
  } catch (error) {
    console.error("Error en el registro:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

/* -------- Login manual (clubs) -------- */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: cleanEmail(email) });
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    const isPasswordCorrect = await user.matchPassword(password);
    if (!isPasswordCorrect)
      return res.status(401).json({ message: "Credenciales inválidas" });

    const token = issueSessionToken(user);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        entityName: user.entityName || user.entName,
        profilePicture: user.profilePicture,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Error en el login:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

/* -------- Forgot / Reset password (JWT temporal por email) -------- */
/**
 * POST /api/auth/forgot
 * Envía un enlace de reseteo (también sirve para “primera contraseña”).
 * Crea un JWT corto con { id, kind:'pwdreset' } y 1h de validez.
 */
router.post("/forgot", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const user = await User.findOne({ email });
    // Para no filtrar si existe o no:
    if (!user) return res.json({ ok: true });

    const token = jwt.sign(
      { id: user._id.toString(), kind: "pwdreset" },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const frontend = (process.env.FRONTEND_URL || "https://clubs.nightvibe.life").replace(/\/+$/,'');
    const link = `${frontend}/login/reset?token=${encodeURIComponent(token)}`;

    await sendSimpleEmail({
      to: email,
      subject: "Restablecer contraseña – NightVibe Clubs",
      html: `
        <p>Hola ${user.username || ""},</p>
        <p>Para establecer o restablecer tu contraseña, haz clic en el siguiente enlace:</p>
        <p><a href="${link}">Establecer contraseña</a></p>
        <p>El enlace caduca en 1 hora. Si tú no lo solicitaste, ignora este mensaje.</p>
      `,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("forgot error:", e);
    res.status(500).json({ ok: false, message: "No se pudo enviar el correo" });
  }
});

/**
 * POST /api/auth/reset
 * Body: { token, password }
 * Verifica el JWT y fija la nueva contraseña.
 */
router.post("/reset", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ message: "Faltan datos" });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ message: "Token inválido o expirado" });
    }

    if (payload.kind !== "pwdreset" || !payload.id) {
      return res.status(400).json({ message: "Token inválido" });
    }

    const user = await User.findById(payload.id);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    // Usa helper del modelo para hashear
    await user.setPassword(password);
    await user.save();

    return res.json({ ok: true, message: "Contraseña actualizada" });
  } catch (e) {
    console.error("reset error:", e);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

/* -------- Intercambio Firebase -> JWT propio -------- */
// Permite a la app intercambiar un Firebase ID token por tu JWT legacy
// Headers: Authorization: Bearer <FirebaseIdToken>

router.post(
  "/exchangeFirebase",
  anyAuth,       // acepta JWT propio o Firebase ID token
  ensureUserId,  // garantiza req.user.id (si viene Firebase, usa uid)
  async (req, res) => {
    try {
      let user = await resolveUserFromRequest(req);

      // Si no existe y venimos con Firebase, crea espectador mínimo
      if (!user && req.firebaseUser && req.firebaseUser.uid) {
        const phone = req.firebaseUser.phone_number || "";
        const username = phone ? `user_${phone.replace(/\D/g, '').slice(-6)}` : `user_${Date.now()}`;
        user = await User.create({
          username,
          phoneNumber: phone,
          firebaseUid: req.firebaseUser.uid,
          role: "spectator",
        });
      }

      if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

      const token = issueSessionToken(user);
      return res.json({ token });
    } catch (e) {
      console.error("[POST /api/auth/exchangeFirebase]", e);
      return res.status(500).json({ message: "Error en el servidor" });
    }
  }
);

/**
 * POST /api/auth/ensure
 * Asegura que el usuario autenticado existe en la BD y actualiza
 * los datos básicos enviados desde el cliente móvil tras el login
 * por teléfono (username, displayName, instagram, bio, etc.).
 *
 * Acepta tanto tu JWT propio como un Firebase ID token (anyAuth).
 */
router.post("/ensure", anyAuth, ensureUserId, async (req, res) => {
  try {
    const {
      username,
      displayName,
      instagram,
      bio,
    } = req.body || {};

    // Intentamos resolver el usuario actual (por JWT legacy o Firebase)
    let user = await resolveUserFromRequest(req);

    // Si no existe aún pero venimos con Firebase, lo creamos básico
    if (!user && req.firebaseUser && req.firebaseUser.uid) {
      const phone = req.firebaseUser.phone_number || "";
      const fallbackUsername = phone
        ? `user_${phone.replace(/\D/g, "").slice(-6)}`
        : `user_${Date.now()}`;

      user = await User.create({
        username: fallbackUsername,
        phoneNumber: phone,
        firebaseUid: req.firebaseUser.uid,
        role: "spectator",
      });
    }

    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    // Si viene username, lo normalizamos y comprobamos que no esté usado por otro usuario
    if (typeof username === "string" && username.trim()) {
      const normUsername = username.trim();
      const existing = await User.findOne({
        username: normUsername,
        _id: { $ne: user._id },
      });
      if (existing) {
        return res
          .status(400)
          .json({ message: "Ese nombre de usuario ya está en uso" });
      }
      user.username = normUsername;
    }

    // displayName -> lo usamos como entityName / entName en spectators
    if (typeof displayName === "string" && displayName.trim()) {
      const val = displayName.trim();
      user.entityName = val;
      user.entName = val;
    }

    // Instagram: normalizar igual que en /update
    if (typeof instagram === "string") {
      let val = instagram.trim();
      if (val.startsWith("@")) val = `https://instagram.com/${val.slice(1)}`;
      if (val && !/^https?:\/\//i.test(val)) val = `https://${val}`;
      user.instagram = val;
    }

    // Bio opcional
    if (typeof bio === "string") {
      user.bio = bio;
    }

    // Aseguramos que los spectators creados aquí tienen el rol correcto
    if (!user.role) {
      user.role = "spectator";
    }

    await user.save();

    return res.json({
      message: "Usuario sincronizado correctamente",
      user,
    });
  } catch (err) {
    console.error("[POST /api/auth/ensure] error:", err);
    return res.status(500).json({ message: "Error en el servidor" });
  }
});

router.post("/firebase", authController.firebaseLogin);

/* -------- Facebook (spectators) mediante Passport -------- */
router.get(
  "/facebook",
  passport.authenticate("facebook", { scope: ["email", "public_profile"] })
);

router.get(
  "/facebook/callback",
  passport.authenticate("facebook", {
    session: false,
    failureRedirect: "https://event-app-prod.vercel.app/login",
  }),
  authController.loginWithFacebook
);

/* -------- Perfil del usuario autenticado -------- */
router.get("/profile", authenticateToken, authController.getProfile);

/* -------- Subir/actualizar foto de perfil -------- */
router.post(
  "/uploadProfilePicture",
  anyAuth,
  ensureUserId,
  multer.single("profilePicture"),
  async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ message: "Por favor, sube una imagen válida." });

      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(404).json({ message: "Usuario no encontrado." });

      user.profilePicture = `/uploads/profilePictures/${req.file.filename}`;
      await user.save();

      res.json({
        message: "Foto de perfil actualizada.",
        profilePicture: user.profilePicture,
      });
    } catch (error) {
      console.error("Error al actualizar la foto de perfil:", error);
      res.status(500).json({ message: "Error en el servidor." });
    }
  }
);

/* -------- Actualizar datos del usuario autenticado -------- */
router.put("/update", anyAuth, ensureUserId, async (req, res) => {
  try {
    const {
      username,
      email,
      entityName,
      profilePicture,
      instagram,
      bio,
      isPrivate,
    } = req.body || {};

    const user = await resolveUserFromRequest(req);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    // Campos legacy (clubs)
    if (typeof username === 'string' && username.trim()) user.username = username.trim();
    if (typeof email === 'string' && email.trim()) user.email = cleanEmail(email);
    if (typeof entityName === 'string' && entityName.trim()) {
      user.entName = entityName.trim();
      user.entityName = entityName.trim();
    }

    // Quitar foto de perfil si viene cadena vacía
    if (typeof profilePicture === 'string' && profilePicture.trim() === '') {
      user.profilePicture = '';
    }

    // Instagram: normalizar a URL https; permitir "@usuario"
    if (typeof instagram === 'string') {
      let val = instagram.trim();
      if (val.startsWith('@')) val = `https://instagram.com/${val.slice(1)}`;
      if (val && !/^https?:\/\//i.test(val)) val = `https://${val}`;
      user.instagram = val;
    }

    // Bio: texto libre controlado por cliente
    if (typeof bio === 'string') {
      user.bio = bio;
    }

    // isPrivate: booleano
    if (typeof isPrivate !== 'undefined') {
      user.isPrivate = Boolean(isPrivate);
    }

    await user.save();
    res.json({ message: "Perfil actualizado correctamente", user });
  } catch (error) {
    console.error("Error al actualizar usuario:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

/* -------- Ruta protegida de ejemplo (solo clubs) -------- */
router.get("/protected", authenticateToken, authorizeRole(["club"]), (req, res) => {
  res.json({ message: "Acceso permitido a ruta protegida para clubs" });
});

/* -------- Mis eventos donde asisto (acepta Firebase o tu JWT) -------- */
router.get("/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) return res.status(404).json({ message: "Usuario no encontrado" });
    const events = await Event.find({ attendees: me._id })
      .sort({ date: 1 })
      .populate("createdBy", "username email profilePicture")
      .lean();

    const formatted = events.map((ev) => ({
      ...ev,
      categories: Array.isArray(ev.categories)
        ? ev.categories
        : typeof ev.categories === "string"
        ? (() => {
            try {
              return JSON.parse(ev.categories);
            } catch {
              return [];
            }
          })()
        : [],
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[GET /me/attending] error:", err);
    res.status(500).json({ message: "Error al obtener tus eventos" });
  }
});

/* -------- Alias: Mis eventos donde asisto (para cliente móvil) -------- */
router.get("/users/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) return res.status(404).json({ message: "Usuario no encontrado" });
    const events = await Event.find({ attendees: me._id })
      .sort({ date: 1 })
      .populate("createdBy", "username email profilePicture")
      .lean();

    const formatted = events.map((ev) => ({
      ...ev,
      categories: Array.isArray(ev.categories)
        ? ev.categories
        : typeof ev.categories === "string"
        ? (() => {
            try {
              return JSON.parse(ev.categories);
            } catch {
              return [];
            }
          })()
        : [],
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[GET /users/me/attending] error:", err);
    res.status(500).json({ message: "Error al obtener tus eventos" });
  }
});


/* -------- Perfil completo del usuario autenticado (incluye following) -------- */
/*router.get("/me", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) {
      return res.status(404).json({ ok: false, message: "Usuario no encontrado" });
    }

    // Aseguramos que followers/following siempre sean arrays
    const followers = Array.isArray(me.followers) ? me.followers : [];
    const following = Array.isArray(me.following) ? me.following : [];

    return res.json({
      ok: true,
      user: {
        _id: me._id,
        id: me._id, // para compatibilidad con Flutter
        role: me.role,
        username: me.username,
        email: me.email,
        entName: me.entName,
        entityName: me.entityName,
        phoneNumber: me.phoneNumber,
        firebaseUid: me.firebaseUid,
        profilePicture: me.profilePicture,
        instagram: me.instagram,
        bio: me.bio,
        isPrivate: me.isPrivate,
        followers,
        following,
        followersCount: followers.length,
        followingCount: following.length,
        createdAt: me.createdAt,
        updatedAt: me.updatedAt,
      },
    });
  } catch (err) {
    console.error("[GET /api/auth/me] error:", err);
    return res.status(500).json({ ok: false, message: "Error en el servidor" });
  }
});*/

/* -------- Perfil completo del usuario autenticado (incluye following) -------- */
router.get("/me", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) {
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });
    }

    // Recargamos desde BD para asegurarnos de tener followers/following actualizados
    const meFull = await User.findById(me._id).lean();
    if (!meFull) {
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });
    }

    const followers = Array.isArray(meFull.followers) ? meFull.followers : [];
    const rawFollowing = Array.isArray(meFull.following)
      ? meFull.following
      : [];

    // Normalizamos a strings
    const followingIds = rawFollowing.map((v) => v.toString());

    console.log(
      "[GET /api/auth/me] followingIds:",
      followingIds,
      "followers:",
      followers
    );

    return res.json({
      ok: true,
      user: {
        _id: meFull._id,
        id: meFull._id.toString(), // para Flutter
        role: meFull.role,
        username: meFull.username,
        email: meFull.email,
        entName: meFull.entName,
        entityName: meFull.entityName,
        phoneNumber: meFull.phoneNumber,
        firebaseUid: meFull.firebaseUid,
        profilePicture: meFull.profilePicture,
        instagram: meFull.instagram,
        bio: meFull.bio,
        isPrivate: meFull.isPrivate,
        followers,
        following: followingIds, // <- IMPORTANTE
        followingIds,
        followersCount: followers.length,
        followingCount: followingIds.length,
        createdAt: meFull.createdAt,
        updatedAt: meFull.updatedAt,
      },
    });
  } catch (err) {
    console.error("[GET /api/auth/me] error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Error en el servidor" });
  }
});

/* -------- Solo IDs de la gente a la que sigo (para cliente móvil) -------- */
router.get("/users/me/following-ids", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) {
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });
    }

    const meFull = await User.findById(me._id).lean();
    if (!meFull) {
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });
    }

    const rawFollowing = Array.isArray(meFull.following)
      ? meFull.following
      : [];

    const followingIds = rawFollowing.map((v) => v.toString());

    console.log(
      "[GET /api/auth/users/me/following-ids] followingIds:",
      followingIds
    );

    return res.json({
      ok: true,
      followingIds,
      count: followingIds.length,
    });
  } catch (err) {
    console.error(
      "[GET /api/auth/users/me/following-ids] error:",
      err
    );
    return res
      .status(500)
      .json({ ok: false, message: "Error en el servidor" });
  }
});

/* -------- Perfil completo del usuario autenticado (incluye following) -------- */
/*router.get("/me", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) {
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });
    }

    // Recargamos desde BD para asegurarnos de tener followers/following actualizados
    const meFull = await User.findById(me._id).lean();
    if (!meFull) {
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });
    }

    const followers = Array.isArray(meFull.followers) ? meFull.followers : [];
    const rawFollowing = Array.isArray(meFull.following)
      ? meFull.following
      : [];

    // Normalizamos a strings
    const followingIds = rawFollowing.map((v) => v.toString());

    console.log(
      "[GET /api/auth/me] followingIds:",
      followingIds,
      "followers:",
      followers
    );

    return res.json({
      ok: true,
      user: {
        _id: meFull._id,
        id: meFull._id.toString(), // para Flutter
        role: meFull.role,
        username: meFull.username,
        email: meFull.email,
        entName: meFull.entName,
        entityName: meFull.entityName,
        phoneNumber: meFull.phoneNumber,
        firebaseUid: meFull.firebaseUid,
        profilePicture: meFull.profilePicture,
        instagram: meFull.instagram,
        bio: meFull.bio,
        isPrivate: meFull.isPrivate,
        followers,
        following: followingIds, // <- IMPORTANTE
        followingIds,
        followersCount: followers.length,
        followingCount: followingIds.length,
        createdAt: meFull.createdAt,
        updatedAt: meFull.updatedAt,
      },
    });
  } catch (err) {
    console.error("[GET /api/auth/me] error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Error en el servidor" });
  }
});*/

/* -------- Solo IDs de la gente a la que sigo (para cliente móvil) -------- */
router.get("/users/me/following-ids", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) {
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });
    }

    const meFull = await User.findById(me._id).lean();
    if (!meFull) {
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });
    }

    const rawFollowing = Array.isArray(meFull.following)
      ? meFull.following
      : [];

    const followingIds = rawFollowing.map((v) => v.toString());

    console.log(
      "[GET /api/auth/users/me/following-ids] followingIds:",
      followingIds
    );

    return res.json({
      ok: true,
      followingIds,
      count: followingIds.length,
    });
  } catch (err) {
    console.error(
      "[GET /api/auth/users/me/following-ids] error:",
      err
    );
    return res
      .status(500)
      .json({ ok: false, message: "Error en el servidor" });
  }
});

/* -------- Solo IDs de la gente a la que sigo (para cliente móvil) -------- */
/*router.get("/users/me/following-ids", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) {
      return res.status(404).json({ ok: false, message: "Usuario no encontrado" });
    }

    const following = Array.isArray(me.following) ? me.following : [];
    // Normalizamos a string
    const followingIds = following.map((v) => v.toString());

    return res.json({
      ok: true,
      followingIds,
      count: followingIds.length,
    });
  } catch (err) {
    console.error("[GET /api/auth/users/me/following-ids] error:", err);
    return res.status(500).json({ ok: false, message: "Error en el servidor" });
  }
});*/

/* -------- Solo IDs de la gente a la que sigo (para cliente móvil) -------- */
router.get(
  "/users/me/following-ids",
  anyAuth,
  ensureUserId,
  async (req, res) => {
    try {
      const me = await resolveUserFromRequest(req);
      if (!me) {
        return res
          .status(404)
          .json({ ok: false, message: "Usuario no encontrado" });
      }

      const meFull = await User.findById(me._id).lean();
      if (!meFull) {
        return res
          .status(404)
          .json({ ok: false, message: "Usuario no encontrado" });
      }

      const rawFollowing = Array.isArray(meFull.following)
        ? meFull.following
        : [];

      const followingIds = rawFollowing.map((v) => v.toString());

      console.log(
        "[GET /api/auth/users/me/following-ids] followingIds:",
        followingIds
      );

      return res.json({
        ok: true,
        followingIds,
        count: followingIds.length,
      });
    } catch (err) {
      console.error(
        "[GET /api/auth/users/me/following-ids] error:",
        err
      );
      return res
        .status(500)
        .json({ ok: false, message: "Error en el servidor" });
    }
  }
);

/* ------------------------------------------------------------------
   BUSCAR USUARIOS (público)
   GET /api/auth/users/search?q=...
   ⚠️ IMPORTANTE: esta ruta debe ir ANTES que /:userId
------------------------------------------------------------------- */
const searchUsersHandler = async (req, res) => {
  try {
    const qRaw = (req.query.q || req.query.query || req.query.search || "").toString();
    let q = qRaw.trim();

    // Soporta búsquedas tipo "@usuario"
    if (q.startsWith("@")) q = q.slice(1).trim();

    if (!q) return res.json([]);

    // Escapar regex
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escapeRegExp(q), "i");

    // URL absoluta para /uploads/...
    const absUrlFromUpload = (req, p) => {
      if (!p || typeof p !== "string") return "";
      if (/^https?:\/\//i.test(p)) return p;
      const origin = `${req.protocol}://${req.get("host")}`;
      return p.startsWith("/") ? `${origin}${p}` : `${origin}/${p}`;
    };

    const users = await User.find({
      $or: [
        { username: rx },
        { entityName: rx },
        { entName: rx },
        { instagram: rx },
      ],
    })
      .select("username entityName entName role profilePicture instagram bio isPrivate createdAt")
      .sort({ createdAt: -1 })
      .limit(40)
      .lean();

    const formatted = users.map((u) => ({
      id: u._id?.toString?.() || u._id,
      _id: u._id,
      username: u.username,
      entityName: u.entityName || u.entName || "",
      role: u.role,
      profilePicture: u.profilePicture || "",
      profilePictureUrl: absUrlFromUpload(req, u.profilePicture),
      instagram: u.instagram || "",
      bio: u.bio || "",
      isPrivate: Boolean(u.isPrivate),
    }));

    return res.json(formatted);
  } catch (error) {
    console.error("[GET /api/auth/users/search] error:", error);
    return res.status(500).json({
      message: "Error al buscar usuarios",
      error: error.message || String(error),
    });
  }
};

router.get("/users/search", searchUsersHandler);
// Alias opcional por comodidad
router.get("/searchUsers", searchUsersHandler);

/* -------- Obtener usuario por id (pública) — al final -------- */
router.get("/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user)
      return res.status(404).json({ message: "Usuario no encontrado" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener el usuario" });
  }
});

module.exports = router;
