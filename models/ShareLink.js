// models/ShareLink.js
const mongoose = require('mongoose');

const ShareLinkSchema = new mongoose.Schema(
  {
    refCode: { type: String, required: true, unique: true, index: true },

    eventId: { type: String, required: true, index: true },
    clubId: { type: String, required: true, index: true },

    createdByUserId: { type: String, default: null, index: true }, // usuario que comparte (si logueado)
    channel: { type: String, default: null, index: true },

    clicks: { type: Number, default: 0 },

    // Unique clicks is an approximation (cookie-based 24h window)
    uniqueClicks: { type: Number, default: 0 },

    lastClickedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ShareLinkSchema.index({ clubId: 1, eventId: 1, createdByUserId: 1, channel: 1, createdAt: -1 });
ShareLinkSchema.index({ clubId: 1, eventId: 1, lastClickedAt: -1 });

module.exports = mongoose.model('ShareLink', ShareLinkSchema);
