// routes/eventsCompat.js
const express = require('express');
const router = express.Router();

// Ajusta si el nombre del controlador es otro:
const events = require('../controllers/eventController');

/* ---------------- utils de resolución ---------------- */

const keys = Object.keys(events || {});

const firstExisting = (...names) =>
  names.find((n) => typeof events[n] === 'function') || null;

const findByRegex = (...regexes) => {
  for (const k of keys) {
    for (const r of regexes) {
      if (r.test(k) && typeof events[k] === 'function') return k;
    }
  }
  return null;
};

const pick = (label, fallbacks, regexes) => {
  let name = firstExisting(...fallbacks);
  if (!name && regexes?.length) name = findByRegex(...regexes);
  if (!name) {
    console.warn(`[eventsCompat] No handler for ${label}. Tried:`,
      fallbacks, 'and regexes:', regexes?.map(r => r.toString()));
    return (req, res) =>
      res.status(501).json({ error: `No handler found for ${label}` });
  }
  console.log(`[eventsCompat] ${label} ->`, name);
  return events[name];
};

/* ---------- intentar casar NOMBRES (EN/ES) + REGEX ---------- */

// listar
const list = pick(
  'list',
  [
    'listEvents','getAllEvents','getEvents','index','list','getAll','findAll',
    'listarEventos','obtenerEventos','getEventos','listar','obtenerTodos'
  ],
  [/list/i, /get.*all/i, /find.*all/i, /obtener.*event/i, /listar/i]
);

// detalle
// detalle (regex estrictos: por id / detail / one)
const getOne = pick(
  'getOne',
  [
    'getEvent','getById','findOne','show','detail','get',
    'obtenerEvento','getEvento','buscarPorId','detalle','mostrar'
  ],
  [
    /^get(Event)?$/i,          // get o getEvent (exactos)
    /get.*by.*id/i,            // getById
    /find.*one/i,              // findOne
    /\bdetail\b/i,             // detail
    /\b(show|mostrar|detalle)\b/i,
    /(por|by).*id/i,           // ...por id
    /obtener.*evento/i,        // obtenerEvento
  ]
);

// crear
const create = pick(
  'create',
  [
    'createEvent','create','store','add',
    'crearEvento','crear','guardar','nuevo','alta'
  ],
  [/crea/i, /store/i, /add/i, /alta/i, /guardar/i]
);

// actualizar
const update = pick(
  'update',
  [
    'updateEvent','update','updateById','edit','patch','modify','modifyById',
    'actualizarEvento','actualizar','editar','modificar','modificarEvento','patchEvento'
  ],
  [/updat/i, /edit/i, /patch/i, /modif/i, /actualiz/i]
);

// borrar
const remove = pick(
  'remove',
  [
    'deleteEvent','remove','destroy','del','delete',
    'eliminarEvento','eliminar','borrar','baja'
  ],
  [/delet/i, /remov/i, /destroy/i, /borr/i, /elimin/i, /baja/i]
);

// imagen
const image = pick(
  'image',
  [
    'uploadImage','uploadEventImage','imageUpload','addImage',
    'subirImagenEvento','subirImagen','cargarImagen'
  ],
  [/image/i, /imagen/i, /upload/i]
);

/* ---------------------- rutas ----------------------- */

// REST estándar
router.get('/events', list);
router.get('/events/:id', getOne);

router.post('/events', create);
router.delete('/events/:id', remove);

// update aceptando varios verbos
router.put('/events/:id', update);
router.patch('/events/:id', update);
router.post('/events/:id', update);

// Aliases (singular)
router.get('/event/:id', getOne);
router.post('/event', create);
router.put('/event/:id', update);
router.patch('/event/:id', update);
router.post('/event/:id', update);

// Variantes "edit/update"
router.post('/events/update/:id', update);
router.post('/events/edit/:id', update);
router.put('/events/edit/:id', update);
router.put('/events/:id/update', update);
router.patch('/events/:id/update', update);

// Imagen
router.post('/events/:id/image', image);
router.post('/event/:id/image', image);

module.exports = router;
