const mongoose = require('mongoose');

const CheckInLogSchema = new mongoose.Schema({
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' },
  eventId: { type: String, index: true },
  scannerUserId: { type: String, default: null }, // opcional si luego haces login club
  result: { type: String, enum: ['ok','duplicate','invalid','bad_signature'], required: true },
  ts: { type: Date, default: Date.now },
  note: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('CheckInLog', CheckInLogSchema);
