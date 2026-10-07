// utils/photoMissions.js
// ÚNICA definición de "misión de foto": por LISTA DE TIPOS, nunca por texto.
// (Antes se buscaba 'photo' / 'foto' / 'selfie' en el tipo o el TÍTULO, así que
// renombrar una misión cambiaba su comportamiento.)

/** Tipos de misión que se completan subiendo una foto. */
const PHOTO_MISSION_TYPES = Object.freeze([
  'upload_event_photo',
  'approved_event_photo',
  'group_photo_with_followed',
  'theme_photo',
  'photocall_photo',
  'show_prizes_photo',
  'stamps_competition', // "Sube una foto con el sello en la cara"
]);

const PHOTO_MISSION_TYPE_SET = new Set(PHOTO_MISSION_TYPES);

/** ¿Es una misión de foto? Acepta la misión (con .type) o directamente el tipo. */
function isPhotoMission(missionOrType) {
  const type =
    typeof missionOrType === 'string' ? missionOrType : missionOrType && missionOrType.type;
  return PHOTO_MISSION_TYPE_SET.has(String(type || '').trim());
}

// Longitudes de photoCriteria (el máximo coincide con el esquema).
const PHOTO_CRITERIA_MIN_LENGTH = 15; // "foto guapa" no sirve como criterio
const PHOTO_CRITERIA_MAX_LENGTH = 300;
const PHOTO_CRITERIA_EXCLUDE_MAX_LENGTH = 200;

/**
 * Criterio por defecto según el tipo: lo usan las plantillas por defecto y la
 * migración scripts/backfillPhotoCriteria.js. El club puede cambiarlo.
 */
const DEFAULT_PHOTO_CRITERIA = Object.freeze({
  upload_event_photo:
    'Una foto tomada dentro del local durante el evento, donde se vea el ambiente de la noche.',
  approved_event_photo:
    'Una foto tomada dentro del local durante el evento, donde se vea el ambiente de la noche.',
  group_photo_with_followed:
    'Una foto donde aparezcan al menos tres personas juntas dentro del local.',
  theme_photo:
    'Una foto de al menos dos personas vestidas o caracterizadas según la temática del evento, dentro del local.',
  photocall_photo:
    'Una foto de al menos dos personas posando delante del photocall del local.',
  show_prizes_photo:
    'Una foto donde se vean claramente premios o recompensas conseguidas en el club (pulseras, consumiciones, entradas o similares).',
  stamps_competition:
    'Una foto de la cara de la persona donde se vean claramente los sellos conseguidos durante el evento.',
});

/** Exclusión por defecto (común a todos los tipos). */
const DEFAULT_PHOTO_CRITERIA_EXCLUDE =
  'Capturas de pantalla, fotos de otra pantalla o imágenes descargadas de internet.';

module.exports = {
  PHOTO_MISSION_TYPES,
  isPhotoMission,
  PHOTO_CRITERIA_MIN_LENGTH,
  PHOTO_CRITERIA_MAX_LENGTH,
  PHOTO_CRITERIA_EXCLUDE_MAX_LENGTH,
  DEFAULT_PHOTO_CRITERIA,
  DEFAULT_PHOTO_CRITERIA_EXCLUDE,
};
