const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    // Usuario que recibe la notificación
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Tipo principal de notificación
    type: {
      type: String,
      required: true,
      enum: [
        'follow',
        'follow_request',
        'photo_reaction',
        'new_event_photo',
        'event_reminder',
        'event_update',
        'promotion_completed',
        'promotion_level_up',
        'promotion_reward_claimed',
        'promotion_reward',
        'ticket_confirmed',
      ],
      index: true,
    },

    // Usuario que provoca la acción
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Evento relacionado
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      default: null,
    },

    // Foto relacionada
    photoId: {
      type: String,
      default: null,
    },

    // Ticket relacionado
    ticketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ticket',
      default: null,
    },

    // Reacción usada (hype/love/party/energy)
    reactionType: {
      type: String,
      enum: ['hype', 'love', 'party', 'energy', null],
      default: null,
    },

    // Datos rápidos para renderizar sin populate pesado
    title: {
      type: String,
      required: true,
      trim: true,
    },

    body: {
      type: String,
      required: true,
      trim: true,
    },

    // Deep link interno
    routeTarget: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    // Imagen opcional preview/avatar
    previewImage: {
      type: String,
      default: null,
    },

    // Push enviada o no
    pushSent: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Leída dentro de la app
    read: {
      type: Boolean,
      default: false,
      index: true,
    },

    readAt: {
      type: Date,
      default: null,
    },

    // Metadata flexible futura
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
notificationSchema.index({ user: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
