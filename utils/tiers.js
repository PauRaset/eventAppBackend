// utils/tiers.js
// Saneado, validación y precio derivado de los tipos de entrada (tandas).
// Sin dependencias de modelos, para que stock.js pueda usarlo sin ciclos.
const mongoose = require('mongoose');

/** Igual que parsePrice de payments.js: acepta "12,50" y "12.50". */
function parsePriceEUR(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  let str = String(v).trim();
  if (!str) return null;
  str = str.replace(/[€\s]/g, '').replace(',', '.');

  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

/** Date válida o null. Devuelve undefined si el valor es inválido. */
function parseDateOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseActive(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'string') return v.trim().toLowerCase() !== 'false';
  return Boolean(v);
}

/** Convierte subdocumentos de Mongoose a objetos planos. */
function plain(t) {
  return t && typeof t.toObject === 'function' ? t.toObject() : t;
}

/**
 * Sanea el array de tiers que llega del cliente.
 * - IGNORA sold y reserved si vienen: son del sistema, nunca del club.
 * - Genera tierId para los nuevos: `tier_${new mongoose.Types.ObjectId()}`.
 * - Conserva el tierId de los existentes.
 * - name obligatorio y no vacío; priceEUR >= 0; quantity entero >= 0.
 * - order: reasigna por posición en el array (1, 2, 3...).
 * - Normaliza salesStart/salesEnd a Date o null.
 * Devuelve { tiers, error } — error es un string legible o null.
 */
function sanitizeTiers(incoming, existingTiers = []) {
  if (!Array.isArray(incoming)) {
    return { tiers: [], error: 'ticketTiers debe ser una lista' };
  }

  const existingById = new Map(
    (existingTiers || []).map(plain).filter(Boolean).map((t) => [t.tierId, t])
  );

  const tiers = [];
  const seenIds = new Set();

  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i];
    const label = `Tanda ${i + 1}`;
    if (!raw || typeof raw !== 'object') {
      return { tiers: [], error: `${label}: formato inválido` };
    }

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return { tiers: [], error: `${label}: el nombre es obligatorio` };

    const priceEUR = parsePriceEUR(raw.priceEUR);
    if (priceEUR === null || priceEUR < 0) {
      return { tiers: [], error: `${label} ("${name}"): precio inválido` };
    }

    const quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 0) {
      return {
        tiers: [],
        error: `${label} ("${name}"): la cantidad debe ser un número entero >= 0 (0 = ilimitado)`,
      };
    }

    const salesStart = parseDateOrNull(raw.salesStart);
    const salesEnd = parseDateOrNull(raw.salesEnd);
    if (salesStart === undefined || salesEnd === undefined) {
      return { tiers: [], error: `${label} ("${name}"): fecha de venta inválida` };
    }
    if (salesStart && salesEnd && salesStart > salesEnd) {
      return {
        tiers: [],
        error: `${label} ("${name}"): el inicio de venta es posterior al fin`,
      };
    }

    // Solo conservamos tierIds que ya existen; uno desconocido se trata como nuevo.
    const incomingId = typeof raw.tierId === 'string' ? raw.tierId.trim() : '';
    const existing = incomingId ? existingById.get(incomingId) : null;
    if (existing && seenIds.has(existing.tierId)) {
      return { tiers: [], error: `${label} ("${name}"): tanda duplicada` };
    }
    const tierId = existing
      ? existing.tierId
      : `tier_${new mongoose.Types.ObjectId().toString()}`;
    seenIds.add(tierId);

    tiers.push({
      tierId,
      name,
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      priceEUR,
      quantity,
      // Contadores: siempre los del sistema
      sold: existing ? existing.sold || 0 : 0,
      reserved: existing ? existing.reserved || 0 : 0,
      order: i + 1,
      active: parseActive(raw.active, existing ? existing.active !== false : true),
      salesStart,
      salesEnd,
    });
  }

  return { tiers, error: null };
}

/**
 * Valida un cambio de tiers contra los existentes. Reglas:
 * - No se puede bajar `quantity` por debajo de lo ya comprometido
 *   (sold + reserved) de ese tier. quantity 0 (ilimitado) siempre vale.
 * - No se puede eliminar un tier que tenga sold > 0 o reserved > 0:
 *   en su lugar debe desactivarse (active: false).
 * Devuelve { ok, error }.
 */
function validateTierChanges(newTiers, existingTiers) {
  const newById = new Map((newTiers || []).map((t) => [t.tierId, t]));

  for (const oldRaw of existingTiers || []) {
    const old = plain(oldRaw);
    if (!old) continue;
    const sold = old.sold || 0;
    const reserved = old.reserved || 0;
    const next = newById.get(old.tierId);

    if (!next) {
      if (sold > 0 || reserved > 0) {
        return {
          ok: false,
          error: `No se puede eliminar "${old.name}": ya tiene entradas vendidas o reservadas. Desactívala en su lugar.`,
        };
      }
      continue;
    }

    if (next.quantity > 0 && next.quantity < sold + reserved) {
      const detail = reserved > 0
        ? `${sold} vendidas y ${reserved} en proceso de pago`
        : `${sold} vendidas`;
      return {
        ok: false,
        error: `"${next.name}": la cantidad no puede ser menor que ${sold + reserved} (${detail}).`,
      };
    }
  }

  return { ok: true, error: null };
}

/** Comprable ahora: activo, dentro de ventana y con unidades libres. */
function isPurchasable(tier, now = new Date()) {
  if (!tier || tier.active === false) return false;
  if (tier.salesStart && now < new Date(tier.salesStart)) return false;
  if (tier.salesEnd && now > new Date(tier.salesEnd)) return false;
  if (!tier.quantity || tier.quantity <= 0) return true; // ilimitado
  return tier.quantity - (tier.sold || 0) - (tier.reserved || 0) > 0;
}

/**
 * Devuelve el precio de la tanda comprable más barata, o null si no hay
 * ninguna comprable. Comprable = active, dentro de ventana de venta, y
 * con unidades libres.
 */
function cheapestAvailablePrice(tiers) {
  const now = new Date();
  const prices = (tiers || [])
    .map(plain)
    .filter((t) => isPurchasable(t, now))
    .map((t) => t.priceEUR)
    .filter((p) => typeof p === 'number' && Number.isFinite(p));
  return prices.length ? Math.min(...prices) : null;
}

/**
 * Sincroniza event.price con la tanda comprable más barata.
 * Si no hay tiers, no toca nada. Si hay tiers pero ninguno comprable,
 * deja el precio del último tier vendido (para que el evento no pase a
 * mostrar 0 €). Muta el objeto/documento recibido.
 */
function syncEventPrice(event) {
  if (!event) return event;
  const tiers = (event.ticketTiers || []).map(plain).filter(Boolean);
  if (!tiers.length) return event;

  const cheapest = cheapestAvailablePrice(tiers);
  if (cheapest !== null) {
    event.price = cheapest;
    return event;
  }

  // Ninguna comprable: precio de la última tanda (por order) que haya vendido algo.
  const byOrderDesc = [...tiers].sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
  const lastSold = byOrderDesc.find((t) => (t.sold || 0) > 0);
  if (lastSold) event.price = lastSold.priceEUR;
  // Si ninguna ha vendido nada, dejamos el price como estaba.
  return event;
}

module.exports = {
  parsePriceEUR,
  sanitizeTiers,
  validateTierChanges,
  cheapestAvailablePrice,
  syncEventPrice,
};
