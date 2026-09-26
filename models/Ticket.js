const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
  eventId: { type: String, index: true, required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  ownerUserId: { type: String, default: null },
  email: { type: String, default: null },
  ticketTypeId: { type: String, default: null },
  serial: { type: String, unique: true, index: true }, // ej. NV-7F3K-92
  tokenHash: { type: String, unique: true, index: true }, // hash del token
  status: { type: String, enum: ['issued','checked_in','refunded'], default: 'issued' },
  issuedAt: { type: Date, default: Date.now },
  checkedInAt: { type: Date, default: null },
  checkedInBy: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Ticket', TicketSchema);
