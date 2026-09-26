const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Carpeta destino: /uploads/profilePictures (relativa a este archivo)
const uploadDir = path.join(__dirname, "../uploads/profilePictures");

// Asegura que la carpeta exista
function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error("[multer] No se pudo crear el directorio de uploads:", e);
    throw e;
  }
}

// Extensiones por tipo MIME (más fiable que depender del nombre original)
const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/heif-sequence": ".heif",
  "image/heic-sequence": ".heic",
};

// Tipos permitidos (incluye HEIC/HEIF para iPhone)
const ALLOWED_MIME = new Set(Object.keys(EXT_BY_MIME));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureDir(uploadDir);
      cb(null, uploadDir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (_req, file, cb) => {
    // Base del nombre sin extensión ni caracteres raros
    const rawBase = path.parse(file.originalname || "image").name;
    const base = rawBase
      .normalize("NFKD")
      .replace(/[^\w\s.-]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 60) || "img";

    // Extensión por MIME (o cae a la original, o .jpg)
    const ext =
      EXT_BY_MIME[file.mimetype] ||
      path.extname(file.originalname || "").toLowerCase() ||
      ".jpg";

    const stamp = Date.now();
    cb(null, `${stamp}-${base}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Tipo de archivo no permitido"), false);
  }
};

// Middleware de Multer con límites (10 MB)
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

module.exports = upload;