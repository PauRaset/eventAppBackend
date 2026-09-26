const User = require("../models/User");
const jwt = require("jsonwebtoken");
const admin = require("../middlewares/firebaseAdmin"); // asegura inicialización

// =============== LOGIN CON FACEBOOK (lo que ya tenías) ===============
exports.loginWithFacebook = async (req, res) => {
  try {
    const { id, name, email, picture } = req.user; // viene de passport

    let user = await User.findOne({ facebookId: id });
    if (!user) {
      user = new User({
        facebookId: id,
        username: name || "user",
        email,
        profilePicture: picture?.data?.url || "",
        role: "spectator",
      });
      await user.save();
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    // redirige a tu frontend con el token
    res.redirect(`https://event-app-prod.vercel.app/?token=${token}`);
  } catch (error) {
    console.error("Error en login con Facebook:", error);
    res.status(500).json({ message: "Error en autenticación con Facebook" });
  }
};

// =============== PERFIL DEL USUARIO AUTENTICADO ===============
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });
    res.json(user);
  } catch (error) {
    console.error("Error al obtener el perfil:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
};

// =============== ACTUALIZAR USUARIO ===============
exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, username, bio, profilePicture } = req.body;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    user.username = username || user.username;
    user.name = name || user.name;
    user.bio = bio || user.bio;
    user.profilePicture = profilePicture || user.profilePicture;

    const updatedUser = await user.save();
    res.json(updatedUser);
  } catch (error) {
    console.error("Error actualizando usuario:", error);
    res.status(500).json({ message: "Error del servidor" });
  }
};

// =============== INTERCAMBIO: Firebase ID Token -> JWT propio ===============
exports.firebaseLogin = async (req, res) => {
  try {
    // ID token puede venir en body o en Authorization: Bearer <idToken>
    const authHeader = req.headers.authorization || "";
    const headerToken =
      authHeader.startsWith("Bearer ") || authHeader.startsWith("Firebase ")
        ? authHeader.split(" ")[1]
        : null;

    const idToken = req.body?.idToken || headerToken;
    if (!idToken) return res.status(400).json({ message: "Falta idToken" });

    const decoded = await admin.auth().verifyIdToken(idToken);

    const user = await User.findOrCreateFromFirebase({
      uid: decoded.uid,
      phoneNumber: decoded.phone_number || decoded.phoneNumber || null,
      displayName: decoded.name || "",
      photoURL: decoded.picture || "",
    });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        profilePicture: user.profilePicture || "",
      },
    });
  } catch (err) {
    console.error("[firebaseLogin] error:", err?.message || err);
    res.status(401).json({ message: "Token de Firebase no válido" });
  }
};