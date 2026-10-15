// models/ShareOpen.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Apertura VÁLIDA de un enlace compartido: un usuario AUTENTICADO en la app,
 * distinto de quien compartió, abre la app desde el enlace (?ref=).
 * Es lo que cuenta para las misiones link_clicks. Los clics web anónimos
 * (GET /api/share/r/:refCode) siguen solo en los contadores de ShareLink, para
 * la analítica, y NO dan progreso.
 *
 * Una persona cuenta como mucho una vez por enlace (índice único).
 */
const ShareOpenSchema = new Schema(
  {
    refCode: { type: String, required: true },
    shareLink: { type: Schema.Types.ObjectId, ref: 'ShareLink', required: true },
    eventId: { type: String, required: true },

    // Ambos como _id de Mongo (ya traducidos desde el uid de Firebase si hacía falta)
    sharerUserId: { type: String, required: true },
    openerUserId: { type: String, required: true },

    openedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

ShareOpenSchema.index({ shareLink: 1, openerUserId: 1 }, { unique: true });
// syncReferralMissions: aperturas de los enlaces de un usuario en los eventos de un club
ShareOpenSchema.index({ sharerUserId: 1, eventId: 1 });

module.exports = mongoose.model('ShareOpen', ShareOpenSchema);
