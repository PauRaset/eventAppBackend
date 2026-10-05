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
  checkedInBy: { type: String, default: null },

  // Asignación a un acompañante (el comprador conserva la custodia)
  assignedToName:  { type: String, default: '' },
  assignedToPhone: { type: String, default: '' },
  assignedAt:      { type: Date, default: null },

  // Usuario de la app al que se ha asignado la entrada (_id de Mongo).
  // Puede verla y mostrar su QR, pero NO reasignarla: eso solo el comprador.
  assignedToUserId: { type: String, default: null, index: true },

  // Token de reclamación: va en el enlace que se comparte.
  // Impredecible, único, y lo único que necesita el acompañante para ver
  // su entrada.
  claimToken:      { type: String, default: null, index: true, sparse: true },

  // Cuando el acompañante abre el enlace / instala la app
  claimedAt:       { type: Date, default: null },
  claimedByUserId: { type: String, default: null }
}, { timestamps: true });

// "Mis entradas": búsquedas por propietario y por email del comprador
TicketSchema.index({ ownerUserId: 1, createdAt: -1 });
TicketSchema.index({ email: 1, createdAt: -1 });

module.exports = mongoose.model('Ticket', TicketSchema);
