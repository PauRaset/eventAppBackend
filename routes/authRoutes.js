const express = require("express");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const User = require("../models/User");
const multer = require("../uploads/multerConfig");
const router = express.Router();

// Middleware para verificar token de autenticación
const authenticateToken = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "No autorizado" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: "Token no válido" });
  }
};

// Middleware para verificar roles
const authorizeRole = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Acceso denegado" });
  }
  next();
};

// 🔹 Registro manual de usuarios (para "clubs")
router.post("/register", async (req, res) => {
  const { username, email, entityName, password } = req.body;
  try {
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "El correo ya está registrado" });
    }

    const user = new User({
      username,
      email,
      entityName,
      password,
      role: "club",
    });

    await user.save();
    res.status(201).json({ message: "Usuario registrado correctamente" });
  } catch (error) {
    console.error("Error en el registro:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

// 🔹 Inicio de sesión manual (para "clubs")
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const isPasswordCorrect = await user.matchPassword(password);
    if (!isPasswordCorrect) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
    );

    res.status(200).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        entityName: user.entityName,
        profilePicture: user.profilePicture,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Error en el login:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

// 🔹 Autenticación con Facebook (solo para "spectators")
router.get(
  "/facebook",
  passport.authenticate("facebook", { scope: ["email", "public_profile"] }),
);

router.get(
  "/facebook/callback",
  passport.authenticate("facebook", {
    session: false,
    failureRedirect: "https://event-app-prod.vercel.app/login",
  }),
  async (req, res) => {
    try {
      const token = jwt.sign(
        { id: req.user._id, role: req.user.role },
        process.env.JWT_SECRET,
        { expiresIn: "1d" },
      );

      res.redirect(`https://event-app-prod.vercel.app/login?token=${token}`);
    } catch (error) {
      console.error("Error en la autenticación con Facebook:", error);
      res.status(500).json({ message: "Error en el servidor" });
    }
  },
);

// 🔹 Obtener el perfil del usuario autenticado
router.get("/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    res.status(200).json(user);
  } catch (error) {
    console.error("Error al obtener el perfil:", error);
    res.status(500).json({ message: "Error en el servidor." });
  }
});

// 🔹 Subir o actualizar la foto de perfil (solo para usuarios con rol "club")
const uploadProfilePicture = async (file) => {
  const formData = new FormData();
  formData.append("profilePicture", file);

  const response = await fetch("/api/auth/uploadProfilePicture", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("token")}`, // Incluye el token aquí
    },
    body: formData,
  });

  const data = await response.json();
  if (response.ok) {
    console.log("Foto de perfil actualizada:", data.profilePicture);
  } else {
    console.error("Error al subir la imagen:", data.message);
  }
};
router.post(
  "/uploadProfilePicture",
  authenticateToken,
  multer.single("profilePicture"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ message: "Por favor, sube una imagen válida." });
      }

      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado." });
      }

      user.profilePicture = `/uploads/profilePictures/${req.file.filename}`;
      await user.save();

      res.status(200).json({
        message: "Foto de perfil actualizada.",
        profilePicture: user.profilePicture,
      });
    } catch (error) {
      console.error("Error al actualizar la foto de perfil:", error);
      res.status(500).json({ message: "Error en el servidor." });
    }
  },
);

// 🔹 Actualizar datos del usuario autenticado
router.put("/update", authenticateToken, async (req, res) => {
  try {
    const { username, email, entityName } = req.body;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    // Actualizar los campos permitidos
    if (username) user.username = username;
    if (email) user.email = email;
    if (entityName) user.entityName = entityName;

    await user.save();
    res.status(200).json({ message: "Perfil actualizado correctamente", user });
  } catch (error) {
    console.error("Error al actualizar usuario:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

// 🔹 Ruta protegida de ejemplo (solo accesible por "clubs")
router.get(
  "/protected",
  authenticateToken,
  authorizeRole(["club"]),
  (req, res) => {
    res
      .status(200)
      .json({ message: "Acceso permitido a ruta protegida para clubs" });
  },
);

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

/*const express = require("express");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const User = require("../models/User");
const multer = require("../uploads/multerConfig");
const router = express.Router();

// Middleware para verificar token de autenticación
const authenticateToken = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "No autorizado" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: "Token no válido" });
  }
};

// Middleware para verificar roles
const authorizeRole = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Acceso denegado" });
  }
  next();
};

// 🔹 Registro manual de usuarios (para "clubs")
router.post("/register", async (req, res) => {
  const { username, email, entityName, password } = req.body;
  try {
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "El correo ya está registrado" });
    }

    const user = new User({
      username,
      email,
      entityName,
      password,
      role: "club",
    });

    await user.save();
    res.status(201).json({ message: "Usuario registrado correctamente" });
  } catch (error) {
    console.error("Error en el registro:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

// 🔹 Inicio de sesión manual (para "clubs")
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const isPasswordCorrect = await user.matchPassword(password);
    if (!isPasswordCorrect) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
    );

    res.status(200).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        entityName: user.entityName,
        profilePicture: user.profilePicture,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Error en el login:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

// 🔹 Autenticación con Facebook (solo para "spectators")
router.get(
  "/facebook",
  passport.authenticate("facebook", { scope: ["email", "public_profile"] }),
);

router.get(
  "/facebook/callback",
  passport.authenticate("facebook", {
    session: false,
    failureRedirect: "https://event-app-prod.vercel.app/login",
  }),
  async (req, res) => {
    try {
      const token = jwt.sign(
        { id: req.user._id, role: req.user.role },
        process.env.JWT_SECRET,
        { expiresIn: "1d" },
      );

      res.redirect(`https://event-app-prod.vercel.app/login?token=${token}`);
    } catch (error) {
      console.error("Error en la autenticación con Facebook:", error);
      res.status(500).json({ message: "Error en el servidor" });
    }
  },
);

// 🔹 Obtener el perfil del usuario autenticado
router.get("/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    res.status(200).json(user);
  } catch (error) {
    console.error("Error al obtener el perfil:", error);
    res.status(500).json({ message: "Error en el servidor." });
  }
});

// 🔹 Subir o actualizar la foto de perfil
router.post(
  "/uploadProfilePicture",
  authenticateToken,
  multer.single("profilePicture"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ message: "Por favor, sube una imagen válida." });
      }

      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado." });
      }

      user.profilePicture = `/uploads/profilePictures/${req.file.filename}`;
      await user.save();

      res.status(200).json({
        message: "Foto de perfil actualizada.",
        profilePicture: user.profilePicture,
      });
    } catch (error) {
      console.error("Error al actualizar la foto de perfil:", error);
      res.status(500).json({ message: "Error en el servidor." });
    }
  },
);

// 🔹 Ruta protegida de ejemplo (solo accesible por "clubs")
router.get(
  "/protected",
  authenticateToken,
  authorizeRole(["club"]),
  (req, res) => {
    res
      .status(200)
      .json({ message: "Acceso permitido a ruta protegida para clubs" });
  },
);

module.exports = router;*/
