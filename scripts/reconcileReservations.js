// scripts/reconcileReservations.js
// Reconciliación de reservas de stock (ticketsReserved y ticketTiers[].reserved).
//
// Corrige reservas "fugadas": contador subido sin ninguna orden que lo respalde
// (lo que dejaba /direct antes del arreglo cuando el club no tenía Stripe).
//
// Uso:  node scripts/reconcileReservations.js [--dry-run]
//
// Reserva REAL = suma de reservedQty de las órdenes con reservationActive: true.
// Se cuentan TODAS, también las caducadas y las pagadas pendientes de confirmar:
// el contador solo baja cuando una orden pasa reservationActive true -> false
// (sweep, webhook de expiración, confirmación del pago o fallo de Stripe). Si no
// las contáramos, ese proceso las restaría otra vez más tarde (doble liberación).
//
// NUNCA toca ticketsSold ni ticketTiers[].sold: son ventas reales.
require("dotenv").config();

const mongoose = require("mongoose");
const Event = require("../models/Event");
const Order = require("../models/Order");

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL;

function pickMongoUri() {
  if (!MONGO_URI) {
    throw new Error(
      "Missing MONGO_URI (or MONGODB_URI / DATABASE_URL) in environment."
    );
  }
  return MONGO_URI;
}

// Las rutas de compra suben el contador un instante ANTES de crear la orden.
// Medimos dos veces con esta pausa y solo corregimos si nada ha cambiado entre
// medias, para no confundir una compra en curso con una fuga.
const STABILITY_WAIT_MS = 5000;
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Eventos con algún contador de reserva por encima de 0. */
async function loadCandidates(ids) {
  const filter = ids
    ? { _id: { $in: ids } }
    : { $or: [{ ticketsReserved: { $gt: 0 } }, { "ticketTiers.reserved": { $gt: 0 } }] };
  return Event.find(filter)
    .select("_id title ticketsReserved ticketTiers.tierId ticketTiers.name ticketTiers.reserved")
    .lean();
}

/**
 * Reservas reales por evento y por tier, a partir de las órdenes activas.
 * Devuelve Map<eventId, { total, byTier: Map<tierId, qty>, expired }>.
 */
async function loadActiveReservations(eventIds) {
  const now = new Date();
  const rows = await Order.aggregate([
    { $match: { reservationActive: true, eventId: { $in: eventIds } } },
    {
      $group: {
        _id: { eventId: "$eventId", tierId: { $ifNull: ["$tierId", null] } },
        qty: { $sum: { $ifNull: ["$reservedQty", 0] } },
        expired: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ["$expiresAt", null] }, { $lt: ["$expiresAt", now] }] },
              { $ifNull: ["$reservedQty", 0] },
              0,
            ],
          },
        },
      },
    },
  ]);

  const out = new Map();
  for (const r of rows) {
    const eid = String(r._id.eventId);
    if (!out.has(eid)) out.set(eid, { total: 0, byTier: new Map(), expired: 0 });
    const e = out.get(eid);
    e.total += r.qty;
    e.expired += r.expired;
    if (r._id.tierId) e.byTier.set(r._id.tierId, (e.byTier.get(r._id.tierId) || 0) + r.qty);
  }
  return out;
}

/** Foto de cada evento: contador actual vs reserva real (global y por tier). */
async function measure(ids) {
  const events = await loadCandidates(ids);
  const active = await loadActiveReservations(events.map((e) => String(e._id)));

  const snap = new Map();
  for (const ev of events) {
    const a = active.get(String(ev._id)) || { total: 0, byTier: new Map(), expired: 0 };
    snap.set(String(ev._id), {
      _id: ev._id,
      title: ev.title || String(ev._id),
      counter: Math.max(0, ev.ticketsReserved || 0),
      real: a.total,
      expired: a.expired,
      tiers: (ev.ticketTiers || []).map((t) => ({
        tierId: t.tierId,
        name: t.name,
        counter: Math.max(0, t.reserved || 0),
        real: a.byTier.get(t.tierId) || 0,
      })),
    });
  }
  return snap;
}

function sameSnapshot(a, b) {
  if (!a || !b) return false;
  if (a.counter !== b.counter || a.real !== b.real) return false;
  if (a.tiers.length !== b.tiers.length) return false;
  return a.tiers.every((t, i) => {
    const u = b.tiers[i];
    return u && u.tierId === t.tierId && u.counter === t.counter && u.real === t.real;
  });
}

/**
 * Construye UN updateOne atómico para el evento: $set de los contadores de
 * reserva al valor real, solo si siguen valiendo lo que acabamos de leer.
 * Devuelve null si no hay nada que corregir.
 */
function buildFix(s) {
  const $set = {};
  const filter = { _id: s._id };
  const arrayFilters = [];
  const $and = [];

  if (s.counter > s.real) {
    $set.ticketsReserved = Math.max(0, s.real);
    filter.ticketsReserved = s.counter;
  }

  s.tiers.forEach((t, i) => {
    if (t.counter > t.real) {
      const id = `t${i}`;
      $set[`ticketTiers.$[${id}].reserved`] = Math.max(0, t.real);
      arrayFilters.push({ [`${id}.tierId`]: t.tierId });
      $and.push({ ticketTiers: { $elemMatch: { tierId: t.tierId, reserved: t.counter } } });
    }
  });

  if (!Object.keys($set).length) return null;
  if ($and.length) filter.$and = $and;

  // Salvaguarda: este script solo puede escribir contadores de RESERVA.
  for (const k of Object.keys($set)) {
    if (k !== "ticketsReserved" && !/^ticketTiers\.\$\[t\d+\]\.reserved$/.test(k)) {
      throw new Error(`Campo no permitido en la corrección: ${k}`);
    }
  }

  return { filter, update: { $set }, options: arrayFilters.length ? { arrayFilters } : {} };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("[reconcile] MODO DRY-RUN — mismas lecturas, no se escribe nada\n");

  await mongoose.connect(pickMongoUri(), {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("[reconcile] Conectado a MongoDB");

  // Pasada 1
  const first = await measure(null);
  const ids = [...first.values()].map((s) => s._id);
  console.log(`[reconcile] Eventos con reservas > 0: ${ids.length}`);

  if (!ids.length) {
    console.log("[reconcile] Nada que revisar. Fin.");
    await mongoose.disconnect();
    process.exit(0);
  }

  // Pasada 2, tras la pausa de estabilidad (también en dry-run)
  console.log(`[reconcile] Esperando ${STABILITY_WAIT_MS / 1000}s y volviendo a medir...\n`);
  await sleep(STABILITY_WAIT_MS);
  const second = await measure(ids);

  let reviewed = 0;
  let affected = 0;
  let corrected = 0;
  let released = 0;
  let releasedTier = 0;
  const unstable = [];
  const conflicts = [];
  const undercounts = [];

  for (const [eid, s1] of first) {
    reviewed++;
    const s2 = second.get(eid);

    // Contador POR DEBAJO de lo real: no es fuga y este script no lo sube.
    if (s2) {
      if (s2.counter < s2.real) undercounts.push(`${s2.title}: contador ${s2.counter} < real ${s2.real}`);
      s2.tiers.forEach((t) => {
        if (t.counter < t.real) undercounts.push(`${s2.title} / ${t.name}: contador ${t.counter} < real ${t.real}`);
      });
    }

    const leak = (s) =>
      s && (s.counter > s.real || s.tiers.some((t) => t.counter > t.real));
    if (!leak(s1) && !leak(s2)) continue;

    if (!sameSnapshot(s1, s2)) {
      unstable.push(s1.title);
      console.log(`⏭  "${s1.title}": ha cambiado entre mediciones (compra en curso). Se omite; vuelve a ejecutar.`);
      continue;
    }

    affected++;
    const diff = s2.counter - s2.real;
    console.log(`• "${s2.title}"  (${eid})`);
    console.log(
      `    ticketsReserved actual: ${s2.counter} | reserva real: ${s2.real} | diferencia: ${Math.max(0, diff)}` +
        (s2.expired ? `  (de la real, ${s2.expired} ya caducadas: las liberará el sweep)` : "")
    );
    s2.tiers
      .filter((t) => t.counter > t.real)
      .forEach((t) =>
        console.log(`    tanda "${t.name}": reserved ${t.counter} | real ${t.real} | diferencia ${t.counter - t.real}`)
      );

    const fix = buildFix(s2);
    if (!fix) continue;

    const eventGain = Math.max(0, diff);
    const tierGain = s2.tiers.reduce((acc, t) => acc + Math.max(0, t.counter - t.real), 0);

    if (dryRun) {
      console.log("    [dry-run] se corregiría");
      corrected++;
      released += eventGain;
      releasedTier += tierGain;
      continue;
    }

    const r = await Event.updateOne(fix.filter, fix.update, fix.options);
    const modified = r && (r.nModified ?? r.modifiedCount ?? 0);
    if (modified) {
      console.log("    ✅ corregido");
      corrected++;
      released += eventGain;
      releasedTier += tierGain;
    } else {
      conflicts.push(s2.title);
      console.log("    ⚠️  no se escribió: el contador cambió justo antes de corregir. Vuelve a ejecutar.");
    }
  }

  console.log(`
═══ Resumen${dryRun ? " (DRY-RUN: nada escrito)" : ""} ═══
  eventos revisados:                 ${reviewed}
  eventos con fuga:                  ${affected}
  eventos ${dryRun ? "que se corregirían" : "corregidos"}:     ${corrected}
  entradas liberadas (aforo global): ${released}
  de ellas, en tandas:               ${releasedTier}
  omitidos por compra en curso:      ${unstable.length}${unstable.length ? "  -> " + unstable.join(", ") : ""}
  no escritos por conflicto:         ${conflicts.length}${conflicts.length ? "  -> " + conflicts.join(", ") : ""}
`);
  if (undercounts.length) {
    console.log("⚠️  Contadores POR DEBAJO de las órdenes activas (no se tocan, revisar a mano):");
    undercounts.forEach((u) => console.log("   - " + u));
    console.log("");
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[reconcile] Error fatal:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
