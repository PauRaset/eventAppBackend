// controllers/promotionsController.js
const mongoose = require('mongoose');

const PromotionLevelTemplate = require('../models/PromotionLevelTemplate');
const UserClubPromotionProgress = require('../models/UserClubPromotionProgress');
const PromotionClaim = require('../models/PromotionClaim');
const Notification = require('../models/Notification');
const { sendPushNotificationToUser } = require('../utils/sendPushNotification');
const { getTemplatesForClub: getTemplatesForClubShared } = require('../utils/promotionTemplates');
const {
  normalizeRewardType,
  autoRewardTitle,
  validateReward,
  rewardTypeOptions,
} = require('../utils/rewardTypes');
const {
  isPhotoMission,
  PHOTO_CRITERIA_MIN_LENGTH,
  PHOTO_CRITERIA_MAX_LENGTH,
  PHOTO_CRITERIA_EXCLUDE_MAX_LENGTH,
} = require('../utils/photoMissions');

// Opcionales (si existen en tu backend)
let UserModel = null;
let ClubModel = null;
try { UserModel = require('../models/User'); } catch (_) {}
try { ClubModel = require('../models/Club'); } catch (_) {}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function now() {
  return new Date();
}

async function createPromotionNotification({
  userId,
  type,
  title,
  body,
  clubId = null,
  clubName = '',
  previewImage = null,
  meta = {},
}) {
  try {
    if (!userId || !type || !title) return;

    const notification = await Notification.create({
      user: userId,
      type,
      title,
      body,
      routeTarget: 'promotion:level_reward',
      previewImage,
      pushSent: false,
      read: false,
      readAt: null,
      meta: {
        clubId,
        clubName,
        ...meta,
      },
    });

    if (notification?._id) {
      await sendPushNotificationToUser(userId, notification);
    }
  } catch (e) {
    console.warn('[notifications][promotion] create failed:', e?.message || e);
  }
}

/**
 * Intenta obtener info del usuario autenticado.
 * - Si req.user es un doc de Mongo, lo usa.
 * - Si no, intenta sacar firebase uid de varios sitios.
 * - Si existe modelo User, intenta mapear firebase uid -> user mongo.
 */
async function getAuthUser(req) {
  // Caso típico: middleware ya mete usuario mongo
  if (req.user && req.user._id) {
    return { mongoUser: req.user, firebaseUid: req.user.firebaseUid || req.user.uid || null };
  }

  // Firebase uid en diferentes shapes posibles
  const firebaseUid =
    req.firebaseUser?.uid ||
    req.user?.uid ||
    req.user?.firebaseUid ||
    req.auth?.uid ||
    req.uid ||
    req.headers['x-firebase-uid'] ||
    null;

  if (!firebaseUid) {
    return { mongoUser: null, firebaseUid: null };
  }

  // Intentar mapear a Mongo User si el modelo existe
  if (UserModel) {
    // Ajusta aquí si tu campo se llama distinto:
    // firebaseUid / uid / providerId...
    const mongoUser =
      (await UserModel.findOne({ firebaseUid }).lean()) ||
      (await UserModel.findOne({ uid: firebaseUid }).lean()) ||
      null;

    if (mongoUser) return { mongoUser, firebaseUid };
  }

  return { mongoUser: null, firebaseUid };
}

/**
 * ¿Puede quien hace la petición gestionar ESTE club (niveles, claims)?
 *  - clubId es su propio id (_id de Mongo o uid de Firebase): el portal usa el
 *    _id del usuario-club como clubId, y el progreso también (event.createdBy).
 *  - o existe un Club con ese _id cuyo ownerUserId / managers incluyen su id.
 * Sin acceso por rol: antes cualquier usuario con role 'club' gestionaba
 * CUALQUIER club. Solo identidades verificadas por el middleware de auth
 * (req.user.id, req.firebaseUser.uid); nunca cabeceras ni email.
 */
async function canManageClub(req, clubId) {
  const target = String(clubId || '').trim();
  if (!target) return false;

  const ids = new Set(
    [req.user?.id, req.userId, req.firebaseUser?.uid].filter(Boolean).map(String)
  );
  if (!ids.size) return false;

  // Completar la identidad: _id de Mongo <-> uid de Firebase del mismo usuario
  if (UserModel) {
    const or = [];
    const mongoIds = [...ids].filter((v) => isValidObjectId(v));
    if (mongoIds.length) or.push({ _id: { $in: mongoIds } });
    or.push({ firebaseUid: { $in: [...ids] } });
    const me = await UserModel.findOne({ $or: or }).select('_id firebaseUid').lean();
    if (me?._id) ids.add(String(me._id));
    if (me?.firebaseUid) ids.add(String(me.firebaseUid));
  }

  if (ids.has(target)) return true;

  if (ClubModel && isValidObjectId(target)) {
    const club = await ClubModel.findById(target).select('ownerUserId managers').lean();
    if (club) {
      return [club.ownerUserId, ...(club.managers || [])]
        .filter(Boolean)
        .some((p) => ids.has(String(p)));
    }
  }

  return false;
}

function pickClubName(clubDoc) {
  if (!clubDoc) return 'Tu club';
  return (
    clubDoc.username ||
    clubDoc.name ||
    clubDoc.displayName ||
    clubDoc.entityName ||
    'Tu club'
  ).toString();
}

function pickClubAvatar(clubDoc) {
  if (!clubDoc) return null;
  return (
    clubDoc.profilePictureUrl ||
    clubDoc.profilePicture ||
    clubDoc.avatar ||
    null
  );
}

function computeMissionRatio(m) {
  const target = Number(m.target || 1);
  const cur = Number(m.current || 0);
  if (target <= 0) return 0;
  return Math.max(0, Math.min(1, cur / target));
}

function computeLevelProgress(level) {
  const missions = Array.isArray(level.missions) ? level.missions : [];
  // Nivel sin misiones (p. ej. el 10 del catálogo): completo en cuanto se llega a él
  if (missions.length === 0) return level.status === 'locked' ? 0 : 1;

  // pending cuenta como progreso completo visualmente? (yo lo dejo como ratio real)
  const ratios = missions.map(computeMissionRatio);
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Math.max(0, Math.min(1, avg));
}

function isMissionEffectivelyCompleted(mission) {
  if (!mission || typeof mission !== 'object') return false;

  const status = String(mission.status || '').trim().toLowerCase();
  const target = Number(mission.target || 1);
  const current = Number(mission.current || 0);

  if (status === 'completed' || status === 'approved') return true;
  if (target > 0 && current >= target) return true;

  return false;
}

/**
 * ¿Nivel superado? Solo si el usuario ya ha LLEGADO a él (no bloqueado): las
 * misiones acumuladas (scan_qr, attend_event, referidos) llevan current a los
 * niveles bloqueados, y un nivel bloqueado con current >= target no puede
 * contar como completado (applyRewardGating saltaría a él).
 * Un nivel sin misiones está completo en cuanto se llega a él.
 */
function isLevelFullyCompleted(level) {
  if (!level || level.status === 'locked') return false;
  const missions = Array.isArray(level.missions) ? level.missions : [];
  if (missions.length === 0) return true;

  return missions.every((mission) => isMissionEffectivelyCompleted(mission));
}

function shouldBlockLevelUntilRewardRedeemed(level) {
  if (!level) return false;
  return isLevelFullyCompleted(level) && level.rewardRedeemed !== true;
}

function applyRewardGating(progress) {
  if (!progress || !Array.isArray(progress.levels)) return false;

  let changed = false;
  const levels = progress.levels;
  const firstPendingRewardLevel = levels.find((level) => shouldBlockLevelUntilRewardRedeemed(level));

  if (!firstPendingRewardLevel) {
    return false;
  }

  const blockedFromLevelNumber = Number(firstPendingRewardLevel.levelNumber) + 1;

  if (Number(progress.currentLevel || 1) !== Number(firstPendingRewardLevel.levelNumber)) {
    progress.currentLevel = Number(firstPendingRewardLevel.levelNumber);
    changed = true;
  }

  for (const level of levels) {
    if (!level) continue;

    if (Number(level.levelNumber) >= blockedFromLevelNumber) {
      if (level.status !== 'locked') {
        level.status = 'locked';
        changed = true;
      }

      for (const mission of level.missions || []) {
        if (mission.status !== 'completed' && mission.status !== 'pending') {
          if (mission.status !== 'locked') {
            mission.status = 'locked';
            mission.updatedAt = now();
            changed = true;
          }
        }
      }
    }
  }

  return changed;
}

function getNextLevel(progress, levelNumber) {
  if (!progress || !Array.isArray(progress.levels)) return null;
  return progress.levels.find((level) => Number(level.levelNumber) === Number(levelNumber) + 1) || null;
}


function normalizeEvidence(evidence) {
  if (!evidence) return [];
  if (Array.isArray(evidence)) return evidence;
  return [evidence];
}

function normalizeMissionInput(mission = {}, idx = 0) {
  const type = String(mission.type || '').trim();
  const title = String(mission.title || '').trim();
  const description = String(mission.description || '').trim();
  const target = Number.isFinite(Number(mission.target)) ? Number(mission.target) : 1;
  const order = Number.isFinite(Number(mission.order)) ? Number(mission.order) : idx + 1;
  const active = typeof mission.active === 'boolean' ? mission.active : true;
  const requiresApproval =
    typeof mission.requiresApproval === 'boolean'
      ? mission.requiresApproval
      : String(mission.validationType || '').trim() === 'manual';

  return {
    // Solo un ObjectId real (24 hex). Ids del portal tipo "mission-1712345678"
    // hacían fallar insertMany con CastError DESPUÉS de borrar los niveles.
    ...(/^[a-fA-F0-9]{24}$/.test(String(mission._id || '')) ? { _id: mission._id } : {}),
    // Clave estable si llega (copia de plantillas o el portal la devuelve); la
    // decide assignMissionKeys al guardar, no el cliente.
    ...(PromotionLevelTemplate.isValidMissionKey(mission.missionKey) ? { missionKey: String(mission.missionKey) } : {}),
    type,
    title,
    description,
    target,
    unit: String(mission.unit || '').trim(),
    params: mission.params && typeof mission.params === 'object' ? mission.params : {},
    photoCriteria: String(mission.photoCriteria || '').trim(),
    photoCriteriaExclude: String(mission.photoCriteriaExclude || '').trim(),
    validationType: String(mission.validationType || (requiresApproval ? 'manual' : 'automatic')).trim() || 'automatic',
    requiresApproval,
    order,
    active,
  };
}

/**
 * Las misiones de foto deben llevar photoCriteria con sentido (lo que debe verse
 * en la foto): sin eso nadie, ni el club ni una IA, tiene criterio para validar.
 * Devuelve null si todo está bien, o { error, missionKey, levelNumber, ... }.
 */
function findInvalidPhotoCriteria(levels) {
  for (const level of levels) {
    for (const m of level.missions || []) {
      if (!isPhotoMission(m)) continue;

      const missionKey = String(
        m.missionKey || m._id || m.id || `L${level.levelNumber}_${m.type}_${m.order}`
      );
      const base = { missionKey, levelNumber: level.levelNumber, type: m.type, title: m.title };
      const criteria = String(m.photoCriteria || '').trim();
      const exclude = String(m.photoCriteriaExclude || '').trim();

      if (criteria.length < PHOTO_CRITERIA_MIN_LENGTH) {
        return { error: 'photo_criteria_required', minLength: PHOTO_CRITERIA_MIN_LENGTH, ...base };
      }
      if (criteria.length > PHOTO_CRITERIA_MAX_LENGTH) {
        return { error: 'photo_criteria_too_long', maxLength: PHOTO_CRITERIA_MAX_LENGTH, ...base };
      }
      if (exclude.length > PHOTO_CRITERIA_EXCLUDE_MAX_LENGTH) {
        return { error: 'photo_criteria_exclude_too_long', maxLength: PHOTO_CRITERIA_EXCLUDE_MAX_LENGTH, ...base };
      }
    }
  }
  return null;
}

/**
 * Premio normalizado (la coherencia la comprueba validateReward):
 *  - tipos antiguos (vip_access, trip) -> custom
 *  - value: número; vacío -> 1 en los tipos cerrados, null en custom; un texto
 *    que no es número queda NaN para que la validación lo rechace
 *  - sin título en un tipo cerrado -> se autogenera ("2 chupitos", "Copa gratis")
 */
function normalizeRewardInput(reward = {}) {
  const type = normalizeRewardType(reward?.type);
  const rawValue = reward?.value;

  let value = null;
  if (typeof rawValue === 'number') {
    value = rawValue;
  } else if (typeof rawValue === 'string' && rawValue.trim() !== '') {
    value = Number(rawValue.trim().replace(',', '.'));
  }
  if (value === null && type !== 'custom') value = 1;

  let title = String(reward?.title || '').trim();
  if (!title && type !== 'custom') title = autoRewardTitle(type, value) || '';

  return {
    type,
    title,
    description: String(reward?.description || '').trim(),
    value,
    active: typeof reward?.active === 'boolean' ? reward.active : true,
  };
}

/** Primer premio incoherente de una lista de niveles normalizados, o null. */
function findInvalidReward(levels) {
  for (const level of levels) {
    const problem = validateReward(level.reward);
    if (problem) return { ...problem, levelNumber: level.levelNumber };
  }
  return null;
}

function normalizeLevelInput(level = {}, idx = 0) {
  const levelNumber = Number.isFinite(Number(level.levelNumber)) ? Number(level.levelNumber) : idx + 1;
  const order = Number.isFinite(Number(level.order)) ? Number(level.order) : levelNumber;
  const status = String(level.status || (level.active === false ? 'paused' : 'active')).trim() || 'active';
  const active = typeof level.active === 'boolean' ? level.active : status === 'active';

  return {
    levelNumber,
    order,
    title: String(level.title || `Nivel ${levelNumber}`).trim(),
    description: String(level.description || '').trim(),
    difficulty: String(level.difficulty || 'medium').trim() || 'medium',
    missions: Array.isArray(level.missions)
      ? level.missions.map((mission, missionIdx) => normalizeMissionInput(mission, missionIdx))
      : [],
    reward: normalizeRewardInput(level.reward || {}),
    status,
    active,
    visibleInApp: typeof level.visibleInApp === 'boolean' ? level.visibleInApp : true,
    version: Number.isFinite(Number(level.version)) ? Number(level.version) : 1,
  };
}

function serializeLevelDoc(doc) {
  const obj = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: obj._id?.toString?.() || null,
    scope: obj.scope,
    club: obj.club ? obj.club.toString() : null,
    levelNumber: obj.levelNumber,
    order: obj.order,
    title: obj.title,
    description: obj.description || '',
    difficulty: obj.difficulty || 'medium',
    reward: obj.reward || null,
    status: obj.status || (obj.active ? 'active' : 'paused'),
    active: !!obj.active,
    visibleInApp: obj.visibleInApp !== false,
    version: obj.version || 1,
    missions: Array.isArray(obj.missions)
      ? obj.missions
          .map((mission) => {
            const m = mission && typeof mission.toObject === 'function' ? mission.toObject() : mission;
            return {
              id: m?._id?.toString?.() || null,
              missionKey: m?.missionKey || null,
              type: m?.type || '',
              title: m?.title || '',
              description: m?.description || '',
              target: Number(m?.target || 1),
              unit: m?.unit || '',
              params: m?.params || {},
              isPhotoMission: isPhotoMission(m),
              photoCriteria: m?.photoCriteria || '',
              photoCriteriaExclude: m?.photoCriteriaExclude || '',
              validationType: m?.validationType || (m?.requiresApproval ? 'manual' : 'automatic'),
              requiresApproval: !!m?.requiresApproval,
              order: Number(m?.order || 0),
              active: m?.active !== false,
            };
          })
          .sort((a, b) => a.order - b.order)
      : [],
  };
}

// ¿Admite el MongoDB transacciones (réplica o mongos)? Se averigua en el primer
// intento y se recuerda: null = sin probar, true / false = ya sabido.
let transactionsSupported = null;

function isTransactionUnsupportedError(e) {
  const msg = String(e?.message || '');
  return (
    e?.code === 20 ||
    e?.codeName === 'IllegalOperation' ||
    /Transaction numbers are only allowed on a replica set member or mongos/i.test(msg) ||
    /does not support (retryable writes|transactions)/i.test(msg)
  );
}

/**
 * Ejecuta `work(session)` dentro de una transacción si el MongoDB la admite.
 *  - true:  hecho en transacción (si `work` falla, Mongo deshace todo y se lanza el error).
 *  - false: el servidor no admite transacciones (standalone); NO se ha escrito
 *           nada y el llamador debe usar su alternativa sin transacción.
 */
async function runInTransactionIfSupported(work) {
  if (transactionsSupported === false) return false;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => work(session));
    transactionsSupported = true;
    return true;
  } catch (e) {
    if (!isTransactionUnsupportedError(e)) throw e; // la transacción ya se deshizo sola
    transactionsSupported = false;
    console.warn(
      '[promotions] MongoDB sin soporte de transacciones (no es réplica): ' +
        'escrituras de plantillas con limpieza/restauración ante fallos.'
    );
    return false;
  } finally {
    session.endSession();
  }
}

function isDuplicateKeyError(e) {
  return e?.code === 11000 || /E11000 duplicate key/i.test(String(e?.message || ''));
}

/**
 * Crea las plantillas iniciales del club SIN dejarlo a medias: o se crean todas,
 * o ninguna. Si se quedara a medias, el club tendría niveles incompletos para
 * siempre (ensureClubTemplates solo crea plantillas si no hay ninguna).
 *  1) Con transacción: todo o nada.
 *  2) Sin transacciones: si insertMany falla, se borran las que ESTA llamada
 *     insertó (por _id asignado de antemano), sin tocar las de nadie más.
 */
async function insertInitialClubTemplates(clubId, docs) {
  if (!docs.length) return;
  // _id asignados aquí: así sabemos exactamente qué insertó esta llamada
  const withIds = docs.map((d) => ({ ...d, _id: new mongoose.Types.ObjectId() }));

  const doneInTransaction = await runInTransactionIfSupported((session) =>
    PromotionLevelTemplate.insertMany(withIds, { session, ordered: true })
  );
  if (doneInTransaction) return;

  try {
    await PromotionLevelTemplate.insertMany(withIds, { ordered: true });
  } catch (insertErr) {
    try {
      await PromotionLevelTemplate.deleteMany({ _id: { $in: withIds.map((d) => d._id) } });
    } catch (cleanupErr) {
      console.error(
        '🚨 [promotions] Plantillas del club a medias y NO se pudieron limpiar. Revisar a mano:',
        { clubId: String(clubId), error: cleanupErr?.message || cleanupErr }
      );
    }
    throw insertErr;
  }
}

async function ensureClubTemplates(clubId) {
  let clubTemplates = await PromotionLevelTemplate.find({ scope: 'club', club: clubId })
    .sort({ order: 1, levelNumber: 1 })
    .exec();

  if (clubTemplates.length) return clubTemplates;

  const globalTemplates = await PromotionLevelTemplate.find({ scope: 'global' })
    .sort({ order: 1, levelNumber: 1 })
    .lean();

  const source = globalTemplates.length
    ? globalTemplates
    : PromotionLevelTemplate.getDefaultTemplates();

  const docsToInsert = source.map((level, idx) => {
    const normalized = normalizeLevelInput(level, idx);
    return {
      scope: 'club',
      club: clubId,
      ...normalized,
    };
  });

  try {
    await insertInitialClubTemplates(clubId, docsToInsert);
  } catch (e) {
    // Dos peticiones a la vez para un club nuevo: la otra ya creó las plantillas
    // (índice único scope+club+levelNumber). No es un error: usamos las suyas.
    if (!isDuplicateKeyError(e)) throw e;
  }

  clubTemplates = await PromotionLevelTemplate.find({ scope: 'club', club: clubId })
    .sort({ order: 1, levelNumber: 1 })
    .exec();

  return clubTemplates;
}

// Criterio único (del club si tiene, si no globales): utils/promotionTemplates.js
function getTemplatesForClub(clubId) {
  return getTemplatesForClubShared(clubId, { source: 'promotionsController' });
}

async function ensureProgressDoc({ userId, clubId, templates, userDoc = null }) {
  let progress = await UserClubPromotionProgress.findOne({ user: userId, club: clubId });

  if (!progress) {
    const built = UserClubPromotionProgress.buildFromTemplates({ templates, startLevel: 1 });
    progress = await UserClubPromotionProgress.create({
      user: userId,
      club: clubId,
      ...built,
    });
  }

  syncProgressWithTemplates(progress, templates);
  syncCounterBasedMissions(progress, userDoc);
  refreshCurrentSnapshot(progress);
  progress.lastActivityAt = now();
  await progress.save();

  return progress;
}

function findLevel(progress, levelNumber) {
  return (progress.levels || []).find((l) => Number(l.levelNumber) === Number(levelNumber));
}

function findMission(level, missionKey) {
  return (level?.missions || []).find((m) => m.missionKey === missionKey);
}

function getTemplateMissionKey(mission, fallbackIndex = 0) {
  if (!mission) return `mission_${fallbackIndex + 1}`;
  return (
    mission.missionKey ||
    mission.key ||
    mission.slug ||
    mission.code ||
    mission._id?.toString?.() ||
    `mission_${fallbackIndex + 1}`
  ).toString();
}

function syncMissionWithTemplate(existingMission, templateMission, missionIndex = 0, { keepCompleted = false } = {}) {
  const missionKey = getTemplateMissionKey(templateMission, missionIndex);
  const target = Number(templateMission.target || 1);
  const current = Number(existingMission?.current || 0);

  // Si el club ha SUBIDO el objetivo y el contador ya no llega, la misión deja
  // de estar completada. No se toca en niveles cuyo premio ya se canjeó.
  let status = existingMission?.status || 'in_progress';
  let completedAt = existingMission?.completedAt || null;
  if (!keepCompleted && (status === 'completed' || status === 'approved') && current < target) {
    status = 'in_progress';
    completedAt = null;
  }

  return {
    missionKey,
    type: String(templateMission.type || ''),
    title: String(templateMission.title || ''),
    description: String(templateMission.description || ''),
    target: Number(templateMission.target || 1),
    unit: String(templateMission.unit || ''),
    params: templateMission.params && typeof templateMission.params === 'object' ? templateMission.params : {},
    photoCriteria: String(templateMission.photoCriteria || ''),
    photoCriteriaExclude: String(templateMission.photoCriteriaExclude || ''),
    validationType:
      String(
        templateMission.validationType ||
          (templateMission.requiresApproval ? 'manual' : 'automatic')
      ) || 'automatic',
    requiresApproval: !!templateMission.requiresApproval,
    order: Number(templateMission.order || missionIndex + 1),
    active: templateMission.active !== false,
    status,
    current,
    claimId: existingMission?.claimId || null,
    meta: existingMission?.meta || {},
    startedAt: existingMission?.startedAt || now(),
    completedAt,
    updatedAt: now(),
  };
}

function syncLevelWithTemplate(existingLevel, templateLevel, levelIndex = 0) {
  const existingMissions = Array.isArray(existingLevel?.missions) ? existingLevel.missions : [];
  const templateMissions = Array.isArray(templateLevel.missions) ? templateLevel.missions : [];
  const keepCompleted = existingLevel?.rewardRedeemed === true;

  // Emparejar el progreso con la plantilla: 1) por CLAVE; 2) si no, con una
  // misión del MISMO TIPO de este nivel que no se haya llevado otra; 3) si no,
  // de cero. Nunca por posición: con plantillas distintas, una misión heredaba
  // el contador y el estado de otra (p. ej. scan_qr "completada" con 1/3).
  const templateKeys = templateMissions.map((m, i) => getTemplateMissionKey(m, i));
  const byKey = new Map(existingMissions.map((m, i) => [getTemplateMissionKey(m, i), m]));
  const taken = new Set();
  const matched = templateKeys.map((key) => {
    const m = byKey.get(key) || null;
    if (m) taken.add(m);
    return m;
  });
  templateMissions.forEach((tm, i) => {
    if (matched[i]) return;
    const sameType = existingMissions.find(
      (m) => !taken.has(m) && String(m.type || '') === String(tm.type || '') &&
        !templateKeys.includes(getTemplateMissionKey(m))
    );
    if (sameType) {
      matched[i] = sameType;
      taken.add(sameType);
    }
  });

  const nextLevelNumber = Number(templateLevel.levelNumber || levelIndex + 1);
  const nextMissions = templateMissions
    .map((mission, missionIndex) =>
      syncMissionWithTemplate(matched[missionIndex], mission, missionIndex, { keepCompleted })
    )
    .sort((a, b) => a.order - b.order);

  let nextStatus = existingLevel?.status || (nextLevelNumber === 1 ? 'in_progress' : 'locked');
  if (keepCompleted) {
    // Un nivel con el premio cobrado está superado, sea cual sea el estado de
    // sus misiones: nunca vuelve a en curso (si no, syncProgressWithTemplates
    // lo pondría como nivel actual y el usuario volvería a un nivel ya cobrado).
    // Repara también los que dejó así el fallo anterior de follow_users.
    nextStatus = 'completed';
  } else if (isLevelFullyCompleted({ status: nextStatus, missions: nextMissions })) {
    nextStatus = 'completed';
  } else if (nextStatus === 'completed' && !keepCompleted) {
    // Completado pero sin canjear, y una misión ha dejado de estar cumplida
    // (objetivo subido o misión nueva): vuelve a estar en curso.
    nextStatus = 'in_progress';
  }

  const syncedLevel = {
    levelNumber: nextLevelNumber,
    order: Number(templateLevel.order || nextLevelNumber),
    title: String(templateLevel.title || `Nivel ${nextLevelNumber}`),
    description: String(templateLevel.description || ''),
    difficulty: String(templateLevel.difficulty || 'medium'),
    reward: templateLevel.reward || null,
    rewardRedeemed: existingLevel?.rewardRedeemed === true,
    rewardRedeemedAt: existingLevel?.rewardRedeemedAt || null,
    status: nextStatus,
    active: templateLevel.active !== false,
    visibleInApp: templateLevel.visibleInApp !== false,
    version: Number(templateLevel.version || 1),
    missions: nextMissions,
    startedAt: existingLevel?.startedAt || now(),
    completedAt: existingLevel?.completedAt || null,
    updatedAt: now(),
  };

  syncedLevel.progress = computeLevelProgress(syncedLevel);
  return syncedLevel;
}

function syncProgressWithTemplates(progress, templates) {
  const sortedTemplates = [...(templates || [])].sort(
    (a, b) => Number(a.order || a.levelNumber || 0) - Number(b.order || b.levelNumber || 0)
  );

  const existingLevels = Array.isArray(progress.levels) ? progress.levels : [];
  const existingByLevelNumber = new Map(
    existingLevels.map((level) => [Number(level.levelNumber), level])
  );

  const nextLevels = sortedTemplates.map((templateLevel, levelIndex) => {
    const levelNumber = Number(templateLevel.levelNumber || levelIndex + 1);
    const existingLevel = existingByLevelNumber.get(levelNumber) || null;
    return syncLevelWithTemplate(existingLevel, templateLevel, levelIndex);
  });

  let firstActiveInProgressFound = false;
  for (const level of nextLevels) {
    if (level.status === 'completed') continue;
    if (!firstActiveInProgressFound) {
      level.status = 'in_progress';
      for (const mission of level.missions || []) {
        if (mission.status === 'locked' || !mission.status) {
          mission.status = 'in_progress';
        }
      }
      firstActiveInProgressFound = true;
    } else if (level.status !== 'completed') {
      level.status = 'locked';
      for (const mission of level.missions || []) {
        if (mission.status !== 'completed') {
          mission.status = 'locked';
        }
      }
    }
    level.progress = computeLevelProgress(level);
  }

  if (!firstActiveInProgressFound && nextLevels.length) {
    const lastLevel = nextLevels[nextLevels.length - 1];
    lastLevel.status = 'completed';
    lastLevel.progress = 1;
  }

  progress.levels = nextLevels;

  const currentInProgress = nextLevels.find((level) => level.status === 'in_progress');
  const lastCompleted = [...nextLevels].reverse().find((level) => level.status === 'completed');

  if (currentInProgress) {
    progress.currentLevel = currentInProgress.levelNumber;
  } else if (lastCompleted) {
    progress.currentLevel = lastCompleted.levelNumber;
  } else {
    progress.currentLevel = nextLevels[0]?.levelNumber || 1;
  }

  applyRewardGating(progress);
}

function unlockNextLevel(progress, completedLevelNumber) {
  const completedLevel = findLevel(progress, completedLevelNumber);
  if (completedLevel && completedLevel.rewardRedeemed !== true) {
    progress.currentLevel = Number(completedLevelNumber);
    progress.currentRewardTitle = completedLevel.reward?.title || '';
    return;
  }

  const nextLevelNumber = Number(completedLevelNumber) + 1;
  const next = findLevel(progress, nextLevelNumber);
  if (!next) return;

  if (next.status === 'locked') {
    next.status = 'in_progress';
    for (const m of next.missions || []) {
      if (m.status === 'locked') m.status = 'in_progress';
      if (!m.startedAt) m.startedAt = now();
      m.updatedAt = now();
    }
  }

  progress.currentLevel = nextLevelNumber;
  progress.currentRewardTitle = next.reward?.title || '';
}


function refreshCurrentSnapshot(progress) {
  applyRewardGating(progress);

  const curLevel = findLevel(progress, progress.currentLevel);
  if (!curLevel) {
    progress.currentProgress = 0;
    return;
  }

  curLevel.progress = computeLevelProgress(curLevel);
  progress.currentProgress = curLevel.progress;
  progress.currentRewardTitle = curLevel.reward?.title || '';
}

function getUserFollowedUsersCount(userDoc) {
  if (!userDoc || typeof userDoc !== 'object') return 0;

  if (Array.isArray(userDoc.following)) return userDoc.following.length;
  if (Array.isArray(userDoc.followingUsers)) return userDoc.followingUsers.length;
  if (Array.isArray(userDoc.follows)) return userDoc.follows.length;

  const numericCandidates = [
    userDoc.followingCount,
    userDoc.followedUsersCount,
    userDoc.followCount,
    userDoc.following_count,
  ];

  for (const value of numericCandidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  return 0;
}

function isFollowUsersMissionType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  if (!normalized) return false;

  return [
    'follow_users',
    'followed_users',
    'follow_users_count',
    'follow_count',
    'following_count',
    'seguir_usuarios',
    'usuarios_seguidos',
  ].includes(normalized);
}

function syncCounterBasedMissions(progress, userDoc = null) {
  if (!progress || !Array.isArray(progress.levels)) return false;

  const followedUsersCount = getUserFollowedUsersCount(userDoc);
  let changed = false;

  progress.counters = progress.counters || {};
  if (Number(progress.counters.followedUsers || 0) !== followedUsersCount) {
    progress.counters.followedUsers = followedUsersCount;
    changed = true;
  }

  for (const level of progress.levels) {
    if (!level || !Array.isArray(level.missions)) continue;
    // Premio ya cobrado: el nivel queda congelado. Dejar de seguir a alguien
    // nunca revierte su misión, el nivel ni el premio (antes sí: el usuario
    // volvía a un nivel ya canjeado y no podía volver a canjearlo).
    if (level.rewardRedeemed === true) continue;

    for (const mission of level.missions) {
      if (!mission || mission.active === false) continue;
      if (!isFollowUsersMissionType(mission.type)) continue;

      const target = Number(mission.target || 1);
      const nextCurrent = Math.max(0, Math.min(target, followedUsersCount));
      const prevCurrent = Number(mission.current || 0);

      if (prevCurrent !== nextCurrent) {
        mission.current = nextCurrent;
        mission.updatedAt = now();
        changed = true;
      }

      const shouldBeCompleted = nextCurrent >= target;
      if (shouldBeCompleted && mission.status !== 'completed') {
        mission.status = 'completed';
        mission.completedAt = mission.completedAt || now();
        mission.updatedAt = now();
        changed = true;
      } else if (!shouldBeCompleted) {
        const desiredStatus = level.status === 'locked' ? 'locked' : 'in_progress';
        if (mission.status !== desiredStatus && mission.status !== 'pending') {
          mission.status = desiredStatus;
          mission.completedAt = null;
          mission.updatedAt = now();
          changed = true;
        }
      }
    }

    const levelWasCompleted = level.status === 'completed';
    level.progress = computeLevelProgress(level);

    if (finalizeLevelIfCompleted(progress, level)) {
      changed = true;
    } else if (
      levelWasCompleted &&
      Array.isArray(level.missions) &&
      level.missions.some((m) => m.status !== 'completed')
    ) {
      level.status = 'in_progress';
      level.completedAt = null;
      changed = true;
    }
    if (applyRewardGating(progress)) {
      changed = true;
    }
  }

  if (changed) {
    refreshCurrentSnapshot(progress);
  }

  return changed;
}

function updatePhotoMissionsForLevel(
  level,
  {
    countApproved = 1,
    missionType = null,
    missionKey = null,
    missionTitle = null,
  } = {}
) {
  if (!level || !Array.isArray(level.missions)) return false;

  const wantedType = String(missionType || '').trim().toLowerCase();
  const wantedKey = String(missionKey || '').trim();
  const wantedTitle = String(missionTitle || '').trim().toLowerCase();

  let changed = false;

  for (const mission of level.missions) {
    if (!mission || mission.active === false) continue;
    if (mission.status === 'completed') continue;

    const currentType = String(mission.type || '').trim().toLowerCase();
    const currentKey = String(mission.missionKey || '').trim();
    const currentTitle = String(mission.title || '').trim().toLowerCase();

    let matchesMission = false;

    if (wantedKey) {
      matchesMission = currentKey === wantedKey;
    } else if (wantedType) {
      matchesMission = currentType === wantedType;
    } else if (wantedTitle) {
      matchesMission = currentTitle === wantedTitle;
    } else {
      matchesMission = isPhotoMission(currentType);
    }

    if (!matchesMission) {
      continue;
    }

    const prev = Number(mission.current || 0);
    const target = Number(mission.target || 1);
    const next = Math.min(target, prev + countApproved);

    if (next !== prev) {
      mission.current = next;
      mission.updatedAt = now();
      changed = true;
    }

    if (next >= target && mission.status !== 'completed') {
      mission.status = 'completed';
      mission.completedAt = now();
      mission.updatedAt = now();
      changed = true;
    } else if (mission.status === 'locked') {
      mission.status = 'in_progress';
      mission.updatedAt = now();
      changed = true;
    }

    if (matchesMission && (wantedKey || wantedType || wantedTitle)) {
      break;
    }
  }

  if (changed) {
    level.progress = computeLevelProgress(level);
  }

  return changed;
}

function finalizeLevelIfCompleted(progress, level) {
  if (!level || !Array.isArray(level.missions)) return false;

  if (!isLevelFullyCompleted(level)) return false;

  if (level.status !== 'completed') {
    level.status = 'completed';
    level.completedAt = now();
    level.progress = 1;
    unlockNextLevel(progress, level.levelNumber);
    return true;
  }

  return false;
}

async function updatePendingClaimsCount(userId, clubId) {
  const count = await PromotionClaim.countDocuments({ user: userId, club: clubId, status: 'pending' });
  await UserClubPromotionProgress.updateOne(
    { user: userId, club: clubId },
    { $set: { pendingClaimsCount: count } }
  );
}

exports.syncPromotionAfterPhotoApproved = async function syncPromotionAfterPhotoApproved({
  userId,
  clubId,
  eventId = null,
  missionType = null,
  missionKey = null,
  missionTitle = null,
  levelNumber = null,
}) {
  try {
    if (!isValidObjectId(userId) || !isValidObjectId(clubId)) {
      return { ok: false, error: 'Invalid userId or clubId' };
    }

    const templates = await getTemplatesForClub(clubId);
    if (!templates.length) {
      return { ok: false, error: 'No templates found' };
    }

    let userDoc = null;
    if (UserModel && isValidObjectId(userId)) {
      userDoc = await UserModel.findById(userId).lean();
    }
    
    const progress = await ensureProgressDoc({
      userId,
      clubId,
      templates,
      userDoc,
    });

    let changed = false;

    for (const level of progress.levels || []) {
      if (!level) continue;
      if (level.status === 'locked') continue;
      if (level.status === 'completed') continue;
      if (levelNumber != null && Number(level.levelNumber) !== Number(levelNumber)) continue;

      const levelChanged = updatePhotoMissionsForLevel(level, {
        countApproved: 1,
        missionType,
        missionKey,
        missionTitle,
      });

      if (levelChanged) {
        changed = true;
        finalizeLevelIfCompleted(progress, level);
      }
    }

    if (applyRewardGating(progress)) {
      changed = true;
    }

    if (!changed) {
      return {
        ok: true,
        changed: false,
        reason: 'No matching photo mission found in promotion progress',
      };
    }

    progress.counters = progress.counters || {};
    progress.counters.photosUploadedInClub = Number(progress.counters.photosUploadedInClub || 0) + 1;
    progress.lastEventId = isValidObjectId(eventId) ? eventId : progress.lastEventId;
    progress.lastActivityAt = now();

    refreshCurrentSnapshot(progress);
    await progress.save();

    return {
      ok: true,
      changed: true,
      currentLevel: progress.currentLevel,
      currentProgress: progress.currentProgress,
    };
  } catch (e) {
    console.error('[promotions] syncPromotionAfterPhotoApproved error:', e);
    return { ok: false, error: 'Server error' };
  }
};

// ===========================
// CONTROLLERS
// ===========================

/**
 * Al ABRIR promociones en la app: recalcula las misiones acumuladas (scan_qr,
 * attend_event, referidos) desde los datos, para que una misión acumulada que
 * el club acaba de añadir muestre ya lo que el usuario tiene, en vez de 0 hasta
 * su siguiente escaneo. Se llama DESPUÉS de guardar la sincronización con
 * plantillas. Solo guarda si algo cambia y no cuenta como actividad (backfill).
 * Devuelve el progreso a enseñar: el recargado si cambió, si no el mismo.
 * Nunca rompe la respuesta: si falla, se enseña el progreso tal cual.
 */
async function withAccumulatedApplied(progress, userId, clubId) {
  try {
    const res = await require('../routes/eventRoutes').syncAccumulatedMissions({
      userId: String(userId),
      clubKey: String(clubId),
      backfill: true,
    });
    if (!res || res.error || !res.changed) return progress;

    const fresh = await UserClubPromotionProgress.findById(progress._id);
    if (!fresh) return progress;
    refreshCurrentSnapshot(fresh); // bloqueo por premio sin canjear, solo para la vista
    return fresh;
  } catch (e) {
    console.warn('[promotions] recálculo del acumulado al abrir falló:', e?.message || e);
    return progress;
  }
}

exports.getMyPromotions = async (req, res) => {
  try {
    const { mongoUser } = await getAuthUser(req);

    if (!mongoUser || !mongoUser._id) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing mongo user' });
    }

    const docs = await UserClubPromotionProgress.find({ user: mongoUser._id })
      .sort({ updatedAt: -1 })
      .exec();

    if (!docs.length) return res.json({ ok: true, promotions: [] });

    const clubIds = docs.map((d) => d.club).filter(Boolean);
    let clubsById = {};
    if (ClubModel && clubIds.length) {
      const clubs = await ClubModel.find({ _id: { $in: clubIds } }).lean();
      clubsById = Object.fromEntries(clubs.map((c) => [c._id.toString(), c]));
    }

    const promotions = [];

    for (const original of docs) {
      let doc = original;
      const clubId = doc.club?.toString?.();
      const clubDoc = clubId ? (clubsById[clubId] || null) : null;

      const templates = clubId && isValidObjectId(clubId)
      ? await getTemplatesForClub(clubId)
      : [];
    
    if (templates.length) {
      let freshUserDoc = mongoUser;
      if ((!freshUserDoc || !freshUserDoc._id) && UserModel && doc.user) {
        freshUserDoc = await UserModel.findById(doc.user).lean();
      }
    
      syncProgressWithTemplates(doc, templates);
      syncCounterBasedMissions(doc, freshUserDoc);
      refreshCurrentSnapshot(doc);
      doc.lastActivityAt = now();
      await doc.save();
      doc = await withAccumulatedApplied(doc, mongoUser._id, clubId);
    }

      promotions.push({
        id: doc._id.toString(),
        clubId: clubId || null,
        clubName: pickClubName(clubDoc),
        clubAvatarUrl: pickClubAvatar(clubDoc),

        currentLevel: Number(doc.currentLevel || 1),
        currentProgress: Number(doc.currentProgress || 0),

        // compatibilidad con pantallas antiguas
        level: Number(doc.currentLevel || 1),
        progress: Number(doc.currentProgress || 0),

        description:
          doc.pendingClaimsCount > 0
            ? `Tienes ${doc.pendingClaimsCount} validación(es) pendiente(s)`
            : (doc.currentRewardTitle ? `Premio: ${doc.currentRewardTitle}` : ''),

        pendingClaimsCount: Number(doc.pendingClaimsCount || 0),

        levels: Array.isArray(doc.levels)
          ? doc.levels.map((level) => ({
              levelNumber: Number(level.levelNumber || 1),
              order: Number(level.order || level.levelNumber || 1),
              title: level.title || `Nivel ${level.levelNumber || 1}`,
              description: level.description || '',
              difficulty: level.difficulty || 'medium',
              status: level.status || 'locked',
              active: level.active !== false,
              visibleInApp: level.visibleInApp !== false,
              progress: Number(level.progress || 0),
              reward: level.reward || null,
              rewardRedeemed: level.rewardRedeemed === true,
              rewardRedeemedAt: level.rewardRedeemedAt || null,
              canRedeemReward:
                Number(level.levelNumber || 0) === Number(doc.currentLevel || 0) &&
                Number(level.progress || 0) >= 1 &&
                level.rewardRedeemed !== true,
              missions: Array.isArray(level.missions)
                ? level.missions
                    .map((mission) => ({
                      missionKey: mission.missionKey || '',
                      type: mission.type || '',
                      title: mission.title || '',
                      description: mission.description || '',
                      target: Number(mission.target || 1),
                      current: Number(mission.current || 0),
                      unit: mission.unit || '',
                      status: mission.status || 'locked',
                      requiresApproval: !!mission.requiresApproval,
                      validationType:
                        mission.validationType ||
                        (mission.requiresApproval ? 'manual' : 'automatic'),
                      order: Number(mission.order || 0),
                      active: mission.active !== false,
                      claimId: mission.claimId || null,
                    }))
                    .sort((a, b) => a.order - b.order)
                : [],
            }))
          : [],
      });
    }

    return res.json({ ok: true, promotions });
  } catch (e) {
    console.error('[promotions] getMyPromotions error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.getClubLevelsForUser = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    const { mongoUser } = await getAuthUser(req);
    if (!mongoUser || !mongoUser._id) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing mongo user' });
    }

    const templates = await getTemplatesForClub(clubId);
    if (!templates.length) {
      return res.status(500).json({
        ok: false,
        error: 'No templates found. Seed PromotionLevelTemplate first.',
      });
    }

    let progress = await ensureProgressDoc({
      userId: mongoUser._id,
      clubId,
      templates,
      userDoc: mongoUser,
    });

    // recalcular snapshot
    let freshUserDoc = mongoUser;
    if ((!freshUserDoc || !freshUserDoc._id) && UserModel) {
      freshUserDoc = await UserModel.findById(progress.user).lean();
    }

    syncCounterBasedMissions(progress, freshUserDoc);
    refreshCurrentSnapshot(progress);
    progress.lastActivityAt = now();
    await progress.save();
    progress = await withAccumulatedApplied(progress, mongoUser._id, clubId);

    return res.json({
      ok: true,
      clubId,
      currentLevel: progress.currentLevel,
      currentProgress: progress.currentProgress,
      pendingClaimsCount: progress.pendingClaimsCount || 0,
      levels: Array.isArray(progress.levels)
        ? progress.levels.map((level) => ({
            ...level.toObject(),
            rewardRedeemed: level.rewardRedeemed === true,
            rewardRedeemedAt: level.rewardRedeemedAt || null,
            canRedeemReward:
              Number(level.levelNumber || 0) === Number(progress.currentLevel || 0) &&
              Number(level.progress || 0) >= 1 &&
              level.rewardRedeemed !== true,
          }))
        : [],
    });
  } catch (e) {
    console.error('[promotions] getClubLevelsForUser error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.createClaim = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    const { mongoUser } = await getAuthUser(req);
    if (!mongoUser || !mongoUser._id) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing mongo user' });
    }

    const {
      levelNumber,
      missionKey,
      missionType,
      evidence,
      userNote,
      eventId,
    } = req.body || {};

    if (!levelNumber || !missionKey || !missionType) {
      return res.status(400).json({
        ok: false,
        error: 'Missing fields: levelNumber, missionKey, missionType',
      });
    }

    const templates = await getTemplatesForClub(clubId);
    if (!templates.length) {
      return res.status(500).json({ ok: false, error: 'No templates found (seed first).' });
    }

    const progress = await ensureProgressDoc({
      userId: mongoUser._id,
      clubId,
      templates,
      userDoc: mongoUser,
    });

    const level = findLevel(progress, levelNumber);
    if (!level) {
      return res.status(404).json({ ok: false, error: 'Level not found in progress' });
    }

    const mission = findMission(level, missionKey);
    if (!mission) {
      return res.status(404).json({ ok: false, error: 'Mission not found in progress' });
    }

    if (!mission.requiresApproval) {
      return res.status(400).json({
        ok: false,
        error: 'This mission does not require approval; it should be auto-completed.',
      });
    }

    // Evitar claims duplicados pending
    const existing = await PromotionClaim.findOne({
      user: mongoUser._id,
      club: clubId,
      levelNumber: Number(levelNumber),
      missionKey,
      status: 'pending',
    }).lean();

    if (existing) {
      return res.status(409).json({ ok: false, error: 'A pending claim already exists for this mission.' });
    }

    const claim = await PromotionClaim.create({
      user: mongoUser._id,
      club: clubId,
      event: isValidObjectId(eventId) ? eventId : null,
      levelNumber: Number(levelNumber),
      missionType: String(missionType),
      missionKey: String(missionKey),
      status: 'pending',
      evidence: normalizeEvidence(evidence),
      userNote: (userNote || '').toString(),
      ip: (req.ip || '').toString(),
      userAgent: (req.headers['user-agent'] || '').toString(),
    });

    // Actualizar misión en progreso
    mission.status = 'pending';
    mission.claimId = claim._id;
    mission.updatedAt = now();

    level.progress = computeLevelProgress(level);
    refreshCurrentSnapshot(progress);
    progress.lastEventId = isValidObjectId(eventId) ? eventId : progress.lastEventId;
    progress.lastActivityAt = now();

    await progress.save();
    await updatePendingClaimsCount(mongoUser._id, clubId);

    return res.status(201).json({ ok: true, claim });
  } catch (e) {
    console.error('[promotions] createClaim error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.cancelClaim = async (req, res) => {
  try {
    const { claimId } = req.params;
    if (!isValidObjectId(claimId)) {
      return res.status(400).json({ ok: false, error: 'Invalid claimId' });
    }

    const { mongoUser } = await getAuthUser(req);
    if (!mongoUser || !mongoUser._id) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing mongo user' });
    }

    const claim = await PromotionClaim.findById(claimId);
    if (!claim) return res.status(404).json({ ok: false, error: 'Claim not found' });

    if (claim.user.toString() !== mongoUser._id.toString()) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (claim.status !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Only pending claims can be cancelled' });
    }

    claim.status = 'cancelled';
    claim.reviewedAt = now();
    await claim.save();

    // Revertir misión pending -> in_progress
    const progress = await UserClubPromotionProgress.findOne({ user: mongoUser._id, club: claim.club });
    if (progress) {
      const level = findLevel(progress, claim.levelNumber);
      const mission = findMission(level, claim.missionKey);
      if (mission && mission.status === 'pending') {
        mission.status = 'in_progress';
        mission.claimId = null;
        mission.updatedAt = now();
        if (level) level.progress = computeLevelProgress(level);
        refreshCurrentSnapshot(progress);
        progress.lastActivityAt = now();
        await progress.save();
      }
      await updatePendingClaimsCount(mongoUser._id, claim.club);
    }

    return res.json({ ok: true, claim });
  } catch (e) {
    console.error('[promotions] cancelClaim error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.listClubClaims = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    if (!(await canManageClub(req, clubId))) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const status = (req.query.status || 'pending').toString();
    const q = { club: clubId };
    if (status) q.status = status;

    const claims = await PromotionClaim.find(q)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({ ok: true, claims });
  } catch (e) {
    console.error('[promotions] listClubClaims error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.approveClaim = async (req, res) => {
  try {
    const { claimId } = req.params;
    if (!isValidObjectId(claimId)) {
      return res.status(400).json({ ok: false, error: 'Invalid claimId' });
    }

    const claim = await PromotionClaim.findById(claimId);
    if (!claim) return res.status(404).json({ ok: false, error: 'Claim not found' });

    if (!(await canManageClub(req, claim.club.toString()))) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (claim.status !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Only pending claims can be approved' });
    }

    const reviewNote = (req.body?.reviewNote || '').toString();

    claim.status = 'approved';
    claim.reviewedBy = req.user?._id || null;
    claim.reviewedAt = now();
    claim.reviewNote = reviewNote;
    await claim.save();

    // Aplicar a progreso
    const progress = await UserClubPromotionProgress.findOne({ user: claim.user, club: claim.club });
    if (!progress) {
      return res.status(200).json({ ok: true, claim, warning: 'Progress doc not found' });
    }

    const level = findLevel(progress, claim.levelNumber);
    const mission = findMission(level, claim.missionKey);

    if (mission) {
      mission.status = 'completed';
      mission.current = Number(mission.target || 1);
      mission.claimId = claim._id;
      mission.completedAt = now();
      mission.updatedAt = now();
    }

    const clubDoc = ClubModel && claim.club
      ? await ClubModel.findById(claim.club).lean()
      : null;

    const clubName = pickClubName(clubDoc);
    const clubAvatar = pickClubAvatar(clubDoc);

    if (mission) {
      await createPromotionNotification({
        userId: claim.user,
        type: 'promotion_completed',
        title: 'Misión completada',
        body: `${mission.title || 'Has completado una misión'} en ${clubName}.`,
        clubId: claim.club,
        clubName,
        previewImage: clubAvatar,
        meta: {
          missionKey: mission.missionKey || null,
          missionTitle: mission.title || '',
          levelNumber: claim.levelNumber,
        },
      });
    }

    if (level) {
      // Si todas misiones completadas => nivel completado
      const allDone = isLevelFullyCompleted(level);
      level.progress = computeLevelProgress(level);

      if (allDone && level.status !== 'completed') {
        level.status = 'completed';
        level.completedAt = now();

        await createPromotionNotification({
          userId: claim.user,
          type: 'promotion_level_up',
          title: `Nivel ${level.levelNumber} completado`,
          body: `Has desbloqueado nuevas recompensas en ${clubName}.`,
          clubId: claim.club,
          clubName,
          previewImage: clubAvatar,
          meta: {
            levelNumber: level.levelNumber,
          },
        });

        // desbloquear siguiente
        unlockNextLevel(progress, level.levelNumber);
      }
    }

    applyRewardGating(progress);
    refreshCurrentSnapshot(progress);
    progress.lastActivityAt = now();
    await progress.save();

    await updatePendingClaimsCount(claim.user, claim.club);

    return res.json({ ok: true, claim });
  } catch (e) {
    console.error('[promotions] approveClaim error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.rejectClaim = async (req, res) => {
  try {
    const { claimId } = req.params;
    if (!isValidObjectId(claimId)) {
      return res.status(400).json({ ok: false, error: 'Invalid claimId' });
    }

    const claim = await PromotionClaim.findById(claimId);
    if (!claim) return res.status(404).json({ ok: false, error: 'Claim not found' });

    if (!(await canManageClub(req, claim.club.toString()))) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (claim.status !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Only pending claims can be rejected' });
    }

    const reviewNote = (req.body?.reviewNote || '').toString();

    claim.status = 'rejected';
    claim.reviewedBy = req.user?._id || null;
    claim.reviewedAt = now();
    claim.reviewNote = reviewNote;
    await claim.save();

    // Aplicar a progreso
    const progress = await UserClubPromotionProgress.findOne({ user: claim.user, club: claim.club });
    if (progress) {
      const level = findLevel(progress, claim.levelNumber);
      const mission = findMission(level, claim.missionKey);
      if (mission) {
        mission.status = 'rejected';
        mission.current = Number(mission.current || 0);
        mission.claimId = null;
        mission.completedAt = null;
        mission.updatedAt = now();
      }
      if (level) level.progress = computeLevelProgress(level);

      let rejectedUserDoc = null;
      if (UserModel && claim.user) {
        rejectedUserDoc = await UserModel.findById(claim.user).lean();
      }
      
      syncCounterBasedMissions(progress, rejectedUserDoc);
      applyRewardGating(progress);
      refreshCurrentSnapshot(progress);
      progress.lastActivityAt = now();
      await progress.save();
      await updatePendingClaimsCount(claim.user, claim.club);
    }

    return res.json({ ok: true, claim });
  } catch (e) {
    console.error('[promotions] rejectClaim error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.redeemCurrentLevelReward = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    const { mongoUser } = await getAuthUser(req);
    if (!mongoUser || !mongoUser._id) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing mongo user' });
    }

    const templates = await getTemplatesForClub(clubId);
    if (!templates.length) {
      return res.status(500).json({ ok: false, error: 'No templates found. Seed PromotionLevelTemplate first.' });
    }

    let freshUserDoc = mongoUser;
    if ((!freshUserDoc || !freshUserDoc._id) && UserModel) {
      freshUserDoc = await UserModel.findById(mongoUser._id).lean();
    }

    const progress = await ensureProgressDoc({
      userId: mongoUser._id,
      clubId,
      templates,
      userDoc: freshUserDoc,
    });

    syncCounterBasedMissions(progress, freshUserDoc);
    applyRewardGating(progress);

    const level = findLevel(progress, progress.currentLevel);
    if (!level) {
      return res.status(404).json({ ok: false, error: 'Current level not found' });
    }

    // Progreso recalculado (no el guardado): un nivel sin misiones recién
    // alcanzado puede tener guardado 0 de cuando estaba bloqueado.
    if (computeLevelProgress(level) < 1 || !isLevelFullyCompleted(level)) {
      return res.status(400).json({ ok: false, error: 'Current level is not completed yet' });
    }

    if (level.rewardRedeemed === true) {
      return res.status(409).json({ ok: false, error: 'Reward already redeemed for this level' });
    }

    level.rewardRedeemed = true;
    level.rewardRedeemedAt = now();
    level.updatedAt = now();

    const nextLevel = getNextLevel(progress, level.levelNumber);
    if (nextLevel) {
      if (nextLevel.status === 'locked') {
        nextLevel.status = 'in_progress';
      }

      for (const mission of nextLevel.missions || []) {
        if (mission.status === 'locked') {
          mission.status = 'in_progress';
          mission.updatedAt = now();
        }
        if (!mission.startedAt) {
          mission.startedAt = now();
        }
      }

      progress.currentLevel = nextLevel.levelNumber;
      // Nivel sin misiones (el 10): queda completado al llegar, listo para canjear
      finalizeLevelIfCompleted(progress, nextLevel);
    } else {
      progress.currentLevel = level.levelNumber;
    }

    refreshCurrentSnapshot(progress);
    progress.lastActivityAt = now();
    await progress.save();

    // El nivel recién desbloqueado recibe el acumulado del club (scan_qr,
    // attend_event, share_event, link_clicks, referred_purchases): si ya lo
    // cumple, se completa en el acto. Carga perezosa.
    let view = progress; // lo que se devuelve: el progreso ya con el acumulado aplicado
    try {
      await require('../routes/eventRoutes').syncAccumulatedMissions({
        userId: String(mongoUser._id),
        clubKey: String(clubId),
      });
      const fresh = await UserClubPromotionProgress.findOne({ user: mongoUser._id, club: clubId });
      if (fresh) {
        refreshCurrentSnapshot(fresh); // aplica también el bloqueo por premio sin canjear
        view = fresh;
      }
    } catch (e) {
      console.warn('[promotions] redeem: sync del acumulado falló:', e?.message || e);
    }

    const clubDoc = ClubModel && clubId
      ? await ClubModel.findById(clubId).lean()
      : null;

    const clubName = pickClubName(clubDoc);
    const clubAvatar = pickClubAvatar(clubDoc);

    await createPromotionNotification({
      userId: mongoUser._id,
      type: 'promotion_reward_claimed',
      title: 'Premio canjeado',
      body: `Has canjeado una recompensa de ${clubName}.`,
      clubId,
      clubName,
      previewImage: clubAvatar,
      meta: {
        levelNumber: level.levelNumber,
        rewardTitle: level.reward?.title || '',
      },
    });

    return res.json({
      ok: true,
      clubId,
      currentLevel: view.currentLevel,
      currentProgress: view.currentProgress,
      redeemedLevelNumber: level.levelNumber,
      redeemedAt: level.rewardRedeemedAt,
      levels: Array.isArray(view.levels)
        ? view.levels.map((entry) => ({
            ...entry.toObject(),
            rewardRedeemed: entry.rewardRedeemed === true,
            rewardRedeemedAt: entry.rewardRedeemedAt || null,
            canRedeemReward:
              Number(entry.levelNumber || 0) === Number(view.currentLevel || 0) &&
              Number(entry.progress || 0) >= 1 &&
              entry.rewardRedeemed !== true,
          }))
        : [],
    });
  } catch (e) {
    console.error('[promotions] redeemCurrentLevelReward error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};


exports.getClubPromotionConfig = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    if (!(await canManageClub(req, clubId))) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const templates = await ensureClubTemplates(clubId);

    return res.json({
      ok: true,
      clubId,
      levels: templates.map(serializeLevelDoc).sort((a, b) => a.order - b.order),
      // Tipos de premio para el selector del portal: [{ type, label }]
      rewardTypes: rewardTypeOptions(),
    });
  } catch (e) {
    console.error('[promotions] getClubPromotionConfig error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

/**
 * Valida TODOS los niveles con el esquema real ANTES de tocar la base de datos.
 * Devuelve la lista de problemas (vacía si todo está bien).
 */
async function validateLevelDocs(docs) {
  const problems = [];

  const seen = new Map();
  docs.forEach((d, idx) => {
    const n = Number(d.levelNumber);
    if (seen.has(n)) {
      problems.push({ levelIndex: idx, levelNumber: n, path: 'levelNumber', message: `Número de nivel repetido (también en la posición ${seen.get(n)})` });
    } else {
      seen.set(n, idx);
    }
  });

  for (let idx = 0; idx < docs.length; idx++) {
    try {
      await new PromotionLevelTemplate(docs[idx]).validate();
    } catch (e) {
      const errors = e?.errors ? Object.values(e.errors) : [e];
      for (const err of errors) {
        problems.push({
          levelIndex: idx,
          levelNumber: docs[idx].levelNumber,
          path: err?.path || null,
          message: err?.message || String(err),
        });
      }
    }
  }

  return problems;
}

/**
 * Sustituye TODOS los niveles del club por `docs` sin riesgo de dejarlo vacío.
 *  1) Con transacción (Atlas / réplica): borrar + insertar en la misma sesión;
 *     si algo falla, Mongo deshace todo.
 *  2) Sin transacciones (servidor standalone): se guarda copia de los niveles
 *     actuales, se borra e inserta, y si la inserción falla se RESTAURA la copia.
 *     No es atómico ante una caída del proceso a mitad, pero cubre cualquier
 *     error de inserción.
 * Si falla, lanza el error: la configuración anterior sigue en la BD.
 */
async function replaceClubTemplates(clubId, docs) {
  const filter = { scope: 'club', club: clubId };

  const doneInTransaction = await runInTransactionIfSupported(async (session) => {
    await PromotionLevelTemplate.deleteMany(filter, { session });
    if (docs.length) {
      await PromotionLevelTemplate.insertMany(docs, { session, ordered: true });
    }
  });
  if (doneInTransaction) return 'transaction';

  const previous = await PromotionLevelTemplate.find(filter).lean();
  await PromotionLevelTemplate.deleteMany(filter);
  try {
    if (docs.length) {
      await PromotionLevelTemplate.insertMany(docs, { ordered: true });
    }
    return 'restore_on_failure';
  } catch (insertErr) {
    try {
      await PromotionLevelTemplate.deleteMany(filter); // restos de una inserción parcial
      if (previous.length) {
        await PromotionLevelTemplate.insertMany(previous, { ordered: true });
      }
      console.error('[promotions] Fallo al guardar niveles; configuración anterior restaurada', {
        clubId: String(clubId),
        error: insertErr?.message || insertErr,
      });
    } catch (restoreErr) {
      // Último recurso: dejar la copia en el log para poder recuperarla a mano.
      console.error(
        '🚨 [promotions] NO se pudo restaurar la configuración del club tras un fallo. Copia:',
        JSON.stringify({ clubId: String(clubId), levels: previous }),
        restoreErr
      );
    }
    throw insertErr;
  }
}

/**
 * PUT /api/promotions/clubs/:clubId/levels/:levelNumber
 * Guarda UN nivel del club sin tocar los demás:
 *  - valida solo ese nivel (título, premio, criterio de las fotos, esquema);
 *    un problema en otro nivel no le afecta,
 *  - reemplaza solo ese documento (sin deleteMany/insertMany del club),
 *  - conserva las claves de misión (assignMissionKeys).
 * Lo que no venga en el cuerpo se queda como estaba (p. ej. sin `missions`
 * se mantienen las misiones; el premio se mezcla con el actual).
 * Cuerpo: el nivel, directamente o en { level: {...} }.
 */
exports.upsertClubLevel = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }
    const levelNumber = Number(req.params.levelNumber);
    if (!Number.isInteger(levelNumber) || levelNumber < 1 || levelNumber > 100) {
      return res.status(400).json({ ok: false, error: 'invalid_level_number', message: 'El número de nivel debe estar entre 1 y 100' });
    }

    if (!(await canManageClub(req, clubId))) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const body = req.body && typeof req.body.level === 'object' && req.body.level ? req.body.level : req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: 'invalid_body' });
    }
    if (body.levelNumber !== undefined && Number(body.levelNumber) !== levelNumber) {
      return res.status(400).json({
        ok: false,
        error: 'level_number_mismatch',
        message: 'El número de nivel del cuerpo no coincide con el de la ruta',
      });
    }

    // Si el club aún usa las globales, se le crean sus copias (como la ruta de todos)
    await ensureClubTemplates(clubId);
    const existing = await PromotionLevelTemplate.findOne({ scope: 'club', club: clubId, levelNumber });
    const prev = existing ? existing.toObject() : null;

    // Lo que no venga se queda como estaba
    const merged = {
      ...(prev
        ? {
            title: prev.title,
            description: prev.description,
            difficulty: prev.difficulty,
            order: prev.order,
            status: prev.status,
            active: prev.active,
            visibleInApp: prev.visibleInApp,
            version: prev.version,
            missions: prev.missions,
          }
        : {}),
      ...body,
      levelNumber,
      reward: { ...(prev?.reward || {}), ...(body.reward && typeof body.reward === 'object' ? body.reward : {}) },
    };
    // status y active van juntos: si solo llega uno, el otro se deduce de él
    if (body.status !== undefined && body.active === undefined) delete merged.active;
    if (body.active !== undefined && body.status === undefined) delete merged.status;
    // Tipo de premio cambiado sin título nuevo: que se autogenere del tipo
    // nuevo (si no, un "1 chupito" pasado a copa seguiría diciendo chupito).
    if (body.reward && body.reward.type && prev?.reward && body.reward.type !== prev.reward.type && body.reward.title === undefined) {
      delete merged.reward.title;
    }

    // ---- Validar SOLO este nivel ----
    if (!String(merged.title || '').trim()) {
      return res.status(400).json({ ok: false, error: 'level_title_required', levelNumber, message: 'El nivel necesita un título' });
    }
    const doc = { scope: 'club', club: clubId, ...normalizeLevelInput(merged, levelNumber - 1) };
    const invalid = findInvalidPhotoCriteria([doc]) || findInvalidReward([doc]);
    if (invalid) {
      return res.status(400).json({ ok: false, ...invalid });
    }
    const problems = await validateLevelDocs([doc]);
    if (problems.length) {
      return res.status(400).json({ ok: false, error: 'invalid_levels', problems });
    }

    // Claves de misión estables (por _id, nivel + tipo + orden, o tipo)
    PromotionLevelTemplate.assignMissionKeys([doc], prev ? [prev] : []);

    // ---- Guardar SOLO este documento ----
    let saved;
    try {
      if (existing) {
        existing.set(doc);
        saved = await existing.save();
      } else {
        saved = await new PromotionLevelTemplate(doc).save();
      }
    } catch (saveErr) {
      if (saveErr?.name === 'VersionError' || isDuplicateKeyError(saveErr)) {
        return res.status(409).json({
          ok: false,
          error: 'conflict',
          message: 'Este nivel se ha guardado a la vez desde otro sitio. Recarga y vuelve a intentarlo.',
        });
      }
      console.error('[promotions] upsertClubLevel: no se guardó:', saveErr?.message || saveErr);
      return res.status(500).json({
        ok: false,
        error: 'save_failed',
        message: 'No se ha guardado el nivel. Los demás niveles no se han tocado.',
      });
    }

    return res.json({
      ok: true,
      clubId,
      level: serializeLevelDoc(saved),
      rewardTypes: rewardTypeOptions(),
    });
  } catch (e) {
    console.error('[promotions] upsertClubLevel error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.upsertClubLevelOverrides = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    if (!(await canManageClub(req, clubId))) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const payloadLevels = Array.isArray(req.body?.levels) ? req.body.levels : null;
    if (!payloadLevels) {
      return res.status(400).json({ ok: false, error: 'Missing levels array' });
    }
    // Una lista vacía borraría todo y en la siguiente carga volverían las
    // plantillas por defecto sin avisar: casi seguro un error del cliente.
    if (!payloadLevels.length) {
      return res.status(400).json({ ok: false, error: 'no_levels', message: 'Debe haber al menos un nivel' });
    }

    const docsToInsert = payloadLevels.map((level, idx) => ({
      scope: 'club',
      club: clubId,
      ...normalizeLevelInput(level, idx),
    }));

    // ---- Validar TODO antes de tocar la BD: si falla, 400 y nada cambia ----
    const invalid = findInvalidPhotoCriteria(docsToInsert) || findInvalidReward(docsToInsert);
    if (invalid) {
      return res.status(400).json({ ok: false, ...invalid });
    }
    const problems = await validateLevelDocs(docsToInsert);
    if (problems.length) {
      return res.status(400).json({ ok: false, error: 'invalid_levels', problems });
    }

    const current = await ensureClubTemplates(clubId);

    // Claves de misión ESTABLES: se conservan las que ya había (por _id o por
    // nivel + tipo + orden) aunque el portal no mande el _id de las misiones.
    // Sin esto, cada guardado cambiaba las claves y el progreso de los usuarios
    // y sus fotos perdían el vínculo con la misión.
    PromotionLevelTemplate.assignMissionKeys(
      docsToInsert,
      current.map((d) => (typeof d.toObject === 'function' ? d.toObject() : d))
    );

    // Reemplazo completo de la configuración del club, sin poder dejarla vacía.
    try {
      await replaceClubTemplates(clubId, docsToInsert);
    } catch (saveErr) {
      console.error('[promotions] upsertClubLevelOverrides: no se guardó:', saveErr?.message || saveErr);
      return res.status(500).json({
        ok: false,
        error: 'save_failed',
        message: 'No se han guardado los cambios. Tu configuración anterior sigue intacta.',
      });
    }

    const saved = await PromotionLevelTemplate.find({ scope: 'club', club: clubId })
      .sort({ order: 1, levelNumber: 1 })
      .exec();

    return res.json({
      ok: true,
      clubId,
      levels: saved.map(serializeLevelDoc).sort((a, b) => a.order - b.order),
      rewardTypes: rewardTypeOptions(),
    });
  } catch (e) {
    console.error('[promotions] upsertClubLevelOverrides error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
