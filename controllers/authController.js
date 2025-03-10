const User = require("../models/User");
const jwt = require("jsonwebtoken");

exports.loginWithFacebook = async (req, res) => {
  try {
    const { id, name, email, picture } = req.user;

    let user = await User.findOne({ facebookId: id });

    if (!user) {
      user = new User({
        facebookId: id,
        name,
        email,
        profileImage: picture.data.url,
      });
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    res.redirect(`https://event-app-prod.vercel.app/?token=${token}`);
  } catch (error) {
    console.error("Error en login con Facebook:", error);
    res.status(500).json({ message: "Error en autenticación con Facebook" });
  }
};

// Nuevo endpoint para obtener datos del usuario autenticado
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }
    res.json(user);
  } catch (error) {
    console.error("Error al obtener perfil:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
};

/*const User = require("../models/User");
const jwt = require("jsonwebtoken");

exports.loginWithInstagram = async (req, res) => {
  const { instagramId, name, profileImage, email } = req.body;

  let user = await User.findOne({ instagramId });
  if (!user) {
    user = new User({ instagramId, name, profileImage, email });
    await user.save();
  }

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: "1d",
  });

  res.json({ token, user });
};*/
