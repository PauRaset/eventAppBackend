// models/ClubApplication.js
const mongoose = require('mongoose');

const ClubApplicationSchema = new mongoose.Schema(
  {
    /* ===== Solicitud base ===== */
    email:       { type: String, index: true, required: true }, // no unique por si reintentan
    clubName:    { type: String, required: true },
    contactName: { type: String, default: '' },
    phone:       { type: String, default: '' },
    website:     { type: String, default: '' },
    instagram:   { type: String, default: '' },

    /* ===== Verificación de email ===== */
    verifyToken:          { type: String, index: true },
    verifyTokenExpiresAt: { type: Date },

    /* ===== Flujo de estado =====
       pending -> email_verified -> approved | rejected */
    status: {
      type: String,
      enum: ['pending', 'email_verified', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    approvedAt: { type: Date },
    notes:      { type: String, default: '' },

    /* ===== Token para crear contraseña del panel ===== */
    passwordToken:          { type: String, index: true },
    passwordTokenExpiresAt: { type: Date },
  },
  { timestamps: true }
);

/* ===== Helpers opcionales ===== */
ClubApplicationSchema.methods.isVerifyTokenValid = function (token) {
  if (!token || token !== this.verifyToken) return false;
  if (!this.verifyTokenExpiresAt) return false;
  return this.verifyTokenExpiresAt > new Date();
};

ClubApplicationSchema.methods.isPasswordTokenValid = function (token) {
  if (!token || token !== this.passwordToken) return false;
  if (!this.passwordTokenExpiresAt) return false;
  return this.passwordTokenExpiresAt > new Date();
};

/* Normalización simple de email */
ClubApplicationSchema.pre('save', function (next) {
  if (this.email) this.email = this.email.toLowerCase().trim();
  next();
});

/* Índices útiles adicionales */
ClubApplicationSchema.index({ email: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('ClubApplication', ClubApplicationSchema);
