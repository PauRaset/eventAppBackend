const jwt = require("jsonwebtoken");

// Middleware para verificar el token
const authenticateToken = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "No autorizado" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Decodifica y agrega el usuario al objeto `req`
    next(); // Continua con la siguiente función del middleware
  } catch (error) {
    console.error("Token no válido:", error);
    return res.status(403).json({ message: "Token no válido" });
  }
};

module.exports = authenticateToken;
