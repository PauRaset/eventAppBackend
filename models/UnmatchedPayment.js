// models/UnmatchedPayment.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Sesión de Checkout PAGADA que no corresponde a ninguna orden nuestra
 * (sin orderId en los metadatos, o con uno que no existe, y sin orden por
 * stripeSessionId). Por ejemplo, un enlace de pago creado desde el panel de
 * Stripe u otra integración sobre la misma cuenta.
 *
 * El webhook NO emite entradas para estos pagos: solo los registra aquí para
 * revisarlos a mano (reembolsar o emitir manualmente). Va en su propia
 * colección para no contar como venta en los listados ni en los CSV de clubs.
 *
 * Una fila por sesión (índice único): los reintentos de Stripe no duplican.
 */
const UnmatchedPaymentSchema = new Schema(
  {
    stripeSessionId: { type: String, required: true },
    paymentIntentId: { type: String, default: null, index: true },
    amountTotalCents: { type: Number, default: null },
    currency: { type: String, default: null },
    email: { type: String, default: null },
    livemode: { type: Boolean, default: null },
    stripeEventId: { type: String, default: null },
    // Metadatos tal cual llegaron (eventId, clubId, orderId...): sin verificar
    metadata: { type: Schema.Types.Mixed, default: {} },
    reason: { type: String, default: '' },
    status: { type: String, enum: ['pending_review', 'resolved'], default: 'pending_review', index: true },
  },
  { timestamps: true }
);

UnmatchedPaymentSchema.index({ stripeSessionId: 1 }, { unique: true });

module.exports =
  mongoose.models.UnmatchedPayment || mongoose.model('UnmatchedPayment', UnmatchedPaymentSchema);
