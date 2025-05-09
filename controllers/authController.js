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

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, username, bio, profilePicture } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    user.name = name || user.name;
    user.username = username || user.username;
    user.bio = bio || user.bio;
    user.profilePicture = profilePicture || user.profilePicture;

    const updatedUser = await user.save();
    res.json(updatedUser);
  } catch (error) {
    console.error("Error actualizando usuario:", error);
    res.status(500).json({ message: "Error del servidor" });
  }
};
