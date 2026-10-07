// scripts/backfillPhotoCriteria.js
// Rellena photoCriteria (y photoCriteriaExclude) en las misiones de foto que lo
// tengan vacío, con un texto por defecto según el tipo (utils/photoMissions.js).
//
// Uso:  node scripts/backfillPhotoCriteria.js [--dry-run]
//
// 1) Plantillas (PromotionLevelTemplate, globales y de club).
// 2) Progresos ya creados (UserClubPromotionProgress): copian el criterio de la
//    plantilla de su club (o la global) para ese nivel y tipo; si no hay, el
//    texto por defecto del tipo.
//
// NUNCA sobrescribe un criterio que ya tenga texto: solo rellena vacíos.
// Cada escritura es atómica y condicionada a que el campo siga vacío y la
// misión siga siendo la misma, así que no pisa cambios hechos a la vez desde
// el portal.
require("dotenv").config();

const mongoose = require("mongoose");
const PromotionLevelTemplate = require("../models/PromotionLevelTemplate");
const UserClubPromotionProgress = require("../models/UserClubPromotionProgress");
const {
  isPhotoMission,
  DEFAULT_PHOTO_CRITERIA,
  DEFAULT_PHOTO_CRITERIA_EXCLUDE,
} = require("../utils/photoMissions");

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

const EMPTY = { $in: [null, ""] }; // null también casa con "campo inexistente"

function isBlank(v) {
  return !String(v || "").trim();
}

/** Clave para buscar el criterio de una plantilla: club (o global) + nivel + tipo. */
function criteriaKey(clubId, levelNumber, type) {
  return `${clubId || "global"}|${Number(levelNumber)}|${type}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await mongoose.connect(pickMongoUri());
  console.log(`[backfillPhotoCriteria] Conectado${dryRun ? " — MODO DRY-RUN, no se escribirá nada" : ""}\n`);

  const s = {
    templates: 0,
    tplPhotoMissions: 0,
    tplFilled: 0,
    tplAlreadyOk: 0,
    tplConflicts: 0,
    progress: 0,
    progPhotoMissions: 0,
    progFilled: 0,
    progAlreadyOk: 0,
    progConflicts: 0,
    unknownType: new Set(),
  };

  // Criterio efectivo de cada plantilla (tras rellenar), para copiarlo a los progresos.
  const criteriaByKey = new Map();

  // ---------- 1) Plantillas ----------
  const templates = await PromotionLevelTemplate.find({})
    .select("_id scope club levelNumber missions")
    .lean();

  for (const tpl of templates) {
    s.templates++;
    const clubKey = tpl.scope === "club" && tpl.club ? String(tpl.club) : null;

    for (let i = 0; i < (tpl.missions || []).length; i++) {
      const m = tpl.missions[i];
      if (!isPhotoMission(m)) continue;
      s.tplPhotoMissions++;

      let criteria = String(m.photoCriteria || "").trim();
      let exclude = String(m.photoCriteriaExclude || "").trim();

      if (!isBlank(criteria)) {
        s.tplAlreadyOk++;
      } else {
        criteria = DEFAULT_PHOTO_CRITERIA[m.type] || "";
        if (!criteria) {
          s.unknownType.add(m.type);
          continue;
        }
        if (isBlank(exclude)) exclude = DEFAULT_PHOTO_CRITERIA_EXCLUDE;

        const label = `[plantilla ${tpl.scope}${clubKey ? " " + clubKey : ""} L${tpl.levelNumber}] ${m.type} "${m.title || ""}"`;
        if (dryRun) {
          console.log(`${label} -> [dry-run] photoCriteria = "${criteria}"`);
          s.tplFilled++;
        } else {
          const set = { [`missions.${i}.photoCriteria`]: criteria };
          if (isBlank(m.photoCriteriaExclude)) set[`missions.${i}.photoCriteriaExclude`] = exclude;
          const r = await PromotionLevelTemplate.updateOne(
            {
              _id: tpl._id,
              [`missions.${i}._id`]: m._id,
              [`missions.${i}.photoCriteria`]: EMPTY,
            },
            { $set: set }
          );
          if ((r.n ?? r.matchedCount) === 1) {
            s.tplFilled++;
            console.log(`${label} -> rellenado`);
          } else {
            s.tplConflicts++;
            console.log(`${label} -> NO escrito (cambió mientras tanto)`);
          }
        }
      }

      // Primer criterio no vacío por (club, nivel, tipo)
      const key = criteriaKey(clubKey, tpl.levelNumber, m.type);
      if (!criteriaByKey.has(key)) criteriaByKey.set(key, { criteria, exclude });
    }
  }

  // ---------- 2) Progresos ----------
  const cursor = UserClubPromotionProgress.find({})
    .select("_id user club levels.levelNumber levels.missions")
    .lean()
    .cursor();

  for await (const prog of cursor) {
    s.progress++;
    const clubKey = prog.club ? String(prog.club) : null;

    for (let li = 0; li < (prog.levels || []).length; li++) {
      const level = prog.levels[li];
      for (let mi = 0; mi < (level.missions || []).length; mi++) {
        const m = level.missions[mi];
        if (!isPhotoMission(m)) continue;
        s.progPhotoMissions++;

        if (!isBlank(m.photoCriteria)) {
          s.progAlreadyOk++;
          continue;
        }

        const fromTpl =
          criteriaByKey.get(criteriaKey(clubKey, level.levelNumber, m.type)) ||
          criteriaByKey.get(criteriaKey(null, level.levelNumber, m.type));
        const criteria = fromTpl?.criteria || DEFAULT_PHOTO_CRITERIA[m.type] || "";
        if (!criteria) {
          s.unknownType.add(m.type);
          continue;
        }
        const exclude = fromTpl?.exclude || DEFAULT_PHOTO_CRITERIA_EXCLUDE;

        if (dryRun) {
          s.progFilled++;
          continue; // en progresos no listamos uno a uno (pueden ser miles)
        }

        const base = `levels.${li}.missions.${mi}`;
        const set = { [`${base}.photoCriteria`]: criteria };
        if (isBlank(m.photoCriteriaExclude)) set[`${base}.photoCriteriaExclude`] = exclude;
        const r = await UserClubPromotionProgress.updateOne(
          {
            _id: prog._id,
            [`${base}.missionKey`]: m.missionKey,
            [`${base}.photoCriteria`]: EMPTY,
          },
          { $set: set }
        );
        if ((r.n ?? r.matchedCount) === 1) s.progFilled++;
        else s.progConflicts++;
      }
    }
  }

  console.log(`
═══ Resumen${dryRun ? " (DRY-RUN: nada escrito)" : ""} ═══
  Plantillas revisadas:              ${s.templates}
    misiones de foto:                ${s.tplPhotoMissions}
    ya tenían criterio:              ${s.tplAlreadyOk}
    ${dryRun ? "se rellenarían" : "rellenadas"}:                    ${s.tplFilled}
    no escritas por conflicto:       ${s.tplConflicts}
  Progresos revisados:               ${s.progress}
    misiones de foto:                ${s.progPhotoMissions}
    ya tenían criterio:              ${s.progAlreadyOk}
    ${dryRun ? "se rellenarían" : "rellenadas"}:                    ${s.progFilled}
    no escritas por conflicto:       ${s.progConflicts}
  Tipos de foto sin texto por defecto: ${s.unknownType.size ? [...s.unknownType].join(", ") : "ninguno"}
`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[backfillPhotoCriteria] Error fatal:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
