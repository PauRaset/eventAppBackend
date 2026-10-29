// scripts/findDuplicateUsernames.js
// Cuenta y lista los usernames repetidos SIN distinguir mayúsculas ("Pau" y
// "pau" cuentan como el mismo). Paso previo a un índice único: mientras haya
// duplicados no se puede crear.
//
// Uso:  node scripts/findDuplicateUsernames.js [--dry-run]
//
//   --dry-run   igual que sin él: este script NUNCA escribe nada (solo lee).
//               Se acepta por coherencia con el resto de scripts.
//
// Por privacidad solo imprime _id (nunca el username, el teléfono ni el email).
// Cada grupo se identifica por un número; dentro, los _id ordenados de más
// antiguo a más reciente (el primero suele ser el "dueño" legítimo).
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await mongoose.connect(pickMongoUri());
  console.log(`[findDuplicateUsernames] Conectado — solo lectura${dryRun ? " (DRY-RUN)" : ""}\n`);

  // Agrupa con la misma comparación que usa la app (collation en, strength 2)
  const groups = await User.collection
    .aggregate(
      [
        { $match: { username: { $type: "string", $ne: "" } } },
        { $sort: { createdAt: 1, _id: 1 } },
        { $group: { _id: "$username", ids: { $push: "$_id" }, roles: { $push: "$role" }, n: { $sum: 1 } } },
      ],
      { collation: { locale: "en", strength: 2 }, allowDiskUse: true }
    )
    .toArray();

  const dups = groups.filter((g) => g.n > 1);
  let users = 0;
  let withClub = 0;
  dups.forEach((g, i) => {
    users += g.n;
    const hasClub = g.roles.includes("club");
    if (hasClub) withClub++;
    console.log(`  grupo ${i + 1} (${g.n} cuentas${hasClub ? ", incluye un club" : ""}):`);
    g.ids.forEach((id, j) => console.log(`    ${j === 0 ? "más antigua" : "           "} _id=${id}${g.roles[j] === "club" ? " (club)" : ""}`));
  });

  console.log(`\n===== Resumen (no se ha modificado nada) =====`);
  console.log(`Usernames distintos (sin mayúsculas):  ${groups.length}`);
  console.log(`Repetidos:                              ${dups.length}`);
  console.log(`  cuentas afectadas:                    ${users}`);
  console.log(`  grupos que incluyen un club:          ${withClub}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("[findDuplicateUsernames] Error:", e?.message || e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
