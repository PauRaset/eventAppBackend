// scripts/migratePhoneUsernames.js
// Sustituye los usernames GUARDADOS que se generaron a partir del teléfono
// ("user_" + los 6 últimos dígitos del teléfono del propio usuario) por el
// alias neutro de utils/publicName.js ("user_" + 6 caracteres de un hash del _id).
//
// Uso:  node scripts/migratePhoneUsernames.js [--dry-run]
//
//   --dry-run   no escribe nada: cuenta y lista los _id afectados
//
// Solo toca usernames que cumplen las DOS condiciones:
//   1) son exactamente "user_" + 6 dígitos, y
//   2) esos 6 dígitos son los 6 últimos del teléfono de ESE usuario.
// Cualquier username elegido por el usuario (aunque contenga dígitos) se deja.
// Nunca se imprime el teléfono ni el username antiguo: solo _id.
// Cada escritura está condicionada a que el username siga siendo el leído
// (si el usuario lo cambia a la vez, no se pisa). Seguro de relanzar.
require("dotenv").config();

const mongoose = require("mongoose");
const User = require("../models/User");
const { neutralAlias } = require("../utils/publicName");

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

const GENERATED_RE = /^user_(\d{6})$/;

function isGeneratedFromPhone(username, phoneNumber) {
  const m = GENERATED_RE.exec(String(username || ""));
  if (!m) return false;
  const digits = String(phoneNumber || "").replace(/\D/g, "");
  return digits.length >= 6 && digits.slice(-6) === m[1];
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await mongoose.connect(pickMongoUri());
  console.log(`[migratePhoneUsernames] Conectado${dryRun ? " — MODO DRY-RUN, no se escribirá nada" : ""}\n`);

  const s = { candidates: 0, affected: 0, updated: 0, skipped: 0 };

  // Solo los que tienen la forma "user_" + 6 dígitos (el resto ni se lee)
  const cursor = User.collection.find(
    { username: { $regex: /^user_\d{6}$/ } },
    { projection: { username: 1, phoneNumber: 1 } }
  );

  for await (const u of cursor) {
    s.candidates++;
    if (!isGeneratedFromPhone(u.username, u.phoneNumber)) continue; // elegido por el usuario: no se toca
    s.affected++;
    const alias = neutralAlias(u._id);
    console.log(`  ${dryRun ? "cambiaría" : "cambia"} _id=${u._id}`);
    if (dryRun) continue;

    const r = await User.collection.updateOne(
      { _id: u._id, username: u.username },
      { $set: { username: alias } }
    );
    if (r.modifiedCount) s.updated++;
    else s.skipped++;
  }

  console.log(`\n===== Resumen${dryRun ? " (DRY-RUN: no se ha guardado nada)" : ""} =====`);
  console.log(`Con forma "user_" + 6 dígitos:              ${s.candidates}`);
  console.log(`  sacados del teléfono de ese usuario:      ${s.affected}`);
  console.log(`  elegidos por el usuario (no se tocan):     ${s.candidates - s.affected}`);
  if (!dryRun) {
    console.log(`Actualizados al alias neutro:               ${s.updated}`);
    console.log(`Omitidos (el username cambió a la vez):     ${s.skipped}  -> relanzar`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("[migratePhoneUsernames] Error:", e?.message || e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
