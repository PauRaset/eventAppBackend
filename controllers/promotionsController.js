// controllers/promotionsController.js
const mongoose = require('mongoose');

const PromotionLevelTemplate = require('../models/PromotionLevelTemplate');
const UserClubPromotionProgress = require('../models/UserClubPromotionProgress');
const PromotionClaim = require('../models/PromotionClaim');
const Notification = require('../models/Notification');
const { sendPushNotificationToUser } = require('../utils/sendPushNotification');

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
 * Permisos club/admin para validar claims.
 * Ajusta según tu esquema real de roles.
 */
function canManageClub(req, clubId) {
  const u = req.user || {};
  const role = (u.role || u.type || u.userType || '').toString().toLowerCase();

  if (role === 'admin') return true;
  if (role === 'club') return true;

  // Algunos backends usan el propio userId como clubId
  if (u._id && clubId && u._id.toString() === clubId.toString()) return true;

  // Si tienes clubId en user
  if (u.clubId && clubId && u.clubId.toString() === clubId.toString()) return true;

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
  if (missions.length === 0) return 0;

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

function isLevelFullyCompleted(level) {
  if (!level || !Array.isArray(level.missions) || level.missions.length === 0) {
    return false;
  }

  return level.missions.every((mission) => isMissionEffectivelyCompleted(mission));
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
    ...(mission._id ? { _id: mission._id } : {}),
    type,
    title,
    description,
    target,
    unit: String(mission.unit || '').trim(),
    params: mission.params && typeof mission.params === 'object' ? mission.params : {},
    validationType: String(mission.validationType || (requiresApproval ? 'manual' : 'automatic')).trim() || 'automatic',
    requiresApproval,
    order,
    active,
  };
}

function normalizeRewardInput(reward = {}) {
  const rawValue = reward?.value;

  let numericValue = null;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    numericValue = rawValue;
  } else if (
    typeof rawValue === 'string' &&
    rawValue.trim() !== '' &&
    !Number.isNaN(Number(rawValue))
  ) {
    numericValue = Number(rawValue);
  }

  return {
    type: String(reward.type || 'custom').trim() || 'custom',
    title: String(reward.title || '').trim(),
    description: String(reward.description || '').trim(),
    value: numericValue,
    active: typeof reward.active === 'boolean' ? reward.active : true,
  };
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
              type: m?.type || '',
              title: m?.title || '',
              description: m?.description || '',
              target: Number(m?.target || 1),
              unit: m?.unit || '',
              params: m?.params || {},
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

  if (docsToInsert.length) {
    await PromotionLevelTemplate.insertMany(docsToInsert, { ordered: true });
  }

  clubTemplates = await PromotionLevelTemplate.find({ scope: 'club', club: clubId })
    .sort({ order: 1, levelNumber: 1 })
    .exec();

  return clubTemplates;
}

async function getTemplatesForClub(clubId) {
  // Si existe override por club, lo usamos; si no, global
  const clubTemplates = await PromotionLevelTemplate.find({
    scope: 'club',
    club: clubId,
    active: true,
  }).lean();

  if (clubTemplates && clubTemplates.length) {
    return clubTemplates.sort((a, b) => a.levelNumber - b.levelNumber);
  }

  const globalTemplates = await PromotionLevelTemplate.find({
    scope: 'global',
    active: true,
  }).lean();

  return (globalTemplates || []).sort((a, b) => a.levelNumber - b.levelNumber);
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

function syncMissionWithTemplate(existingMission, templateMission, missionIndex = 0) {
  const missionKey = getTemplateMissionKey(templateMission, missionIndex);

  return {
    missionKey,
    type: String(templateMission.type || ''),
    title: String(templateMission.title || ''),
    description: String(templateMission.description || ''),
    target: Number(templateMission.target || 1),
    unit: String(templateMission.unit || ''),
    params: templateMission.params && typeof templateMission.params === 'object' ? templateMission.params : {},
    validationType:
      String(
        templateMission.validationType ||
          (templateMission.requiresApproval ? 'manual' : 'automatic')
      ) || 'automatic',
    requiresApproval: !!templateMission.requiresApproval,
    order: Number(templateMission.order || missionIndex + 1),
    active: templateMission.active !== false,
    status: existingMission?.status || 'in_progress',
    current: Number(existingMission?.current || 0),
    claimId: existingMission?.claimId || null,
    startedAt: existingMission?.startedAt || now(),
    completedAt: existingMission?.completedAt || null,
    updatedAt: now(),
  };
}

function syncLevelWithTemplate(existingLevel, templateLevel, levelIndex = 0) {
  const existingMissions = Array.isArray(existingLevel?.missions) ? existingLevel.missions : [];
  const missionsByKey = new Map(
    existingMissions.map((mission, idx) => [getTemplateMissionKey(mission, idx), mission])
  );

  const nextLevelNumber = Number(templateLevel.levelNumber || levelIndex + 1);
  const nextMissions = Array.isArray(templateLevel.missions)
    ? templateLevel.missions
        .map((mission, missionIndex) => {
          const missionKey = getTemplateMissionKey(mission, missionIndex);
          const existingMission =
            missionsByKey.get(missionKey) ||
            existingMissions[missionIndex] ||
            null;
          return syncMissionWithTemplate(existingMission, mission, missionIndex);
        })
        .sort((a, b) => a.order - b.order)
    : [];

  let nextStatus = existingLevel?.status || (nextLevelNumber === 1 ? 'in_progress' : 'locked');
  if (nextMissions.length && nextMissions.every((mission) => isMissionEffectivelyCompleted(mission))) {
    nextStatus = 'completed';
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

function isPhotoMissionType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  if (!normalized) return false;

  return (
    normalized === 'approved_event_photo' ||
    normalized.includes('photo') ||
    normalized.includes('foto')
  );
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
      matchesMission = isPhotoMissionType(currentType);
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

  const allDone =
    level.missions.length > 0 &&
    level.missions.every((m) => isMissionEffectivelyCompleted(m));

  if (!allDone) return false;

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

    for (const doc of docs) {
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

    const progress = await ensureProgressDoc({
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

    if (!canManageClub(req, clubId)) {
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

    if (!canManageClub(req, claim.club.toString())) {
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
      const missions = level.missions || [];
      const allDone = missions.length > 0 && missions.every((m) => isMissionEffectivelyCompleted(m));
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

    if (!canManageClub(req, claim.club.toString())) {
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

    if (Number(level.progress || 0) < 1 || !isLevelFullyCompleted(level)) {
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
    } else {
      progress.currentLevel = level.levelNumber;
    }

    refreshCurrentSnapshot(progress);
    progress.lastActivityAt = now();
    await progress.save();

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
      currentLevel: progress.currentLevel,
      currentProgress: progress.currentProgress,
      redeemedLevelNumber: level.levelNumber,
      redeemedAt: level.rewardRedeemedAt,
      levels: Array.isArray(progress.levels)
        ? progress.levels.map((entry) => ({
            ...entry.toObject(),
            rewardRedeemed: entry.rewardRedeemed === true,
            rewardRedeemedAt: entry.rewardRedeemedAt || null,
            canRedeemReward:
              Number(entry.levelNumber || 0) === Number(progress.currentLevel || 0) &&
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

    if (!canManageClub(req, clubId)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const templates = await ensureClubTemplates(clubId);

    return res.json({
      ok: true,
      clubId,
      levels: templates.map(serializeLevelDoc).sort((a, b) => a.order - b.order),
    });
  } catch (e) {
    console.error('[promotions] getClubPromotionConfig error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.upsertClubLevelOverrides = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    if (!canManageClub(req, clubId)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const payloadLevels = Array.isArray(req.body?.levels) ? req.body.levels : null;
    if (!payloadLevels) {
      return res.status(400).json({ ok: false, error: 'Missing levels array' });
    }

    await ensureClubTemplates(clubId);

    // Reemplazo completo de la configuración del club para simplificar la primera versión.
    await PromotionLevelTemplate.deleteMany({ scope: 'club', club: clubId });

    const docsToInsert = payloadLevels.map((level, idx) => ({
      scope: 'club',
      club: clubId,
      ...normalizeLevelInput(level, idx),
    }));

    if (docsToInsert.length) {
      await PromotionLevelTemplate.insertMany(docsToInsert, { ordered: true });
    }

    const saved = await PromotionLevelTemplate.find({ scope: 'club', club: clubId })
      .sort({ order: 1, levelNumber: 1 })
      .exec();

    return res.json({
      ok: true,
      clubId,
      levels: saved.map(serializeLevelDoc).sort((a, b) => a.order - b.order),
    });
  } catch (e) {
    console.error('[promotions] upsertClubLevelOverrides error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
