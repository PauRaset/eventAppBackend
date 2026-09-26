// scripts/geocodeExistingEvents.js
// Migración de un solo uso: geocodifica los eventos sin coordenadas.
// Uso:  node scripts/geocodeExistingEvents.js [--dry-run]
require("dotenv").config();

const mongoose = require("mongoose");
const Event = require("../models/Event");
const { geocodeAddress, applyGeo, buildAddress } = require("../utils/geocode");

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

// Pausa entre peticiones: Nominatim limita a 1 req/s, así que usamos 1100 ms.
const DELAY_MS = 1100;
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) console.log("[geocode] MODO DRY-RUN — no se escribirá nada\n");

  await mongoose.connect(pickMongoUri(), {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("[geocode] Conectado a MongoDB");

  // Eventos pendientes: sin coordenadas, o con geoStatus pending/failed
  const filter = {
    $or: [
      { "location.coordinates": { $exists: false } },
      { geoStatus: { $in: ["pending", "failed"] } },
    ],
  };

  const total = await Event.countDocuments(filter);
  console.log(`[geocode] Eventos a procesar: ${total}\n`);

  if (total === 0) {
    console.log("[geocode] Nada que migrar. Fin.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const cursor = Event.find(filter)
    .select("_id title city street postalCode geoSourceAddress")
    .lean()
    .cursor();

  let i = 0;
  let okCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for await (const event of cursor) {
    i++;
    const { _id, title, city, street, postalCode } = event;
    const label = `[${i}/${total}] "${title || _id}"`;

    const addr = buildAddress({ street, postalCode, city });
    if (!addr || addr.split(",").length < 2) {
      console.log(`${label} -> SALTADO (dirección insuficiente: "${addr}")`);
      skippedCount++;
      continue;
    }

    if (dryRun) {
      console.log(`${label} -> [dry-run] geocodificaría "${addr}"`);
      // Contamos como si fueran ok para que el resumen sea útil
      okCount++;
      continue;
    }

    const geo = await geocodeAddress({ street, postalCode, city });

    const patch = {};
    applyGeo(patch, geo, addr);

    await Event.updateOne({ _id }, { $set: patch });

    const status = geo ? "ok" : "failed";
    console.log(`${label} -> ${status}${geo ? ` (${geo.provider})` : ""}`);
    if (geo) okCount++; else failedCount++;

    // Pausa para respetar el rate limit de Nominatim
    await sleep(DELAY_MS);
  }

  console.log(`
═══ Resumen ═══
  ok:      ${okCount}
  failed:  ${failedCount}
  saltados (dirección insuficiente): ${skippedCount}
  total:   ${total}
`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[geocode] Error fatal:", err);
  process.exit(1);
});
