const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session"); 
const passport = require("passport"); 
const path = require("path");
require("dotenv").config();

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "https://event-app-prod.vercel.app/", 
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true, 
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "mysecretkey", 
    resave: false, 
    saveUninitialized: false, 
    cookie: {
      secure: process.env.NODE_ENV === "production", 
      httpOnly: true, 
      maxAge: 24 * 60 * 60 * 1000, 
    },
  }),
);

app.use(passport.initialize());
app.use(passport.session());
require("./passportConfig"); 

mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error al conectar a MongoDB:", err));

app.get("/", (req, res) => {
  res.send("¡Servidor funcionando correctamente!");
});

const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const searchRoutes = require("./routes/searchRoutes");

app.use("/api/auth", authRoutes);
app.use("/api/users", authRoutes);
app.use("/api/events", eventRoutes);
app.use(searchRoutes);

app.get("/test-image", (req, res) => {
  res.send(
    `<img src="${process.env.BACKEND_URL}/uploads/test.jpg" alt="Test Image" />`,
  );
});

app.use((req, res, next) => {
  res.status(404).send("Ruta no encontrada");
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});

module.exports = app;
