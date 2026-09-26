const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// Esquema compatible con login clásico + Firebase (teléfono)
const userSchema = new mongoose.Schema(
  {
    // ---- Identidad básica (mantengo lo que ya tenías) ----
    username: { type: String, required: true, trim: true },

    // email no requerido para permitir alta por teléfono/Firebase
    email: { type: String, unique: true, sparse: true },

    // Guardamos SIEMPRE el hash aquí (nunca texto plano).
    // Nota: añadimos un virtual "passwordHash" para compatibilidad.
    password: { type: String },

    // Campos existentes en tu app (según capturas)
    entName: { type: String, default: "" }, // legado / compat
    entityName: { type: String, default: "" }, // nombre visible actual
    wUser: { type: String, default: "" }, // si lo usas
    profilePicture: { type: String, default: "" },
    instagram: { type: String, default: "" },
    bio: { type: String, default: "" },
    isPrivate: { type: Boolean, default: false },

    // ---- Privacidad social granular ----
    privacySettings: {
      attendancesVisibility: {
        type: String,
        enum: ["public", "followers", "private"],
        default: "followers",
      },
      momentsVisibility: {
        type: String,
        enum: ["public", "followers", "private"],
        default: "followers",
      },
      locationVisibility: {
        type: String,
        enum: ["public", "followers", "private"],
        default: "private",
      },
    },

    attendancesVisibility: {
      type: String,
      enum: ["public", "followers", "private"],
      default: "followers",
      index: true,
    },

    momentsVisibility: {
      type: String,
      enum: ["public", "followers", "private"],
      default: "followers",
      index: true,
    },

    locationVisibility: {
      type: String,
      enum: ["public", "followers", "private"],
      default: "private",
      index: true,
    },

    role: { type: String, enum: ["club", "spectator"], default: "spectator" },

    // --- Social (seguidores / seguidos) ---
    followers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
      index: true,
    },
    following: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
      index: true,
    },

    // --- Solicitudes de seguimiento para perfiles privados ---
    followRequestsReceived: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
      index: true,
    },
    followRequestsSent: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
      index: true,
    },

    followersCount: { type: Number, default: 0 },
    followingCount: { type: Number, default: 0 },

    facebookId: { type: String, unique: true, sparse: true },
    instagramId: { type: String, unique: true, sparse: true },

    // ---- Integración Firebase ----
    firebaseUid: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },
    phoneNumber: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },

    // ---- Push notifications / Firebase Cloud Messaging ----
    fcmTokens: {
      type: [
        {
          token: {
            type: String,
            required: true,
            trim: true,
          },
          platform: {
            type: String,
            enum: ['ios', 'android', 'web', 'unknown'],
            default: 'unknown',
          },
          deviceName: {
            type: String,
            default: '',
          },
          lastSeenAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },

    // ---- Reset / creación de contraseña (nuevo) ----
    resetPasswordToken: { type: String, index: true },
    resetPasswordExpires: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        // No exponer datos sensibles
        delete ret.password;
        delete ret.resetPasswordToken;
        delete ret.resetPasswordExpires;

        // Exponer siempre entityName para el frontend
        if (!ret.entityName && ret.entName) ret.entityName = ret.entName;

        return ret;
      },
    },
  }
);

/* -------------------------------- Virtuales ------------------------------- */
/**
 * Compatibilidad: algunos módulos pueden leer/escribir "passwordHash".
 * Este virtual mapea a "password" (que siempre almacena el hash).
 */
userSchema
  .virtual("passwordHash")
  .get(function () {
    return this.password;
  })
  .set(function (v) {
    this.password = v;
  });

// Índices útiles
userSchema.index({ phoneNumber: 1 });
userSchema.index({ firebaseUid: 1 });
userSchema.index({ instagram: 1 });
userSchema.index({ followersCount: 1 });
userSchema.index({ followingCount: 1 });
userSchema.index({ followRequestsReceived: 1 });
userSchema.index({ followRequestsSent: 1 });

/* ----------------------------- Hooks & helpers ---------------------------- */

function onlyUploadPath(input) {
  if (!input || typeof input !== 'string') return input;
  const i = input.indexOf('/uploads/');
  if (i !== -1) return input.slice(i); // mantiene desde /uploads/...
  return input; // ya es relativo o viene con otro formato (respetar)
}

// Normaliza email y sincroniza entityName <-> entName
userSchema.pre("save", function (next) {
  if (this.email) this.email = this.email.toLowerCase().trim();

  // Sincronía nombres
  if (!this.entityName && this.entName) this.entityName = this.entName;
  if (this.entityName && !this.entName) this.entName = this.entityName;

  if (this.profilePicture) {
    this.profilePicture = onlyUploadPath(this.profilePicture.trim());
  }

  // Sincronizar privacySettings con campos legacy/directos
  const normalizeVisibility = (value, fallback) => {
    const raw = (value || fallback).toString().toLowerCase().trim();
    if (["public", "followers", "private"].includes(raw)) return raw;
    return fallback;
  };

  const attendancesVisibility = normalizeVisibility(
    this.attendancesVisibility || this.privacySettings?.attendancesVisibility,
    "followers"
  );

  const momentsVisibility = normalizeVisibility(
    this.momentsVisibility || this.privacySettings?.momentsVisibility,
    "followers"
  );

  const locationVisibility = normalizeVisibility(
    this.locationVisibility || this.privacySettings?.locationVisibility,
    "private"
  );

  this.attendancesVisibility = attendancesVisibility;
  this.momentsVisibility = momentsVisibility;
  this.locationVisibility = locationVisibility;

  this.privacySettings = {
    attendancesVisibility,
    momentsVisibility,
    locationVisibility,
  };

  next();
});

// Encripta la contraseña SOLO si existe y cambió.
// Si ya parece un hash bcrypt ($2a/$2b/$2y...), no re-hashear.
userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();

  const looksHashed =
    typeof this.password === "string" && /^\$2[aby]\$/.test(this.password);
  if (looksHashed) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Asegura arrays únicos y counters sincronizados antes de guardar
userSchema.pre("save", function (next) {
  // Deduplicar manteniendo el orden original
  function uniqObjectIds(arr) {
    if (!Array.isArray(arr)) return arr;
    const seen = new Set();
    const out = [];
    for (const v of arr) {
      const key = v?.toString?.() ?? String(v);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    }
    return out;
  }

  if (Array.isArray(this.followers)) {
    this.followers = uniqObjectIds(this.followers);
    this.followersCount = this.followers.length;
  }
  if (Array.isArray(this.following)) {
    this.following = uniqObjectIds(this.following);
    this.followingCount = this.following.length;
  }
  if (Array.isArray(this.followRequestsReceived)) {
    this.followRequestsReceived = uniqObjectIds(this.followRequestsReceived);
  }
  if (Array.isArray(this.followRequestsSent)) {
    this.followRequestsSent = uniqObjectIds(this.followRequestsSent);
  }

  // Deduplicar FCM tokens
  if (Array.isArray(this.fcmTokens)) {
    const seen = new Set();
    this.fcmTokens = this.fcmTokens.filter((entry) => {
      const token = (entry?.token || '').trim();
      if (!token) return false;
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });
  }

  next();
});

// Comparar contraseñas cuando exista password local (bcrypt)
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

// Fijar contraseña programáticamente (hashea y asigna)
userSchema.methods.setPassword = async function (plain) {
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(plain, salt);
  return this.password;
};

// Helper to safely convert to ObjectId
const toObjectId = (v) => {
  try {
    if (!v) return null;
    if (v instanceof mongoose.Types.ObjectId) return v;
    return new mongoose.Types.ObjectId(String(v));
  } catch {
    return null;
  }
};

// ---------------------------- Follow / Unfollow ----------------------------
userSchema.methods.follow = async function (targetId) {
  const me = this;
  const tid = toObjectId(targetId);
  if (!tid) throw new Error('TARGET_REQUIRED');
  if (me._id.equals(tid)) throw new Error('NO_SELF_FOLLOW');

  const User = mongoose.model('User');
  const target = await User.findById(tid);
  if (!target) throw new Error('TARGET_NOT_FOUND');

  // ¿ya le sigo?
  const already = me.following.some((id) => id.equals(tid));
  if (already) {
    return { changed: false, isFollowing: true };
  }

  me.following.push(tid);
  target.followers.push(me._id);

  me.followingCount = me.following.length;
  target.followersCount = target.followers.length;

  await Promise.all([me.save(), target.save()]);
  return { changed: true, isFollowing: true };
};

userSchema.methods.unfollow = async function (targetId) {
  const me = this;
  const tid = toObjectId(targetId);
  if (!tid) throw new Error('TARGET_REQUIRED');
  if (me._id.equals(tid)) throw new Error('NO_SELF_UNFOLLOW');

  const User = mongoose.model('User');
  const target = await User.findById(tid);
  if (!target) throw new Error('TARGET_NOT_FOUND');

  const beforeMe = me.following.length;
  const beforeTarget = target.followers.length;

  me.following = me.following.filter((id) => !id.equals(tid));
  target.followers = target.followers.filter((id) => !id.equals(me._id));

  const changed = me.following.length !== beforeMe || target.followers.length !== beforeTarget;

  me.followingCount = me.following.length;
  target.followersCount = target.followers.length;

  await Promise.all([me.save(), target.save()]);
  return { changed, isFollowing: false };
};

userSchema.methods.toggleFollow = async function (targetId) {
  const me = this;
  const tid = toObjectId(targetId);
  if (!tid) throw new Error('TARGET_REQUIRED');
  if (me._id.equals(tid)) throw new Error('NO_SELF_TOGGLE');

  const isFollowing = me.following.some((id) => id.equals(tid));
  if (isFollowing) {
    return this.unfollow(tid);
  } else {
    return this.follow(tid);
  }
};

// ------------------------- Follow Requests privados -------------------------
userSchema.methods.requestFollow = async function (targetId) {
  const me = this;
  const tid = toObjectId(targetId);
  if (!tid) throw new Error('TARGET_REQUIRED');
  if (me._id.equals(tid)) throw new Error('NO_SELF_FOLLOW_REQUEST');

  const User = mongoose.model('User');
  const target = await User.findById(tid);
  if (!target) throw new Error('TARGET_NOT_FOUND');

  const alreadyFollowing = me.following.some((id) => id.equals(tid));
  if (alreadyFollowing) {
    return {
      changed: false,
      isFollowing: true,
      requestPending: false,
      isPrivate: !!target.isPrivate,
    };
  }

  // Si el perfil no es privado, el request se convierte en follow normal.
  if (!target.isPrivate) {
    return this.follow(tid);
  }

  const alreadyPending =
    me.followRequestsSent.some((id) => id.equals(tid)) ||
    target.followRequestsReceived.some((id) => id.equals(me._id));

  if (alreadyPending) {
    return {
      changed: false,
      isFollowing: false,
      requestPending: true,
      isPrivate: true,
    };
  }

  me.followRequestsSent.push(tid);
  target.followRequestsReceived.push(me._id);

  await Promise.all([me.save(), target.save()]);

  return {
    changed: true,
    isFollowing: false,
    requestPending: true,
    isPrivate: true,
  };
};

userSchema.methods.cancelFollowRequest = async function (targetId) {
  const me = this;
  const tid = toObjectId(targetId);
  if (!tid) throw new Error('TARGET_REQUIRED');
  if (me._id.equals(tid)) throw new Error('NO_SELF_CANCEL_REQUEST');

  const User = mongoose.model('User');
  const target = await User.findById(tid);
  if (!target) throw new Error('TARGET_NOT_FOUND');

  const beforeMe = me.followRequestsSent.length;
  const beforeTarget = target.followRequestsReceived.length;

  me.followRequestsSent = me.followRequestsSent.filter((id) => !id.equals(tid));
  target.followRequestsReceived = target.followRequestsReceived.filter((id) => !id.equals(me._id));

  const changed =
    me.followRequestsSent.length !== beforeMe ||
    target.followRequestsReceived.length !== beforeTarget;

  await Promise.all([me.save(), target.save()]);

  return {
    changed,
    isFollowing: false,
    requestPending: false,
    isPrivate: !!target.isPrivate,
  };
};

userSchema.methods.acceptFollowRequest = async function (requesterId) {
  const target = this;
  const rid = toObjectId(requesterId);
  if (!rid) throw new Error('REQUESTER_REQUIRED');
  if (target._id.equals(rid)) throw new Error('NO_SELF_ACCEPT_REQUEST');

  const User = mongoose.model('User');
  const requester = await User.findById(rid);
  if (!requester) throw new Error('REQUESTER_NOT_FOUND');

  const wasPending =
    target.followRequestsReceived.some((id) => id.equals(rid)) ||
    requester.followRequestsSent.some((id) => id.equals(target._id));

  if (!wasPending) {
    return {
      changed: false,
      accepted: false,
      isFollowing: requester.following.some((id) => id.equals(target._id)),
    };
  }

  target.followRequestsReceived = target.followRequestsReceived.filter((id) => !id.equals(rid));
  requester.followRequestsSent = requester.followRequestsSent.filter((id) => !id.equals(target._id));

  const alreadyFollowing = requester.following.some((id) => id.equals(target._id));
  if (!alreadyFollowing) {
    requester.following.push(target._id);
    target.followers.push(requester._id);
  }

  requester.followingCount = requester.following.length;
  target.followersCount = target.followers.length;

  await Promise.all([requester.save(), target.save()]);

  return {
    changed: true,
    accepted: true,
    isFollowing: true,
  };
};

userSchema.methods.rejectFollowRequest = async function (requesterId) {
  const target = this;
  const rid = toObjectId(requesterId);
  if (!rid) throw new Error('REQUESTER_REQUIRED');
  if (target._id.equals(rid)) throw new Error('NO_SELF_REJECT_REQUEST');

  const User = mongoose.model('User');
  const requester = await User.findById(rid);
  if (!requester) throw new Error('REQUESTER_NOT_FOUND');

  const beforeTarget = target.followRequestsReceived.length;
  const beforeRequester = requester.followRequestsSent.length;

  target.followRequestsReceived = target.followRequestsReceived.filter((id) => !id.equals(rid));
  requester.followRequestsSent = requester.followRequestsSent.filter((id) => !id.equals(target._id));

  const changed =
    target.followRequestsReceived.length !== beforeTarget ||
    requester.followRequestsSent.length !== beforeRequester;

  await Promise.all([requester.save(), target.save()]);

  return {
    changed,
    accepted: false,
    isFollowing: false,
  };
};

// ------------------------- FCM tokens -------------------------
userSchema.methods.addFcmToken = async function ({
  token,
  platform = 'unknown',
  deviceName = '',
}) {
  const clean = (token || '').trim();
  if (!clean) return false;

  const existing = this.fcmTokens.find((t) => t.token === clean);

  if (existing) {
    existing.platform = platform || existing.platform || 'unknown';
    existing.deviceName = deviceName || existing.deviceName || '';
    existing.lastSeenAt = new Date();
  } else {
    this.fcmTokens.push({
      token: clean,
      platform,
      deviceName,
      lastSeenAt: new Date(),
    });
  }

  await this.save();
  return true;
};

userSchema.methods.removeFcmToken = async function (token) {
  const clean = (token || '').trim();
  if (!clean) return false;

  const before = this.fcmTokens.length;
  this.fcmTokens = this.fcmTokens.filter((t) => t.token !== clean);

  const changed = this.fcmTokens.length !== before;
  if (changed) {
    await this.save();
  }

  return changed;
};

// Helper: crear/actualizar desde datos verificados de Firebase
userSchema.statics.findOrCreateFromFirebase = async function ({
  uid,
  phoneNumber,
  displayName,
  photoURL,
}) {
  const User = this;

  // 1) Buscar por UID o por teléfono
  let user =
    (uid && (await User.findOne({ firebaseUid: uid }))) ||
    (phoneNumber && (await User.findOne({ phoneNumber })));

  // 2) Crear si no existe
  if (!user) {
    const usernameBase =
      (displayName && displayName.trim()) ||
      (phoneNumber ? `user_${phoneNumber.replace(/\D/g, "").slice(-6)}` : null) ||
      (uid ? `user_${uid.slice(0, 8)}` : "user");

    user = new User({
      firebaseUid: uid || undefined,
      phoneNumber: phoneNumber || undefined,
      username: usernameBase,
      profilePicture: photoURL || "",
      role: "spectator",
      // email opcional; si quieres forzar único sintético:
      email: uid ? `${uid}@firebase.local` : undefined,
    });
  } else {
    // 3) Actualizar campos útiles si faltan
    if (!user.firebaseUid && uid) user.firebaseUid = uid;
    if (!user.phoneNumber && phoneNumber) user.phoneNumber = phoneNumber;
    if (!user.profilePicture && photoURL) user.profilePicture = photoURL;
    if (
      user.username &&
      user.username.startsWith("user_") &&
      displayName &&
      displayName.trim()
    ) {
      user.username = displayName.trim();
    }
  }

  await user.save();
  return user;
};

const User = mongoose.model("User", userSchema);
module.exports = User;
