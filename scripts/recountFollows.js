// scripts/recountFollows.js
// Recalcula followersCount y followingCount de cada usuario a partir de sus
// arrays followers / following (seguidores distintos). Los contadores se
// desajustaban porque seguir / dejar de seguir hacían $inc incondicional
// (arreglado en controllers/socialController.js).
//
// Uso:  node scripts/recountFollows.js [--dry-run] [--verbose]
//
//   --dry-run   no escribe nada: enseña cuántos y cuáles cambiarían
//   --verbose   una línea por usuario que cambia (también sin --dry-run)
//
// Solo toca los dos contadores; NUNCA los arrays (los seguimientos no cambian).
// Cada escritura está condicionada a que los contadores sigan valiendo lo que
// se leyó: si alguien sigue o deja de seguir a la vez, ese usuario se omite y
// se puede relanzar. Además informa (sin tocarlo) de seguimientos asimétricos:
// A tiene a B en following pero B no tiene a A en followers, o al revés.
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

const distinctCount = (arr) => new Set((Array.isArray(arr) ? arr : []).map(String)).size;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose") || dryRun;
  await mongoose.connect(pickMongoUri());
  console.log(`[recountFollows] Conectado${dryRun ? " — MODO DRY-RUN, no se escribirá nada" : ""}\n`);

  const s = { reviewed: 0, wrong: 0, fixed: 0, skipped: 0, negative: 0, followersDelta: 0, followingDelta: 0 };

  // Para detectar asimetrías: quién sigue a quién según cada lado
  const followingPairs = new Set(); // "A>B": A tiene a B en following
  const followerPairs = new Set();  // "A>B": B tiene a A en followers

  const cursor = User.collection.find(
    {},
    { projection: { followers: 1, following: 1, followersCount: 1, followingCount: 1 } }
  );

  for await (const u of cursor) {
    s.reviewed++;
    const id = String(u._id);
    for (const f of u.following || []) followingPairs.add(`${id}>${String(f)}`);
    for (const f of u.followers || []) followerPairs.add(`${String(f)}>${id}`);

    const realFollowers = distinctCount(u.followers);
    const realFollowing = distinctCount(u.following);
    const curFollowers = u.followersCount;
    const curFollowing = u.followingCount;
    if (curFollowers === realFollowers && curFollowing === realFollowing) continue;

    s.wrong++;
    if ((curFollowers ?? 0) < 0 || (curFollowing ?? 0) < 0) s.negative++;
    s.followersDelta += realFollowers - (curFollowers ?? 0);
    s.followingDelta += realFollowing - (curFollowing ?? 0);
    if (verbose) {
      console.log(
        `  user=${id}: seguidores ${curFollowers ?? "—"} -> ${realFollowers} | seguidos ${curFollowing ?? "—"} -> ${realFollowing}`
      );
    }
    if (dryRun) continue;

    const r = await User.collection.updateOne(
      { _id: u._id, followersCount: curFollowers, followingCount: curFollowing },
      { $set: { followersCount: realFollowers, followingCount: realFollowing } }
    );
    if (r.modifiedCount) s.fixed++;
    else s.skipped++;
  }

  let asymFollowing = 0;
  for (const p of followingPairs) if (!followerPairs.has(p)) asymFollowing++;
  let asymFollowers = 0;
  for (const p of followerPairs) if (!followingPairs.has(p)) asymFollowers++;

  console.log(`\n===== Resumen${dryRun ? " (DRY-RUN: no se ha guardado nada)" : ""} =====`);
  console.log(`Usuarios revisados:                ${s.reviewed}`);
  console.log(`Con contadores desajustados:       ${s.wrong}`);
  console.log(`  de ellos con algún contador < 0: ${s.negative}`);
  console.log(`  ajuste total seguidores:         ${s.followersDelta >= 0 ? "+" : ""}${s.followersDelta}`);
  console.log(`  ajuste total seguidos:           ${s.followingDelta >= 0 ? "+" : ""}${s.followingDelta}`);
  if (!dryRun) {
    console.log(`Corregidos:                        ${s.fixed}`);
    console.log(`Omitidos (cambiaron a la vez):     ${s.skipped}  -> relanzar`);
  }
  console.log(`Seguimientos asimétricos (no se tocan):`);
  console.log(`  en "following" sin su "followers": ${asymFollowing}`);
  console.log(`  en "followers" sin su "following": ${asymFollowers}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("[recountFollows] Error:", e?.message || e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
