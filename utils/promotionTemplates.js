// utils/promotionTemplates.js
// ÚNICO criterio para decidir sobre qué plantillas se calcula el progreso de un
// usuario en un club: las del club (scope 'club') si tiene alguna activa; si no,
// las globales. Lo usan routes/eventRoutes.js (QR, asistencia, fotos, referidos)
// y controllers/promotionsController.js (la app y el portal), para que el
// progreso no dependa de por dónde entra el usuario.
const mongoose = require('mongoose');
const PromotionLevelTemplate = require('../models/PromotionLevelTemplate');

/**
 * Plantillas activas para el club, ordenadas por levelNumber (lean).
 * Devuelve [] si no hay ni del club ni globales, y lo deja en el log: sin
 * plantillas no se puede crear progreso y el usuario se quedaría sin él.
 * `source` solo sirve para el log (quién lo pidió).
 */
async function getTemplatesForClub(clubId, { source = '' } = {}) {
  const key = String(clubId || '');

  // Solo un ObjectId puede tener plantillas propias (club es ObjectId en el modelo)
  if (mongoose.isValidObjectId(key)) {
    const clubTemplates = await PromotionLevelTemplate.find({ scope: 'club', club: key, active: true }).lean();
    if (clubTemplates.length) {
      return clubTemplates.sort((a, b) => a.levelNumber - b.levelNumber);
    }
  }

  const globalTemplates = await PromotionLevelTemplate.find({ scope: 'global', active: true }).lean();
  if (!globalTemplates.length) {
    console.error('🚨 [promotions] SIN PLANTILLAS: ni del club ni globales; no se puede crear progreso. Sembrar el catálogo.', {
      clubId: key,
      source,
    });
    return [];
  }
  return globalTemplates.sort((a, b) => a.levelNumber - b.levelNumber);
}

module.exports = { getTemplatesForClub };
