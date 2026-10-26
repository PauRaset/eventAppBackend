// scripts/backfillAccumulatedMissions.js
// Repasa TODOS los progresos de promociones (UserClubPromotionProgress) y les
// aplica el acumulado por club de las misiones acumuladas (scan_qr,
// attend_event, share_event, link_clicks, referred_purchases), recalculado
// desde los datos con syncAccumulatedMissions (routes/eventRoutes.js).
// Lanzarlo DESPUÉS de sembrar el catálogo nuevo.
//
// Uso:  node scripts/backfillAccumulatedMissions.js [--dry-run] [--verbose] [--club <id>]
//
//   --dry-run   SIMULACIÓN: no escribe nada y lista, uno por uno, los usuarios,
//               clubs, niveles y misiones que cambiarían (completar y revertir)
//   --verbose   esa misma lista también sin --dry-run
//   --club <id> solo los progresos de ese club
//
// Seguro de relanzar: es idempotente (recalcula, no suma). No crea progresos
// nuevos, no toca lastActivityAt y solo guarda los que cambian.
//  - Niveles con el premio CANJEADO: nunca se tocan.
//  - attend_event y referred_purchases pueden REVERTIR: si ya no se cumplen
//    (asistencia desmarcada, reembolso) la misión vuelve a pendiente y, si el
//    nivel estaba completado sin canjear, vuelve a en curso.
//  - scan_qr, share_event y link_clicks: una misión completada no se deshace.
// Los niveles bloqueados reciben el contador pero no se completan hasta que el
// usuario llegue a ellos (canje del premio anterior).
require("dotenv").config();

const mongoose = require("mongoose");
const UserClubPromotionProgress = require("../models/UserClubPromotionProgress");
// Carga perezosa del router solo por sus helpers (no arranca servidor).
const { syncAccumulatedMissions } = require("../routes/eventRoutes");

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

function parseArgs(argv) {
  const args = { dryRun: false, verbose: false, club: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--club") {
      args.club = argv[++i];
      if (!mongoose.isValidObjectId(String(args.club || ""))) throw new Error("--club necesita un id válido");
    } else throw new Error(`Opción desconocida: ${a}`);
  }
  return args;
}

/** Qué ha cambiado entre dos fotos del progreso (snapshotProgress). */
function diffSnapshots(before, after) {
  const out = {
    completedMissions: [],
    revertedMissions: [],
    completedLevels: [],
    revertedLevels: [],
    counterChanges: 0,
    levelFrom: null,
    levelTo: null,
  };
  const beforeLevels = new Map(before.levels.map((l) => [l.levelNumber, l]));

  for (const lvl of after.levels) {
    const prevLvl = beforeLevels.get(lvl.levelNumber);
    if (!prevLvl) continue;
    if (prevLvl.status !== "completed" && lvl.status === "completed") out.completedLevels.push(lvl.levelNumber);
    if (prevLvl.status === "completed" && lvl.status !== "completed") out.revertedLevels.push(lvl.levelNumber);

    const prevMissions = new Map(prevLvl.missions.map((m) => [m.missionKey, m]));
    for (const m of lvl.missions) {
      const prev = prevMissions.get(m.missionKey);
      if (!prev) continue;
      if (prev.status !== "completed" && m.status === "completed") {
        out.completedMissions.push({ level: lvl.levelNumber, type: m.type, current: m.current, target: m.target });
      } else if (prev.status === "completed" && m.status !== "completed") {
        out.revertedMissions.push({ level: lvl.levelNumber, type: m.type, from: prev.current, current: m.current, target: m.target });
      } else if (prev.current !== m.current) {
        out.counterChanges++;
      }
    }
  }
  if (before.currentLevel !== after.currentLevel) {
    out.levelFrom = before.currentLevel;
    out.levelTo = after.currentLevel;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mongoose.connect(pickMongoUri());
  console.log(
    `[backfillAccumulatedMissions] Conectado${args.dryRun ? " — MODO DRY-RUN, no se escribirá nada" : ""}\n`
  );

  const s = {
    reviewed: 0,
    changed: 0,
    unchanged: 0,
    errors: 0,
    errorReasons: new Map(),
    completedByLevelType: new Map(), // "L2 scan_qr" -> n
    revertedByLevelType: new Map(),  // "L1 attend_event" -> n
    completedMissions: 0,
    revertedMissions: 0,
    completedLevels: 0,
    revertedLevels: 0,
    levelMoves: 0,
    counterOnly: 0, // cambian contadores pero no se completa nada
  };

  const filter = args.club ? { club: args.club } : {};
  const cursor = UserClubPromotionProgress.find(filter).select("_id user club").lean().cursor();

  // Uno a uno: no compite con el tráfico real (y si choca, syncAccumulatedMissions reintenta).
  for await (const doc of cursor) {
    s.reviewed++;
    const userId = String(doc.user);
    const clubKey = String(doc.club);

    const res = await syncAccumulatedMissions({ userId, clubKey, dryRun: args.dryRun, backfill: true });
    if (!res || res.error) {
      s.errors++;
      const reason = (res && res.error) || "unknown";
      s.errorReasons.set(reason, (s.errorReasons.get(reason) || 0) + 1);
      console.warn(`  ⚠️ error user=${userId} club=${clubKey}: ${reason}`);
      continue;
    }
    if (!res.changed) {
      s.unchanged++;
      continue;
    }

    s.changed++;
    const d = diffSnapshots(res.before, res.after);
    for (const m of d.completedMissions) {
      const k = `L${m.level} ${m.type}`;
      s.completedByLevelType.set(k, (s.completedByLevelType.get(k) || 0) + 1);
    }
    for (const m of d.revertedMissions) {
      const k = `L${m.level} ${m.type}`;
      s.revertedByLevelType.set(k, (s.revertedByLevelType.get(k) || 0) + 1);
    }
    s.completedMissions += d.completedMissions.length;
    s.revertedMissions += d.revertedMissions.length;
    s.completedLevels += d.completedLevels.length;
    s.revertedLevels += d.revertedLevels.length;
    if (d.levelFrom !== null) s.levelMoves++;
    if (!d.completedMissions.length && !d.revertedMissions.length) s.counterOnly++;

    if (args.verbose || args.dryRun) {
      const parts = [];
      if (d.completedMissions.length) {
        parts.push(`completa ${d.completedMissions.map((m) => `L${m.level} ${m.type} ${m.current}/${m.target}`).join(", ")}`);
      }
      if (d.revertedMissions.length) {
        parts.push(`REVIERTE ${d.revertedMissions.map((m) => `L${m.level} ${m.type} ${m.from}->${m.current}/${m.target}`).join(", ")}`);
      }
      if (d.completedLevels.length) parts.push(`niveles completados: ${d.completedLevels.join(", ")}`);
      if (d.revertedLevels.length) parts.push(`niveles que vuelven a en curso (premio sin canjear): ${d.revertedLevels.join(", ")}`);
      if (d.levelFrom !== null) parts.push(`nivel actual ${d.levelFrom} -> ${d.levelTo}`);
      if (d.counterChanges) parts.push(`${d.counterChanges} contador(es) actualizados`);
      if (!parts.length) parts.push("contadores informativos (qrScansInClub / attendancesInClub)");
      console.log(`  user=${userId} club=${clubKey}: ${parts.join(" | ")}`);
    }

    if (s.reviewed % 200 === 0) console.log(`  … ${s.reviewed} revisados`);
  }

  console.log(`\n===== Resumen${args.dryRun ? " (DRY-RUN: no se ha guardado nada)" : ""} =====`);
  console.log(`Progresos revisados:            ${s.reviewed}`);
  console.log(`  ${args.dryRun ? "cambiarían" : "cambiados"}:                     ${s.changed}`);
  console.log(`  sin cambios:                  ${s.unchanged}`);
  console.log(`  con error:                    ${s.errors}`);
  for (const [reason, n] of s.errorReasons) console.log(`    - ${reason}: ${n}`);
  console.log(`  solo contadores (nada completado ni revertido): ${s.counterOnly}`);
  console.log(`Misiones completadas al aplicar el acumulado: ${s.completedMissions}`);
  const rows = [...s.completedByLevelType.entries()].sort((a, b) => {
    const la = Number(a[0].slice(1, a[0].indexOf(" "))), lb = Number(b[0].slice(1, b[0].indexOf(" ")));
    return la - lb || a[0].localeCompare(b[0]);
  });
  for (const [k, n] of rows) console.log(`    - ${k}: ${n}`);
  console.log(`Misiones que se REVIERTEN (attend_event / referred_purchases): ${s.revertedMissions}`);
  const revRows = [...s.revertedByLevelType.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  for (const [k, n] of revRows) console.log(`    - ${k}: ${n}`);
  console.log(`Niveles completados:            ${s.completedLevels}`);
  console.log(`Niveles que vuelven a en curso: ${s.revertedLevels}`);
  console.log(`Progresos que cambian de nivel actual: ${s.levelMoves}`);
  console.log(
    "\nNota: en niveles BLOQUEADOS solo se actualiza el contador; se completan cuando el usuario\n" +
      "llega a ellos (al canjear el premio anterior), así que no aparecen como completados aquí."
  );

  await mongoose.disconnect();
  // El router deja cosas cargadas (colas, clientes): salir explícitamente.
  process.exit(0);
}

main().catch(async (e) => {
  console.error("[backfillAccumulatedMissions] Error:", e?.message || e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
