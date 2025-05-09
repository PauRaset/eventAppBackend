const express = require("express");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const User = require("../models/User");
const multer = require("../uploads/multerConfig");
const router = express.Router();

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

const authorizeRole = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Acceso denegado" });
  }
  next();
};

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

const uploadProfilePicture = async (file) => {
  const formData = new FormData();
  formData.append("profilePicture", file);

  const response = await fetch("/api/auth/uploadProfilePicture", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("token")}`, 
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

router.put("/update", authenticateToken, async (req, res) => {
  try {
    const { username, email, entityName } = req.body;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

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
