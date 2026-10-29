// routes/configRoutes.js
// Configuración pública que la app necesita ANTES de iniciar sesión (pantalla
// del alta): edad mínima y versión vigente de los términos.
// GET /api/config/public -> { minAge, termsVersion }
const express = require("express");
const rateLimit = require("express-rate-limit");
const { getMinAge } = require("../utils/age");
const { currentTermsVersion } = require("../utils/onboarding");

const router = express.Router();

const publicConfigLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: "too_many_requests" }),
});

router.get("/public", publicConfigLimiter, (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  return res.json({ minAge: getMinAge(), termsVersion: currentTermsVersion() });
});

module.exports = router;
