// scripts/clearAgeGate.js
// Desbloquea a mano (petición de soporte) una cuenta que tiene ageGateFailedAt:
// la marca que deja un intento de alta con edad por debajo de MIN_AGE y que
// impide volver a intentarlo. Tras borrarla, el usuario puede repetir el alta.
//
// Uso:  node scripts/clearAgeGate.js --user <_id> [--dry-run]
//
//   --user <_id>   _id de Mongo de la cuenta (obligatorio, una sola)
//   --dry-run      no escribe nada: dice si tiene la marca y si se borraría
//
// Solo imprime el _id y si tenía la marca (nunca teléfono, email ni fechas).
// No toca nada más de la cuenta (ni birthDate, que no existe en estos casos).
require("dotenv").config();

const mongoose = require("mongoose");
const User = require("../models/User");

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

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const userId = String(argValue("--user") || "").trim();
  if (!/^[a-fA-F0-9]{24}$/.test(userId)) {
    console.error("Uso: node scripts/clearAgeGate.js --user <_id de 24 hex> [--dry-run]");
    process.exit(1);
  }

  await mongoose.connect(pickMongoUri());
  console.log(`[clearAgeGate] Conectado${dryRun ? " — MODO DRY-RUN, no se escribirá nada" : ""}\n`);

  const _id = new mongoose.Types.ObjectId(userId);
  const u = await User.collection.findOne({ _id }, { projection: { ageGateFailedAt: 1 } });
  if (!u) {
    console.log(`  _id=${userId}: no existe`);
  } else if (!u.ageGateFailedAt) {
    console.log(`  _id=${userId}: no tenía la marca (nada que hacer)`);
  } else if (dryRun) {
    console.log(`  _id=${userId}: tenía la marca -> se borraría`);
  } else {
    const r = await User.collection.updateOne(
      { _id, ageGateFailedAt: { $ne: null } },
      { $set: { ageGateFailedAt: null } }
    );
    console.log(`  _id=${userId}: tenía la marca -> ${r.modifiedCount ? "borrada" : "no se pudo borrar (cambió a la vez), relanzar"}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("[clearAgeGate] Error:", e?.message || e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
