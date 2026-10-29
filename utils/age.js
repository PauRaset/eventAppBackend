// utils/age.js
// Edad mínima configurable (MIN_AGE en el .env) y cálculo de la edad a partir
// de la fecha de nacimiento completa (día, mes y año), con la fecha de HOY en
// hora de Madrid: se cumplen años el día exacto del cumpleaños.
//
// La fecha de nacimiento llega como "YYYY-MM-DD" y se guarda como Date a las
// 00:00 UTC de ese día (así nunca se desplaza un día por zona horaria).

const DEFAULT_MIN_AGE = 18;
const MAX_AGE_YEARS = 120;
const TIME_ZONE = "Europe/Madrid";

/** Edad mínima actual (MIN_AGE, entre 13 y 99; si falta o no es válida, 18). Se lee en cada llamada. */
function getMinAge() {
  const n = parseInt(String(process.env.MIN_AGE ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 13 || n > 99) return DEFAULT_MIN_AGE;
  return n;
}

/** Fecha de hoy en Madrid como { y, m, d }. */
function todayParts(now = new Date()) {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // "YYYY-MM-DD"
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

/**
 * "YYYY-MM-DD" -> Date (00:00 UTC) o null si no es una fecha real, es futura
 * o tiene más de 120 años. Solo se acepta ese formato exacto.
 */
function parseBirthDate(input, now = new Date()) {
  if (typeof input !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Fecha real (descarta 2001-02-30 y similares)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;

  const t = todayParts(now);
  const age = ageFromParts({ y, m: mo, d }, t);
  if (age < 0) return null; // futura
  if (age > MAX_AGE_YEARS) return null;
  return date;
}

function ageFromParts(b, t) {
  let age = t.y - b.y;
  if (t.m < b.m || (t.m === b.m && t.d < b.d)) age -= 1;
  return age;
}

/** Edad cumplida hoy (Madrid) para una fecha de nacimiento guardada. */
function ageOn(birthDate, now = new Date()) {
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return null;
  return ageFromParts(
    { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() },
    todayParts(now)
  );
}

/** ¿Llega a la edad mínima ACTUAL? (false si no hay fecha) */
function meetsMinAge(birthDate, now = new Date()) {
  if (!birthDate) return false;
  const age = ageOn(birthDate, now);
  return age !== null && age >= getMinAge();
}

/** Date guardada -> "YYYY-MM-DD" (o null) */
function formatBirthDate(birthDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return null;
  return b.toISOString().slice(0, 10);
}

module.exports = {
  getMinAge,
  parseBirthDate,
  ageOn,
  meetsMinAge,
  formatBirthDate,
};
