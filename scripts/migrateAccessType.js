// scripts/migrateAccessType.js
// Pone Event.accessType a los eventos que no lo tienen (anteriores al campo):
//   price > 0 o alguna tanda de pago  -> 'paid'
//   price 0, null o ausente           -> 'free_open'
// Nunca asigna 'free_limited': eso lo decide el club.
//
// Uso:  node scripts/migrateAccessType.js [--dry-run] [--verbose]
//
//   --dry-run   enseña el resumen sin escribir nada
//   --verbose   una línea por evento (si no, solo los primeros de cada grupo)
//
// Solo toca eventos SIN el campo: los que ya lo tienen no se cambian (los
// incoherentes con su precio se listan para revisarlos a mano). Cada escritura
// está condicionada a que el campo siga sin existir. Seguro de relanzar.
require("dotenv").config();

const mongoose = require("mongoose");
const Event = require("../models/Event");
const { deriveAccessType, validateAccessType } = require("../utils/accessType");

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL;

function pickMongoUri() {
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI (or MONGODB_URI / DATABASE_URL) in environment.");
  }
  return MONGO_URI;
}

const SAMPLE = 10;

function priceState(ev) {
  if (!("price" in ev)) return "ausente";
  if (ev.price === null) return "null";
  if (ev.price === "") return "vacío";
  const n = Number(ev.price);
  if (!Number.isFinite(n)) return `no numérico (${JSON.stringify(ev.price)})`;
  return n > 0 ? `${n} €` : "0";
}

function tiersSummary(ev) {
  const tiers = Array.isArray(ev.ticketTiers) ? ev.ticketTiers : [];
  if (!tiers.length) return "sin tandas";
  return tiers.map((t) => `${t.name || "?"}=${t.priceEUR}€`).join(", ");
}

function isMixed(ev) {
  const tiers = Array.isArray(ev.ticketTiers) ? ev.ticketTiers : [];
  const prices = tiers.map((t) => Number(t.priceEUR) || 0);
  return prices.some((p) => p === 0) && prices.some((p) => p > 0);
}

function line(ev, extra = "") {
  const when = ev.startAt || ev.date;
  return `    ${ev._id}  "${String(ev.title || "").slice(0, 40)}"  precio=${priceState(ev)}  ${tiersSummary(ev)}` +
    `${when ? `  fecha=${new Date(when).toISOString().slice(0, 10)}` : ""}${extra ? `  ${extra}` : ""}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose");
  await mongoose.connect(pickMongoUri());
  console.log(`[migrateAccessType] Conectado${dryRun ? " — MODO DRY-RUN, no se escribirá nada" : ""}\n`);

  // Lectura en bruto: el modelo aplicaría el defecto 'free_open' a los que no lo tienen.
  const events = await Event.collection
    .find({}, { projection: { title: 1, price: 1, ticketTiers: 1, accessType: 1, capacity: 1, startAt: 1, date: 1 } })
    .toArray();

  const groups = { paid: [], free_open: [] };
  const already = { ok: 0, incoherent: [] };
  const mixed = [];
  const freeByPrice = new Map();
  let written = 0;
  let raced = 0;

  for (const ev of events) {
    if (isMixed(ev)) mixed.push(ev);

    if (ev.accessType !== undefined) {
      const problem = validateAccessType(ev.accessType, ev);
      if (problem) already.incoherent.push({ ev, problem });
      else already.ok++;
      continue;
    }

    const type = deriveAccessType(ev);
    groups[type].push(ev);
    if (type === "free_open") {
      const k = Array.isArray(ev.ticketTiers) && ev.ticketTiers.length ? "con tandas a 0 €" : `precio ${priceState(ev)}`;
      freeByPrice.set(k, (freeByPrice.get(k) || 0) + 1);
    }

    if (!dryRun) {
      const r = await Event.collection.updateOne(
        { _id: ev._id, accessType: { $exists: false } },
        { $set: { accessType: type } }
      );
      if (r.modifiedCount) written++;
      else raced++;
    }
  }

  const show = (list, fmt = (e) => line(e)) => {
    const items = verbose ? list : list.slice(0, SAMPLE);
    items.forEach((e) => console.log(fmt(e)));
    if (!verbose && list.length > SAMPLE) console.log(`    … y ${list.length - SAMPLE} más (--verbose para verlos todos)`);
  };

  console.log(`===== Resumen${dryRun ? " (DRY-RUN: no se ha guardado nada)" : ""} =====`);
  console.log(`Eventos en total:                 ${events.length}`);
  console.log(`  ya tenían accessType:           ${already.ok + already.incoherent.length}` +
    (already.incoherent.length ? ` (${already.incoherent.length} incoherentes con su precio, ver abajo)` : ""));
  console.log(`  sin accessType:                 ${groups.paid.length + groups.free_open.length}`);
  console.log(`    -> paid:                      ${groups.paid.length}`);
  console.log(`    -> free_open:                 ${groups.free_open.length}`);
  for (const [k, n] of freeByPrice) console.log(`         ${k}: ${n}`);
  if (!dryRun) console.log(`  escritos: ${written}${raced ? ` (${raced} ya los había puesto otro proceso)` : ""}`);

  if (groups.paid.length) {
    console.log("\n'paid':");
    show(groups.paid);
  }
  if (groups.free_open.length) {
    console.log("\n'free_open':");
    show(groups.free_open);
  }
  const freeWithTiers = groups.free_open.filter((e) => Array.isArray(e.ticketTiers) && e.ticketTiers.length);
  if (freeWithTiers.length) {
    console.log(`\nℹ️ ${freeWithTiers.length} evento(s) quedan 'free_open' pero tienen tandas a 0 € (con cupo).`);
    console.log("   Si son eventos gratis con aforo, conviértelos: quita la tanda y pon su cupo como AFORO");
    console.log("   del evento ('free_limited' no admite tandas). Aforo sugerido = suma de las cantidades:");
    show(freeWithTiers, (e) => {
      const quantities = (e.ticketTiers || []).map((t) => Number(t.quantity) || 0);
      const unlimited = quantities.some((q) => q <= 0);
      const sum = quantities.reduce((a, q) => a + q, 0);
      return line(e, unlimited ? "aforo sugerido: (alguna tanda es ilimitada)" : `aforo sugerido: ${sum}`);
    });
  }
  if (mixed.length) {
    console.log(`\n⚠️ ${mixed.length} evento(s) MEZCLAN tandas gratis y de pago (quedan como 'paid').`);
    console.log("   Al editar sus tandas el portal recibirá 400 mixed_free_and_paid_tiers hasta quitar la tanda a 0 €:");
    show(mixed);
  }
  if (already.incoherent.length) {
    console.log("\n⚠️ Con accessType guardado que NO cuadra con su precio (no se tocan; la app ve el deducido):");
    show(already.incoherent, ({ ev, problem }) => line(ev, `accessType=${ev.accessType} -> ${problem.error}`));
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("[migrateAccessType] Error:", e?.message || e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
