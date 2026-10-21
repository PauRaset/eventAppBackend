// utils/stock.js
// Reserva y liberación atómica de stock de entradas.
const Event = require('../models/Event');
const Order = require('../models/Order');
const { syncEventPrice } = require('./tiers');

/**
 * Reserva qty entradas de forma atómica (eventos SIN tandas).
 * Devuelve { ok: false } si no hay stock, o { ok: true, counted }:
 *  - counted true:  sumó qty a ticketsReserved (evento con aforo)
 *  - counted false: aforo ilimitado (capacity <= 0), no se reservó nada
 * Guarda `counted` en la orden (Order.reservationCounted): al liberarla solo
 * se resta si sumó (releaseOrderStock / commitStock).
 */
async function reserveStock(eventId, qty) {
  const evt = await Event.findById(eventId).select('capacity').lean();
  if (!evt) return { ok: false };
  if (!evt.capacity || evt.capacity <= 0) return { ok: true, counted: false }; // sin límite

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
  return updated ? { ok: true, counted: true } : { ok: false };
}

/** Libera una reserva (por caducidad o error). Nunca deja el contador negativo. */
async function releaseStock(eventId, qty) {
  if (!qty || qty <= 0) return;
  await Event.updateOne(
    { _id: eventId, ticketsReserved: { $gte: qty } },
    { $inc: { ticketsReserved: -qty } }
  );
}

/**
 * Convierte una reserva en venta confirmada. `counted: false` (la reserva no
 * sumó a ticketsReserved: aforo ilimitado al reservar) -> solo suma la venta.
 */
async function commitStock(eventId, qty, { counted = true } = {}) {
  if (!qty || qty <= 0) return;
  await Event.updateOne({ _id: eventId }, { $inc: { ticketsSold: qty } });
  if (counted) await releaseStock(eventId, qty);
}

/**
 * Venta directa en UN paso, sin reserva previa (reservas gratuitas: no hay
 * pago que esperar). Atómica, como reserveStock: suma qty a ticketsSold solo
 * si vendidas + reservadas + qty <= aforo. Exige aforo (capacity > 0).
 * Devuelve true si cupo y se contó; false si no queda aforo.
 */
async function sellStockDirect(eventId, qty) {
  if (!qty || qty <= 0) return false;
  const updated = await Event.findOneAndUpdate(
    {
      _id: eventId,
      capacity: { $gt: 0 },
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ['$ticketsSold', 0] }, { $ifNull: ['$ticketsReserved', 0] }, qty] },
          '$capacity',
        ],
      },
    },
    { $inc: { ticketsSold: qty } },
    { new: true }
  );
  return !!updated;
}

/** Devuelve plazas vendidas (cancelación de una reserva gratuita). Nunca deja el contador negativo. */
async function releaseSoldStock(eventId, qty) {
  if (!qty || qty <= 0) return;
  await Event.updateOne(
    { _id: eventId, ticketsSold: { $gte: qty } },
    { $inc: { ticketsSold: -qty } }
  );
}

/** ¿Sumó la reserva de esta orden a ticketsReserved? null (órdenes antiguas) = sí. */
function orderReservationCounted(order) {
  return !!order && order.reservationCounted !== false;
}

/**
 * Libera la reserva de una orden con la función que le toca: tanda ->
 * releaseTierStock; sin tanda -> releaseStock, solo si de verdad sumó.
 * La orden debe estar ya reclamada (reservationActive -> false) por quien llama.
 */
async function releaseOrderStock(order) {
  const qty = order?.reservedQty || 0;
  if (!qty) return;
  if (order.tierId) return releaseTierStock(order.eventId, order.tierId, qty);
  if (orderReservationCounted(order)) return releaseStock(order.eventId, qty);
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

  let released = 0;
  for (const o of stale) {
    try {
      // Reclamación atómica ANTES de liberar: si el webhook de Stripe
      // (checkout.session.expired) o otro barrido ya la liberó, no se libera
      // dos veces.
      const claimed = await Order.findOneAndUpdate(
        { _id: o._id, reservationActive: true },
        { $set: { reservationActive: false, status: 'expired' } }
      );
      if (!claimed) continue;

      // Cada orden con SU función: las de tanda bajan ticketTiers[].reserved y
      // ticketsReserved. Antes se usaba releaseStock para todas, y en las de
      // tanda el reservado de la tanda se quedaba bloqueado para siempre.
      await releaseOrderStock(claimed);
      released++;
    } catch (e) {
      console.error('[stock] sweep fallo en orden', String(o._id), e.message);
    }
  }
  if (released) console.log(`[stock] liberadas ${released} reservas caducadas`);
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

/**
 * Venta de una tanda cuya reserva ya se había liberado (la sesión se pagó justo
 * cuando caducaba y el barrido o el aviso de expiración la soltó antes). El
 * pago ya está hecho: se cuenta la venta sin mirar el cupo ni tocar reservas.
 * La usaba el webhook de Stripe pero no existía (TypeError: el pago se quedaba
 * sin entradas y Stripe reintentaba sin fin).
 */
async function addTierSoldWithoutReservation(eventId, tierId, qty) {
  if (!qty || qty <= 0) return;
  await Event.updateOne(
    { _id: eventId, 'ticketTiers.tierId': tierId },
    { $inc: { 'ticketTiers.$[tier].sold': qty, ticketsSold: qty } },
    { arrayFilters: [{ 'tier.tierId': tierId }] }
  );
  await syncPriceFromTiers(eventId);
}

module.exports = {
  reserveStock, releaseStock, commitStock, sweepExpiredReservations,
  releaseOrderStock, orderReservationCounted,
  sellStockDirect, releaseSoldStock,
  availableTiers, tierRemaining,
  reserveTierStock, releaseTierStock, commitTierStock, addTierSoldWithoutReservation,
};
