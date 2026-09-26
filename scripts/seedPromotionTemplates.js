// scripts/seedPromotionTemplates.js
require('dotenv').config();

const mongoose = require('mongoose');
const PromotionLevelTemplate = require('../models/PromotionLevelTemplate');

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL;

const DEFAULT_VERSION = 1;

function pickMongoUri() {
  if (!MONGO_URI) {
    throw new Error(
      'Missing MONGO_URI (or MONGODB_URI / DATABASE_URL) in environment.'
    );
  }
  return MONGO_URI;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force'); // si quieres forzar overwrite siempre

  const uri = pickMongoUri();

  console.log('[seed] Connecting to Mongo...');
  await mongoose.connect(uri, {
    autoIndex: false, // en prod normalmente false; el índice unique ya lo crea tu app
  });

  // Asegura que el modelo está listo (crea indexes si en tu app no lo hace)
  // Ojo: si tu app ya gestiona indexes, puedes comentar esto.
  try {
    await PromotionLevelTemplate.init();
  } catch (e) {
    console.warn('[seed] Warning: model init/indexes:', e.message || e);
  }

  const templates = PromotionLevelTemplate.getDefaultTemplates().map((t) => ({
    ...t,
    version: t.version ?? DEFAULT_VERSION,
    scope: 'global',
    club: null,
    active: t.active ?? true,
  }));

  console.log(`[seed] Default templates: ${templates.length}`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const t of templates) {
    const filter = {
      scope: 'global',
      club: null,
      levelNumber: t.levelNumber,
    };

    const existing = await PromotionLevelTemplate.findOne(filter).lean();

    // Regla: si existe y no force, solo actualiza si la version entrante es mayor
    const shouldUpdate =
      force ||
      !existing ||
      Number(t.version || 0) > Number(existing.version || 0);

    if (!shouldUpdate) {
      skipped++;
      console.log(
        `[seed] SKIP level ${t.levelNumber} (existing v${existing.version} >= incoming v${t.version})`
      );
      continue;
    }

    if (dryRun) {
      console.log(
        `[seed] DRY-RUN ${existing ? 'UPDATE' : 'CREATE'} level ${t.levelNumber} (v${t.version})`
      );
      continue;
    }

    const updateDoc = {
      $set: {
        scope: 'global',
        club: null,
        levelNumber: t.levelNumber,
        title: t.title,
        description: t.description || '',
        missions: t.missions || [],
        reward: t.reward,
        active: t.active ?? true,
        version: t.version ?? DEFAULT_VERSION,
      },
    };

    const result = await PromotionLevelTemplate.updateOne(filter, updateDoc, {
      upsert: true,
    });

    // Mongoose updateOne no siempre da created/updated claro, lo inferimos:
    if (!existing) created++;
    else updated++;

    console.log(
      `[seed] ${existing ? 'UPDATED' : 'CREATED'} level ${t.levelNumber} (v${t.version})`
    );
  }

  console.log('---');
  console.log(
    `[seed] Done. created=${created}, updated=${updated}, skipped=${skipped}, dryRun=${dryRun}, force=${force}`
  );

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[seed] Failed:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
