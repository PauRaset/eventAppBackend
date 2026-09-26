// utils/stock.js
// Reserva y liberación atómica de stock de entradas.
const Event = require('../models/Event');
const Order = require('../models/Order');
const { syncEventPrice } = require('./tiers');

/**
 * Reserva qty entradas de forma atómica.
 * Devuelve true si se pudo reservar, false si no hay stock.
 * capacity <= 0 significa aforo ilimitado: no se reserva nada.
 */
async function reserveStock(eventId, qty) {
  const evt = await Event.findById(eventId).select('capacity').lean();
  if (!evt) return false;
  if (!evt.capacity || evt.capacity <= 0) return true; // sin límite

  const updated = await Event.findOneAndUpdate(
    {
      _id: eventId,
      $expr: {
        $lte: [
          { $add: ['$ticketsSold', { $ifNull: ['$ticketsReserved', 0] }, qty] },
          '$capacity',
        ],
      },
    },
    { $inc: { ticketsReserved: qty } },
    { new: true }
  );
  return !!updated;
}

/** Libera una reserva (por caducidad o error). Nunca deja el contador negativo. */
async function releaseStock(eventId, qty) {
  if (!qty || qty <= 0) return;
  await Event.updateOne(
    { _id: eventId, ticketsReserved: { $gte: qty } },
    { $inc: { ticketsReserved: -qty } }
  );
}

/** Convierte una reserva en venta confirmada. */
async function commitStock(eventId, qty) {
  if (!qty || qty <= 0) return;
  await Event.updateOne({ _id: eventId }, { $inc: { ticketsSold: qty } });
  await releaseStock(eventId, qty);
}

/**
 * Limpieza perezosa: libera reservas de órdenes caducadas que nadie
 * liberó (por ejemplo si se perdió el webhook de expiración).
 */
async function sweepExpiredReservations() {
  const now = new Date();
  const stale = await Order.find({
    reservationActive: true,
    status: { $in: ['created', 'pending'] },
    expiresAt: { $lt: now },
  }).limit(50);

  for (const o of stale) {
    try {
      await releaseStock(o.eventId, o.reservedQty || 0);
      o.reservationActive = false;
      o.status = 'expired';
      await o.save();
    } catch (e) {
      console.error('[stock] sweep fallo en orden', String(o._id), e.message);
    }
  }
  if (stale.length) console.log(`[stock] liberadas ${stale.length} reservas caducadas`);
}

// ─── Funciones para eventos con ticketTiers ───────────────────────────────────

/**
 * Devuelve los tiers comprables AHORA, ordenados por `order`.
 * Un tier es comprable si: active, dentro de su ventana de venta,
 * y con unidades libres (quantity 0 = ilimitado).
 */
function availableTiers(event) {
  const now = new Date();
  return (event.ticketTiers || [])
    .filter((tier) => {
      if (!tier.active) return false;
      if (tier.salesStart && now < new Date(tier.salesStart)) return false;
      if (tier.salesEnd   && now > new Date(tier.salesEnd))   return false;
      return tierRemaining(tier) !== 0;
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Unidades libres de un tier: quantity - sold - reserved.
 * Devuelve Infinity si quantity es 0 (ilimitado).
 */
function tierRemaining(tier) {
  if (!tier.quantity || tier.quantity <= 0) return Infinity;
  return Math.max(0, tier.quantity - (tier.sold || 0) - (tier.reserved || 0));
}

/**
 * Reserva qty unidades de un tier concreto de forma ATÓMICA.
 *
 * Atomicidad: un único findOneAndUpdate cuyo filtro verifica
 * simultáneamente aforo global (capacity) y capacidad del tier
 * mediante $expr con $filter. Si el documento no matchea el filtro
 * (capacidad insuficiente en cualquier nivel), la operación no ocurre
 * y ambos contadores quedan intactos.
 *
 * Devuelve { ok: true } o { ok: false, reason, remaining }.
 */
async function reserveTierStock(eventId, tierId, qty) {
  if (!qty || qty <= 0) return { ok: false, reason: 'tier_not_found', remaining: 0 };

  const updated = await Event.findOneAndUpdate(
    {
      _id: eventId,
      $expr: {
        $and: [
          // Aforo global: sin límite (capacity <= 0) o hay hueco
          {
            $or: [
              { $lte: ['$capacity', 0] },
              {
                $lte: [
                  { $add: ['$ticketsSold', { $ifNull: ['$ticketsReserved', 0] }, qty] },
                  '$capacity',
                ],
              },
            ],
          },
          // Tier: existe, está activo y tiene capacidad
          {
            $gte: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ['$ticketTiers', []] },
                    as: 't',
                    cond: {
                      $and: [
                        { $eq: ['$$t.tierId', tierId] },
                        { $eq: ['$$t.active', true] },
                        {
                          $or: [
                            { $lte: ['$$t.quantity', 0] },
                            {
                              $lte: [
                                { $add: ['$$t.sold', { $ifNull: ['$$t.reserved', 0] }, qty] },
                                '$$t.quantity',
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
              1,
            ],
          },
        ],
      },
    },
    {
      $inc: {
        'ticketTiers.$[tier].reserved': qty,
        ticketsReserved: qty,
      },
    },
    {
      arrayFilters: [{ 'tier.tierId': tierId, 'tier.active': true }],
      new: true,
    }
  );

  if (updated) return { ok: true };

  // Lectura de diagnóstico para determinar el motivo
  const evt = await Event.findById(eventId)
    .select('capacity ticketsSold ticketsReserved ticketTiers')
    .lean();

  if (!evt) return { ok: false, reason: 'tier_not_found', remaining: 0 };

  const tier = (evt.ticketTiers || []).find((t) => t.tierId === tierId && t.active !== false);
  if (!tier) return { ok: false, reason: 'tier_not_found', remaining: 0 };

  const tierRem = tierRemaining(tier);
  if (tierRem !== Infinity && tierRem <= 0) {
    return { ok: false, reason: 'tier_sold_out', remaining: 0 };
  }

  if (evt.capacity > 0) {
    const globalRem = evt.capacity - (evt.ticketsSold || 0) - (evt.ticketsReserved || 0);
    if (globalRem <= 0) {
      return { ok: false, reason: 'event_sold_out', remaining: Math.max(0, globalRem) };
    }
  }

  return {
    ok: false,
    reason: 'tier_sold_out',
    remaining: tierRem === Infinity ? null : tierRem,
  };
}

/**
 * Libera una reserva de tier. Decrementa tanto tier.reserved
 * como el contador global ticketsReserved de forma atómica.
 * El $elemMatch en el filtro evita decrementar ticketsReserved
 * si el tier ya no tiene esa reserva.
 */
async function releaseTierStock(eventId, tierId, qty) {
  if (!qty || qty <= 0) return;
  await Event.updateOne(
    {
      _id: eventId,
      ticketTiers: { $elemMatch: { tierId, reserved: { $gte: qty } } },
    },
    {
      $inc: {
        'ticketTiers.$[tier].reserved': -qty,
        ticketsReserved: -qty,
      },
    },
    { arrayFilters: [{ 'tier.tierId': tierId }] }
  );
  // Si se libera la última reserva de una tanda barata, vuelve a estar a la venta.
  await syncPriceFromTiers(eventId);
}

/**
 * Recalcula event.price a partir de las tandas y guarda SOLO ese campo.
 * Nunca lanza: un fallo aquí no debe romper la emisión de entradas.
 * El filtro por el price leído evita que un cálculo más antiguo pise a
 * uno más reciente cuando dos compras se confirman a la vez.
 */
async function syncPriceFromTiers(eventId) {
  try {
    const evt = await Event.findById(eventId).select('price ticketTiers').lean();
    if (!evt || !Array.isArray(evt.ticketTiers) || !evt.ticketTiers.length) return;

    const before = evt.price;
    syncEventPrice(evt);
    if (evt.price === before) return;

    await Event.updateOne({ _id: eventId, price: before }, { $set: { price: evt.price } });
  } catch (e) {
    console.error('[stock] no se pudo sincronizar price del evento', String(eventId), e.message);
  }
}

/**
 * Convierte una reserva de tier en venta confirmada.
 * Atómicamente: sube tier.sold, baja tier.reserved,
 * sube ticketsSold y baja ticketsReserved.
 */
async function commitTierStock(eventId, tierId, qty) {
  if (!qty || qty <= 0) return;
  await Event.updateOne(
    {
      _id: eventId,
      ticketTiers: { $elemMatch: { tierId, reserved: { $gte: qty } } },
    },
    {
      $inc: {
        'ticketTiers.$[tier].sold':     qty,
        'ticketTiers.$[tier].reserved': -qty,
        ticketsSold:     qty,
        ticketsReserved: -qty,
      },
    },
    { arrayFilters: [{ 'tier.tierId': tierId }] }
  );
  // Si esta venta agota la tanda, el price del evento pasa a la siguiente.
  await syncPriceFromTiers(eventId);
}

module.exports = {
  reserveStock, releaseStock, commitStock, sweepExpiredReservations,
  availableTiers, tierRemaining,
  reserveTierStock, releaseTierStock, commitTierStock,
};
