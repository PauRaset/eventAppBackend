const mongoose = require('mongoose');

const CheckInLogSchema = new mongoose.Schema({
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' },
  eventId: { type: String, index: true },
  clubId: { type: String, default: null, index: true }, // club que escanea (null = clave global legacy)
  scannerUserId: { type: String, default: null }, // opcional si luego haces login club
  result: {
    type: String,
    enum: ['ok','duplicate','invalid','bad_signature','refunded','wrong_club','wrong_event','event_ended'],
    required: true,
  },
  ts: { type: Date, default: Date.now },
  note: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('CheckInLog', CheckInLogSchema);
