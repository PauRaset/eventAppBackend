// utils/geocode.js
// Geocodificación sin dependencias externas (módulo https nativo).
// Proveedor: Google si existe GOOGLE_GEOCODING_KEY, si no Nominatim (OSM).
const https = require("https");

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          reject(new Error("Respuesta no es JSON válido"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** Construye la cadena de búsqueda a partir de los campos sueltos. */
function buildAddress({ street, postalCode, city, country }) {
  return [street, postalCode, city, country || process.env.GEOCODE_COUNTRY || "España"]
    .map((s) => (s || "").toString().trim())
    .filter(Boolean)
    .join(", ");
}

async function geocodeGoogle(address, key) {
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(address) +
    "&key=" + key +
    "&region=es&language=es";
  const { json } = await httpsGetJson(url);
  if (json.status !== "OK" || !json.results || !json.results.length) return null;
  const r = json.results[0];
  return {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    provider: "google",
    formatted: r.formatted_address || "",
  };
}

async function geocodeNominatim(address) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(address);
  // Nominatim EXIGE identificarse con un User-Agent propio.
  const { json } = await httpsGetJson(url, {
    "User-Agent": process.env.GEOCODE_USER_AGENT || "NightVibe/1.0 (tickets@nightvibe.life)",
    "Accept-Language": "es",
  });
  if (!Array.isArray(json) || !json.length) return null;
  const r = json[0];
  const lat = parseFloat(r.lat);
  const lng = parseFloat(r.lon);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng, provider: "nominatim", formatted: r.display_name || "" };
}

/**
 * Geocodifica una dirección. Nunca lanza: devuelve null si falla,
 * para no bloquear nunca el guardado del evento.
 */
async function geocodeAddress(parts) {
  const address = buildAddress(parts);
  // Sin calle NI ciudad no merece la pena intentarlo
  if (!address || address.split(",").length < 2) return null;
  try {
    const key = process.env.GOOGLE_GEOCODING_KEY;
    const out = key ? await geocodeGoogle(address, key) : await geocodeNominatim(address);
    if (!out) return null;
    return { ...out, sourceAddress: address };
  } catch (e) {
    console.error("[geocode] fallo:", e.message, "| dir:", address);
    return null;
  }
}

/** Aplica el resultado sobre un documento/objeto de evento. */
function applyGeo(target, geo, sourceAddressFallback) {
  if (geo) {
    target.location = { type: "Point", coordinates: [geo.lng, geo.lat] };
    target.geoStatus = "ok";
    target.geoProvider = geo.provider;
    target.geoFormatted = geo.formatted;
    target.geoSourceAddress = geo.sourceAddress;
  } else {
    target.geoStatus = "failed";
    target.geoSourceAddress = sourceAddressFallback || "";
  }
  target.geoUpdatedAt = new Date();
  return target;
}

module.exports = { geocodeAddress, applyGeo, buildAddress };
