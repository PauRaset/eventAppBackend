// models/PromotionLevelTemplate.js
const mongoose = require('mongoose');
const {
  isPhotoMission,
  DEFAULT_PHOTO_CRITERIA,
  DEFAULT_PHOTO_CRITERIA_EXCLUDE,
} = require('../utils/photoMissions');

const { Schema } = mongoose;

/**
 * Tipos de misión (extensible)
 * - attend_event: asistir a X eventos
 * - upload_event_photo: subir fotos (por evento o total)
 * - follow_users: seguir a X usuarios
 * - group_photo_with_followed: foto de grupo con usuarios seguidos (suele requerir validación)
 * - scan_qr: escanear QR dentro del local
 * - theme_photo: foto con temática/disfraz
 * - photocall_photo: foto en photocall
 * - show_prizes_photo: foto mostrando premios obtenidos
 * - stamps_competition: dinámica competitiva (club decide ganador)
 */
const MISSION_TYPES = [
  'attend_event',
  'upload_event_photo',
  'approved_event_photo',
  'follow_users',
  'group_photo_with_followed',
  'scan_qr',
  'theme_photo',
  'photocall_photo',
  'show_prizes_photo',
  'stamps_competition',
  'share_event',
  'link_clicks',
  'unique_visits',
  'referred_purchases',
];

/**
 * Tipos de recompensa (extensible)
 */
const REWARD_TYPES = [
  'shot',            // chupito
  'drink',           // consumición
  'free_entry',      // entrada gratis
  'vip_access',      // acceso vip
  'bottle',          // botella
  'trip',            // viaje/premio grande
  'custom',          // texto libre
];

const LEVEL_STATUS = ['draft', 'active', 'paused'];
const LEVEL_DIFFICULTY = ['easy', 'medium', 'hard', 'extreme'];
const VALIDATION_TYPES = ['automatic', 'manual', 'link_tracking', 'hybrid'];

const MissionSchema = new Schema({
  // Clave ESTABLE de la misión: la usan el progreso de cada usuario, las fotos
  // (missionId) y las reclamaciones. Se genera una vez y se conserva al guardar
  // niveles desde el portal (assignMissionKeys), aunque cambie el _id.
  missionKey: { type: String, default: '' },

  // Tipo de misión (enum estable para backend/app)
  type: { type: String, enum: MISSION_TYPES, required: true },

  // Texto visible en app/panel
  title: { type: String, required: true },
  description: { type: String, default: '' },

  // Objetivo numérico (ej: seguir 5 usuarios, asistir 20 eventos, etc.)
  target: { type: Number, default: 1 },

  // Unidad visible/semántica del objetivo (events, clicks, photos, users, etc.)
  unit: { type: String, default: '' },

  // Parámetros extra según misión
  params: { type: Schema.Types.Mixed, default: {} },

  // Qué debe verse en la foto para dar la misión por cumplida.
  // Lo escribe el club. Obligatorio en misiones de foto (se exige al guardar
  // niveles en PUT /api/promotions/clubs/:clubId/levels, no aquí, para no
  // romper documentos antiguos antes de la migración).
  photoCriteria: { type: String, default: '', maxlength: 300 },

  // Opcional: qué NO vale, para casos que el club quiera excluir.
  photoCriteriaExclude: { type: String, default: '', maxlength: 200 },

  // Tipo de validación para que la app/backend sepan cómo contar la misión
  validationType: {
    type: String,
    enum: VALIDATION_TYPES,
    default: 'automatic',
  },

  // Compatibilidad hacia atrás con lógica ya existente
  requiresApproval: { type: Boolean, default: false },

  // Orden dentro del nivel
  order: { type: Number, default: 0 },

  // Si está activa
  active: { type: Boolean, default: true },
});

const RewardSchema = new Schema(
  {
    type: { type: String, enum: REWARD_TYPES, default: 'custom' },

    // Texto corto (ej: "1 chupito", "Entrada gratis", "VIP x4", etc.)
    title: { type: String, required: true },

    // Detalles opcionales (ej: condiciones)
    description: { type: String, default: '' },

    // Valor numérico opcional (ej: 1 chupito -> 1, VIP x4 -> 4)
    value: { type: Number, default: null },

    // Datos extra (ej: { vipPeople: 4 }, { bottleOptions: [...] })
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const PromotionLevelTemplateSchema = new Schema(
  {
    /**
     * scope:
     * - global: niveles por defecto NightVibe
     * - club: niveles personalizados para un club concreto
     */
    scope: { type: String, enum: ['global', 'club'], default: 'global', index: true },

    // Si scope = club, referencia al club
    club: { type: Schema.Types.ObjectId, ref: 'Club', default: null, index: true },

    // Número de nivel (1..10 por defecto)
    levelNumber: { type: Number, required: true, min: 1, max: 100, index: true },

    // Orden editable dentro del sistema del club
    order: { type: Number, default: 0, index: true },

    // Nombre del nivel (visible en la app)
    title: { type: String, required: true },

    // Descripción opcional (visible en el detalle)
    description: { type: String, default: '' },

    // Dificultad visible del nivel
    difficulty: {
      type: String,
      enum: LEVEL_DIFFICULTY,
      default: 'medium',
    },

    // Lista de misiones del nivel
    missions: { type: [MissionSchema], default: [] },

    // Recompensa del nivel
    reward: { type: RewardSchema, required: true },

    // Estado del nivel en el panel/app
    status: {
      type: String,
      enum: LEVEL_STATUS,
      default: 'active',
    },

    // Compatibilidad hacia atrás con código ya existente
    active: { type: Boolean, default: true },

    // Control de visibilidad en la app
    visibleInApp: { type: Boolean, default: true },

    // Versión por si quieres migraciones futuras
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// Evita duplicados por scope/club/levelNumber
PromotionLevelTemplateSchema.index(
  { scope: 1, club: 1, levelNumber: 1 },
  { unique: true }
);

/* ------------------------------------------------------------------
   CLAVES DE MISIÓN
------------------------------------------------------------------- */
const MISSION_KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

function isValidMissionKey(key) {
  return MISSION_KEY_RE.test(String(key || ''));
}

/** Clave nueva para una misión creada desde el portal: única, legible. */
function generateMissionKey(levelNumber, type) {
  const rnd = new mongoose.Types.ObjectId().toString().slice(-8);
  return `L${Number(levelNumber) || 0}_${String(type || 'mission')}_${rnd}`;
}

/**
 * Pone missionKey a las misiones de `levels` CONSERVANDO las de `previousLevels`
 * (los niveles que había guardados). Para cada misión, en este orden:
 *   1) misma _id que una misión anterior          -> su clave
 *   2) trae una clave que existía en ese nivel    -> la mantiene
 *   3) mismo nivel + tipo + orden que una anterior -> su clave
 *   4) mismo nivel + tipo (reordenada)            -> su clave
 *   5) misión nueva                               -> clave nueva
 * Nunca repite clave dentro de un nivel. Modifica `levels` y lo devuelve.
 */
function assignMissionKeys(levels, previousLevels = []) {
  const prevById = new Map();
  const prevByLevel = new Map(); // levelNumber -> [{ missionKey, type, order }]
  for (const lvl of previousLevels || []) {
    const n = Number(lvl.levelNumber);
    for (const m of lvl.missions || []) {
      if (!isValidMissionKey(m.missionKey)) continue;
      if (m._id) prevById.set(String(m._id), m.missionKey);
      if (!prevByLevel.has(n)) prevByLevel.set(n, []);
      prevByLevel.get(n).push({ missionKey: m.missionKey, type: m.type, order: Number(m.order) });
    }
  }

  for (const lvl of levels || []) {
    const n = Number(lvl.levelNumber);
    const prev = prevByLevel.get(n) || [];
    const prevKeys = new Set(prev.map((p) => p.missionKey));
    const used = new Set();
    const take = (key) => (key && !used.has(key) ? (used.add(key), key) : null);

    for (const m of lvl.missions || []) {
      let key = null;
      if (m._id && prevById.has(String(m._id))) key = take(prevById.get(String(m._id)));
      if (!key && isValidMissionKey(m.missionKey) && prevKeys.has(m.missionKey)) key = take(m.missionKey);
      if (!key) {
        const same = prev.find((p) => p.type === m.type && p.order === Number(m.order) && !used.has(p.missionKey));
        if (same) key = take(same.missionKey);
      }
      // Reordenada desde la lista del portal: misma misión del mismo tipo en el nivel
      if (!key) {
        const sameType = prev.find((p) => p.type === m.type && !used.has(p.missionKey));
        if (sameType) key = take(sameType.missionKey);
      }
      // Clave traída de una copia (p. ej. plantillas del club copiadas de las globales)
      if (!key && isValidMissionKey(m.missionKey)) key = take(m.missionKey);
      if (!key) key = take(generateMissionKey(n, m.type));
      m.missionKey = key;
    }
  }
  return levels;
}

PromotionLevelTemplateSchema.statics.assignMissionKeys = assignMissionKeys;
PromotionLevelTemplateSchema.statics.generateMissionKey = generateMissionKey;
PromotionLevelTemplateSchema.statics.isValidMissionKey = isValidMissionKey;

// Red de seguridad para CUALQUIER escritura con validación (save, insertMany):
// ninguna misión se queda sin clave ni con una clave repetida en su nivel.
PromotionLevelTemplateSchema.pre('validate', function (next) {
  const used = new Set();
  for (const m of this.missions || []) {
    if (!m) continue;
    if (!isValidMissionKey(m.missionKey) || used.has(m.missionKey)) {
      m.missionKey = generateMissionKey(this.levelNumber, m.type);
    }
    used.add(m.missionKey);
  }
  next();
});

PromotionLevelTemplateSchema.pre('save', function (next) {
  if (typeof this.order !== 'number' || Number.isNaN(this.order)) {
    this.order = this.levelNumber;
  }

  // Mantener compatibilidad entre status y active
  if (this.status === 'paused' || this.status === 'draft') {
    this.active = false;
  } else if (this.status === 'active') {
    this.active = true;
  }

  if (!this.status) {
    this.status = this.active ? 'active' : 'paused';
  }

  if (Array.isArray(this.missions)) {
    this.missions = this.missions.map((mission, idx) => {
      const m = mission && typeof mission.toObject === 'function' ? mission.toObject() : mission;
      if (!m) return m;

      if (typeof m.order !== 'number' || Number.isNaN(m.order)) {
        m.order = idx + 1;
      }

      if (!m.validationType) {
        m.validationType = m.requiresApproval ? 'manual' : 'automatic';
      }

      if (!m.unit) {
        if (m.type === 'attend_event') m.unit = 'events';
        else if (m.type === 'follow_users') m.unit = 'users';
        else if (m.type === 'link_clicks') m.unit = 'clicks';
        else if (m.type === 'unique_visits') m.unit = 'visits';
        else if (m.type === 'referred_purchases') m.unit = 'purchases';
        else if (m.type === 'upload_event_photo' || m.type === 'approved_event_photo') m.unit = 'photos';
        else m.unit = '';
      }

      return m;
    });
  }

  next();
});

/**
 * Plantillas por defecto: catálogo de 10 niveles (versión 2, octubre 2026).
 * Las usan scripts/seedPromotionTemplates.js (plantillas globales) y
 * ensureClubTemplates cuando no hay globales. Cada nivel N lleva al N+1.
 * Todas las misiones de foto llevan photoCriteria (lo usa la IA) y la misma
 * exclusión. `version: 2` para que el seed actualice las globales existentes
 * (solo sobrescribe si la versión entrante es mayor, o con --force).
 */
const CATALOG_VERSION = 2;
const PHOTO_EXCLUDE = 'Capturas de pantalla, fotos de otra pantalla o imágenes descargadas de internet.';

PromotionLevelTemplateSchema.statics.getDefaultTemplates = function () {
  const level = (levelNumber, name, difficulty, description, missions, reward) => ({
    scope: 'global',
    levelNumber,
    order: levelNumber,
    title: `Nivel ${levelNumber} — ${name}`,
    description,
    difficulty,
    status: 'active',
    version: CATALOG_VERSION,
    // Clave fija y legible para el catálogo: igual en cada siembra
    missions: missions.map((m, idx) => ({ order: idx + 1, missionKey: `L${levelNumber}_${m.type}_${idx + 1}`, ...m })),
    reward,
  });

  // Misión de foto: la valida la IA y, si duda, el club.
  const photo = (m) => ({
    validationType: 'hybrid',
    requiresApproval: true,
    unit: 'photos',
    photoCriteriaExclude: PHOTO_EXCLUDE,
    ...m,
  });

  return withDefaultPhotoCriteria([
    level(1, 'Primera noche', 'easy', 'Ven a tu primer evento y sube una foto de la noche.', [
      { type: 'attend_event', title: 'Marca asistencia a un evento', description: 'Marca que vas a un evento del club.', target: 1, unit: 'events', validationType: 'automatic', requiresApproval: false },
      photo({
        type: 'upload_event_photo',
        title: 'Sube una foto del evento',
        description: 'Sube una foto de la noche desde dentro del local.',
        target: 1,
        params: { perEvent: true },
        photoCriteria: 'Una foto tomada dentro del local durante el evento, donde se vea el ambiente de la noche.',
      }),
    ], { type: 'shot', title: '1 chupito de bienvenida', value: 1 }),

    level(2, 'Repites', 'easy', 'Vuelve: escanea el QR del local en 2 eventos distintos.', [
      { type: 'scan_qr', title: 'Escanea el QR en 2 eventos distintos', description: 'Escanea el QR del local en dos eventos diferentes.', target: 2, unit: 'scans', validationType: 'automatic', requiresApproval: false },
    ], { type: 'custom', title: 'Sin cola una noche', value: 1 }),

    level(3, 'Con gente', 'medium', 'Sal con tu gente y hazte una foto de grupo.', [
      photo({
        type: 'group_photo_with_followed',
        title: 'Foto de grupo',
        description: 'Sube una foto de grupo dentro del local.',
        target: 1,
        photoCriteria: 'Una foto donde aparezcan al menos tres personas juntas dentro del local.',
      }),
      { type: 'follow_users', title: 'Sigue a 3 personas', description: 'Sigue a 3 cuentas en NightVibe.', target: 3, unit: 'users', validationType: 'automatic', requiresApproval: false },
    ], { type: 'shot', title: 'Chupito para ti y un amigo', value: 2 }),

    level(4, 'Corre la voz', 'medium', 'Comparte un evento y consigue que alguien abra tu enlace.', [
      { type: 'share_event', title: 'Comparte un evento', description: 'Comparte un evento del club con tu enlace.', target: 1, unit: 'shares', validationType: 'link_tracking', requiresApproval: false },
      { type: 'link_clicks', title: 'Consigue 1 clic en tu enlace', description: 'Que alguien abra el enlace que has compartido.', target: 1, unit: 'clicks', validationType: 'link_tracking', requiresApproval: false },
    ], { type: 'free_entry', title: 'Entrada gratis a un evento', value: 1 }),

    level(5, 'Habitual', 'medium', 'Ya eres de la casa: escanea el QR en 4 eventos.', [
      { type: 'scan_qr', title: 'Escanea el QR en 4 eventos distintos', description: 'Escanea el QR del local en cuatro eventos diferentes.', target: 4, unit: 'scans', validationType: 'automatic', requiresApproval: false },
    ], { type: 'drink', title: 'Copa gratis', value: 1 }),

    level(6, 'La foto buena', 'hard', 'Ven con la temática del evento y demuéstralo.', [
      photo({
        type: 'theme_photo',
        title: 'Foto con la temática',
        description: 'Sube una foto vestido/a según la temática del evento.',
        target: 1,
        photoCriteria: 'Una foto de al menos dos personas vestidas o caracterizadas según la temática del evento, dentro del local.',
      }),
    ], { type: 'custom', title: 'Sin cola + chupito', value: 1 }),

    level(7, 'Traes gente', 'hard', 'Que 2 personas compren entrada con tu enlace.', [
      { type: 'referred_purchases', title: '2 compras con tu enlace', description: 'Dos personas compran entrada desde tu enlace.', target: 2, unit: 'purchases', validationType: 'link_tracking', requiresApproval: false },
    ], { type: 'custom', title: 'Entrada gratis + copa', value: 1 }),

    level(8, 'Fiel', 'hard', 'Constancia: escanea el QR en 7 eventos.', [
      { type: 'scan_qr', title: 'Escanea el QR en 7 eventos distintos', description: 'Escanea el QR del local en siete eventos diferentes.', target: 7, unit: 'scans', validationType: 'automatic', requiresApproval: false },
    ], { type: 'bottle', title: 'Botella de cava para tu mesa', value: 1 }),

    level(9, 'El último empujón', 'extreme', 'Dos fotos más y llegas al final.', [
      photo({
        type: 'photocall_photo',
        title: 'Foto en el photocall',
        description: 'Sube una foto en el photocall del local con alguien.',
        target: 1,
        photoCriteria: 'Una foto de al menos dos personas posando delante del photocall del local.',
      }),
      photo({
        type: 'show_prizes_photo',
        title: 'Foto con tus premios',
        description: 'Sube una foto enseñando los premios que has conseguido.',
        target: 1,
        photoCriteria: 'Una foto donde se vean claramente premios o recompensas conseguidas en el club: pulseras, consumiciones, entradas o similares.',
      }),
    ], { type: 'custom', title: 'Copa gratis + sin cola el resto de la temporada', value: 1 }),

    level(10, 'Ganador', 'extreme', 'Has llegado al final.', [], { type: 'bottle', title: 'Mesa con botella para ti y tus amigos', value: 1 }),
  ]);
};

/** Las misiones de foto de las plantillas por defecto llevan el criterio por defecto de su tipo. */
function withDefaultPhotoCriteria(templates) {
  return templates.map((level) => ({
    ...level,
    missions: (level.missions || []).map((m) =>
      isPhotoMission(m) && !m.photoCriteria
        ? {
            ...m,
            photoCriteria: DEFAULT_PHOTO_CRITERIA[m.type] || '',
            photoCriteriaExclude: m.photoCriteriaExclude || DEFAULT_PHOTO_CRITERIA_EXCLUDE,
          }
        : m
    ),
  }));
}

module.exports = mongoose.model('PromotionLevelTemplate', PromotionLevelTemplateSchema);
