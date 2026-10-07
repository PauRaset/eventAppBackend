// models/QrScan.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Un registro por cada escaneo del QR de un evento (prueba de presencia).
 * Lo crean GET /api/events/scan/:token/resolve y POST /api/events/scan/resolve.
 * Lo consulta la subida de fotos de misión: exige un escaneo reciente del
 * mismo usuario en el mismo evento.
 */
const QrScanSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    event: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    scannedAt: { type: Date, default: Date.now },

    // Auditoría
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: false }
);

// "¿Escaneó este usuario este evento hace poco?" y "¿es su primer escaneo?"
QrScanSchema.index({ user: 1, event: 1, scannedAt: -1 });

module.exports = mongoose.model('QrScan', QrScanSchema);
