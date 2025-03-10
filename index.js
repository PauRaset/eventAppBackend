const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session"); // Para manejar sesiones
const passport = require("passport"); // Passport.js para autenticación
const path = require("path"); // Para manejar rutas de archivos
require("dotenv").config(); // Cargar variables del archivo .env

// Inicializar la aplicación de Express
const app = express();

// Configuración de CORS para producción
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "https://event-app-prod.vercel.app/", // Define el origen del cliente (tu app frontend)
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true, // Permitir envío de cookies y encabezados con credenciales
  }),
);

// Middleware para manejar JSON y formularios
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware para servir los archivos estáticos de la carpeta 'uploads'
app.use("/uploads", express.static(path.join(__dirname, "uploads"))); // Configura la ruta para acceder a las imágenes cargadas

// Configuración de sesión
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mysecretkey", // Clave secreta para firmar las sesiones
    resave: false, // Evitar guardar la sesión si no se modifica
    saveUninitialized: false, // No guardar sesiones vacías
    cookie: {
      secure: process.env.NODE_ENV === "production", // Cookies seguras solo en HTTPS (en producción)
      httpOnly: true, // Proteger la cookie contra acceso desde JavaScript
      maxAge: 24 * 60 * 60 * 1000, // Tiempo de vida: 1 día
    },
  }),
);

// Inicializar Passport.js
app.use(passport.initialize());
app.use(passport.session());
require("./passportConfig"); // Configuración de Passport

// Conectar a MongoDB usando Mongoose
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error al conectar a MongoDB:", err));

// Ruta principal para verificar que el servidor está funcionando
app.get("/", (req, res) => {
  res.send("¡Servidor funcionando correctamente!");
});

// Rutas
const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const searchRoutes = require("./routes/searchRoutes");

app.use("/api/auth", authRoutes);
app.use("/api/users", authRoutes);
app.use("/api/events", eventRoutes);
app.use(searchRoutes);

// Verificar si los archivos se están sirviendo correctamente
app.get("/test-image", (req, res) => {
  res.send(
    `<img src="${process.env.BACKEND_URL}/uploads/test.jpg" alt="Test Image" />`,
  );
});

// Ruta para manejar rutas desconocidas
app.use((req, res, next) => {
  res.status(404).send("Ruta no encontrada");
});

// Puerto
const PORT = process.env.PORT || 5000;

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});

module.exports = app;

/*const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session"); // Para manejar sesiones
const passport = require("passport"); // Passport.js para autenticación
const path = require("path"); // Para manejar rutas de archivos
require("dotenv").config(); // Cargar variables del archivo .env

// Inicializar la aplicación de Express
const app = express();

// Configuración de CORS para producción
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000", // Define el origen del cliente (tu app frontend)
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true, // Permitir envío de cookies y encabezados con credenciales
  }),
);

// Middleware para manejar JSON y formularios
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware para servir los archivos estáticos de la carpeta 'uploads'
app.use("/uploads", express.static(path.join(__dirname, "uploads"))); // Configura la ruta para acceder a las imágenes cargadas

// Configuración de sesión
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mysecretkey", // Clave secreta para firmar las sesiones
    resave: false, // Evitar guardar la sesión si no se modifica
    saveUninitialized: false, // No guardar sesiones vacías
    cookie: {
      secure: process.env.NODE_ENV === "production", // Cookies seguras solo en HTTPS (en producción)
      httpOnly: true, // Proteger la cookie contra acceso desde JavaScript
      maxAge: 24 * 60 * 60 * 1000, // Tiempo de vida: 1 día
    },
  }),
);

// Inicializar Passport.js
app.use(passport.initialize());
app.use(passport.session());
require("./passportConfig"); // Configuración de Passport

// Conectar a MongoDB usando Mongoose
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("Conectado a MongoDB"))
  .catch((err) => console.error("Error al conectar a MongoDB:", err));

// Ruta principal para verificar que el servidor está funcionando
app.get("/", (req, res) => {
  res.send("¡Servidor funcionando correctamente!");
});

// Rutas
const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");

app.use("/api/auth", authRoutes);
app.use("/api/events", eventRoutes);

// Ruta para manejar rutas desconocidas
app.use((req, res, next) => {
  res.status(404).send("Ruta no encontrada");
});

// Puerto
const PORT = process.env.PORT || 5000;

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});

module.exports = app;*/
