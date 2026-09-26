// models/Club.js
const mongoose = require('mongoose');
const crypto = require('crypto');

const ClubSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, unique: true, index: true },
  ownerUserId: { type: String, required: true },   // uid Firebase o tu user _id
  managers: [{ type: String }],                    // otros emails/uids con permiso
  stripeAccountId: { type: String, index: true },  // acct_...
  scannerApiKey: { type: String, index: true },    // si usas llave por club
  status: { type: String, enum: ['draft','active','suspended'], default: 'draft' },
}, { timestamps: true });

/**
 * Genera una API key robusta (base64url)
 */
function generateScannerKey() {
  // 32 bytes -> 256 bits de entropía
  return crypto.randomBytes(32).toString('base64url'); 
}

/**
 * Pre-save: si no hay scannerApiKey, la crea automáticamente.
 */
ClubSchema.pre('save', function(next) {
  if (!this.scannerApiKey) {
    this.scannerApiKey = generateScannerKey();
  }
  next();
});

/**
 * Método de instancia: regenera y persiste la scannerApiKey.
 */
ClubSchema.methods.regenerateScannerApiKey = async function() {
  this.scannerApiKey = generateScannerKey();
  await this.save();
  return this.scannerApiKey;
};

module.exports = mongoose.model('Club', ClubSchema);
