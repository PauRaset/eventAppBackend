const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  entityName: { type: String }, // No requerido para usuarios de Facebook
  password: { type: String }, // No requerido para usuarios de Facebook
  profilePicture: { type: String, default: "" },
  role: { type: String, enum: ["club", "spectator"], default: "club" },
  facebookId: { type: String, unique: true, sparse: true },
  instagramId: { type: String, unique: true, sparse: true },
});

// Middleware para encriptar la contraseña antes de guardar
userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Método para comparar contraseñas
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model("User", userSchema);

module.exports = User;

/*const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  entityName: { type: String, required: true },
  password: { type: String, required: true },
  profilePicture: { type: String, default: "" }, // Nueva propiedad para foto de perfil
  role: { type: String, enum: ["club", "spectator"], default: "club" }, // Campo para diferenciar roles
  facebookId: { type: String, unique: true, sparse: true }, // ID de Facebook para login
  instagramId: { type: String, unique: true, sparse: true }, // ID de Instagram para login
});

// Middleware para encriptar la contraseña antes de guardar
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Método para comparar contraseñas
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model("User", userSchema);

module.exports = User;*/
