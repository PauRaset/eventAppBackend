// utils/rewardTypes.js
// Tipos de PREMIO de un nivel: conjunto cerrado (la app pinta un icono por
// tipo) más 'custom' para cualquier otra cosa. `value` es la CANTIDAD
// (chupitos, copas, entradas, noches sin cola, botellas).
//
// Lo usan el modelo (enum), el controlador (normalizar y validar al guardar
// niveles) y la respuesta de configuración al portal (lista para el selector).

const REWARD_TYPES = ['shot', 'drink', 'free_entry', 'skip_line', 'bottle', 'custom'];

// Texto para el selector del portal y para el título autogenerado.
// [singular, plural]; null en custom (no se autogenera).
const REWARD_LABELS = {
  shot: { label: 'Chupito', one: 'chupito', many: 'chupitos' },
  drink: { label: 'Copa', one: 'Copa gratis', many: 'copas gratis' },
  free_entry: { label: 'Entrada gratis', one: 'Entrada gratis', many: 'entradas gratis' },
  skip_line: { label: 'Sin cola', one: 'Sin cola una noche', many: 'noches sin cola' },
  bottle: { label: 'Botella / mesa', one: 'Botella', many: 'botellas' },
  custom: { label: 'Otro (texto libre)', one: null, many: null },
};

// Tipos antiguos que ya no existen: se guardan como 'custom' con su título.
const LEGACY_REWARD_TYPES = { vip_access: 'custom', trip: 'custom' };

const REWARD_TITLE_MAX = 80;
const REWARD_DESCRIPTION_MAX = 300;
const REWARD_VALUE_MAX = 100;

function normalizeRewardType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return 'custom';
  return LEGACY_REWARD_TYPES[t] || t; // un tipo desconocido se deja tal cual: lo rechaza validateReward
}

/** "1 chupito", "3 chupitos", "Copa gratis", "2 copas gratis"... null para custom. */
function autoRewardTitle(type, value) {
  const l = REWARD_LABELS[type];
  if (!l || !l.one) return null;
  const n = Number.isInteger(value) && value > 0 ? value : 1;
  if (type === 'shot') return n === 1 ? '1 chupito' : `${n} chupitos`;
  if (type === 'bottle') return n === 1 ? 'Botella' : `${n} botellas`;
  return n === 1 ? l.one : `${n} ${l.many}`;
}

/**
 * Coherencia del premio (ya normalizado). Devuelve null si está bien, o
 * { error, field, message, ... } con el primer problema.
 *  - type de la lista cerrada
 *  - custom exige título; los demás, si no traen título, se autogenera
 *  - value: entero entre 1 y 100 en los tipos cerrados; opcional en custom
 */
function validateReward(reward) {
  const r = reward || {};
  if (!REWARD_TYPES.includes(r.type)) {
    return { error: 'invalid_reward_type', field: 'reward.type', allowed: REWARD_TYPES, message: `Tipo de premio no válido: "${r.type}"` };
  }
  if (r.type === 'custom' && !String(r.title || '').trim()) {
    return { error: 'reward_title_required', field: 'reward.title', message: 'Un premio de tipo "Otro" necesita un título' };
  }
  if (String(r.title || '').length > REWARD_TITLE_MAX) {
    return { error: 'reward_title_too_long', field: 'reward.title', maxLength: REWARD_TITLE_MAX, message: `El título del premio no puede pasar de ${REWARD_TITLE_MAX} caracteres` };
  }
  if (String(r.description || '').length > REWARD_DESCRIPTION_MAX) {
    return { error: 'reward_description_too_long', field: 'reward.description', maxLength: REWARD_DESCRIPTION_MAX, message: `La descripción del premio no puede pasar de ${REWARD_DESCRIPTION_MAX} caracteres` };
  }
  const v = r.value;
  if (r.type !== 'custom') {
    if (!Number.isInteger(v) || v < 1 || v > REWARD_VALUE_MAX) {
      return { error: 'invalid_reward_value', field: 'reward.value', min: 1, max: REWARD_VALUE_MAX, message: `La cantidad del premio debe ser un número entero entre 1 y ${REWARD_VALUE_MAX}` };
    }
  } else if (v !== null && v !== undefined && (!Number.isFinite(v) || v < 0)) {
    return { error: 'invalid_reward_value', field: 'reward.value', message: 'La cantidad del premio no es válida' };
  }
  return null;
}

/** Lista para el selector del portal: [{ type, label }]. */
function rewardTypeOptions() {
  return REWARD_TYPES.map((type) => ({ type, label: REWARD_LABELS[type].label }));
}

module.exports = {
  REWARD_TYPES,
  REWARD_LABELS,
  normalizeRewardType,
  autoRewardTitle,
  validateReward,
  rewardTypeOptions,
};
