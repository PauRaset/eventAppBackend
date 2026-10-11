// scripts/reviewPhotosDryRun.js
// Revisa con IA las fotos de una carpeta y saca los resultados por pantalla.
// NO toca la base de datos, NO modifica ni borra ninguna imagen (solo las lee).
// Sirve para probar la moderación/validación con fotos reales y comparar modelos
// (resultado, tiempo y coste) antes de activarla o cambiar PHOTO_REVIEW_MODEL.
//
// Uso:
//   node scripts/reviewPhotosDryRun.js <carpeta> [opciones]
//
// Opciones:
//   --model <m>          haiku | sonnet | opus | <id de modelo>. Varios separados por
//                        comas para comparar: --model haiku,sonnet,opus
//                        (por defecto: PHOTO_REVIEW_MODEL o claude-haiku-4-5)
//   --criteria "<texto>" criterio de misión para TODAS las fotos (sin él: solo moderación)
//   --exclude "<texto>"  exclusión para TODAS las fotos
//   --labels <f.json>    criterio y resultado esperado por foto:
//                        { "foto1.jpg": { "criteria": "...", "exclude": "...",
//                                         "expected": "approved|rejected|needs_review|blocked" } }
//   --concurrency <n>    fotos en paralelo por modelo (por defecto 3)
//   --json <f.json>      guarda también todos los resultados en un fichero JSON
//
// ⚠️ Cada foto x modelo es una llamada a la API de Anthropic (cuesta dinero).
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { reviewPhotoDetailed, getModel } = require('../utils/photoReview');

const MODEL_ALIASES = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
};

// Precio en USD por millón de tokens (entrada, salida). Tarifas de la API de
// Anthropic a junio de 2026: revisar si cambian. Modelo desconocido -> coste "?".
const PRICES = {
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
};

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.heic', '.heif']);

function parseArgs(argv) {
  const args = { folder: null, models: [], criteria: '', exclude: '', labels: null, concurrency: 3, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Falta el valor de ${a}`);
      return argv[++i];
    };
    if (a === '--model' || a === '--models') args.models.push(...next().split(','));
    else if (a === '--criteria') args.criteria = next();
    else if (a === '--exclude') args.exclude = next();
    else if (a === '--labels') args.labels = next();
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(next()) || 3);
    else if (a === '--json') args.json = next();
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--')) throw new Error(`Opción desconocida: ${a}`);
    else if (!args.folder) args.folder = a;
    else throw new Error(`Argumento de más: ${a}`);
  }
  args.models = [...new Set(args.models.map((m) => m.trim()).filter(Boolean).map((m) => MODEL_ALIASES[m] || m))];
  if (!args.models.length) args.models = [getModel()];
  return args;
}

function usage() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const end = lines.findIndex((l) => l.startsWith('require('));
  console.log(lines.slice(1, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

/** Etiqueta corta del veredicto, para tablas y comparaciones. */
function verdict(r) {
  if (r.result.moderation === 'blocked') return 'BLOQUEADA';
  if (r.error) return 'error';
  return { approved: 'aprobada', rejected: 'rechazada', needs_review: 'duda' }[r.result.status] || r.result.status;
}

function expectedMatches(expected, r) {
  if (!expected) return null;
  if (expected === 'blocked') return r.result.moderation === 'blocked';
  return r.result.moderation !== 'blocked' && r.result.status === expected;
}

function costUsd(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  return ((usage.input || 0) * p[0] + (usage.output || 0) * p[1]) / 1e6;
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.folder) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY en el entorno (.env): sin ella no se puede revisar nada.');
    process.exit(1);
  }

  const folder = path.resolve(args.folder);
  const files = fs
    .readdirSync(folder)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort();
  if (!files.length) {
    console.error(`No hay imágenes en ${folder}`);
    process.exit(1);
  }

  const labels = args.labels ? JSON.parse(fs.readFileSync(path.resolve(args.labels), 'utf8')) : {};
  const photoArgs = (file) => {
    const l = labels[file] || {};
    return {
      photoCriteria: l.criteria ?? args.criteria,
      photoCriteriaExclude: l.exclude ?? args.exclude,
      expected: l.expected || null,
    };
  };

  console.log(`\nCarpeta: ${folder}`);
  console.log(`Fotos: ${files.length} · Modelos: ${args.models.join(', ')}`);
  console.log(`⚠️  ${files.length * args.models.length} llamadas a la API (cuestan dinero). Nada se escribe en la base de datos ni se borra.\n`);

  const all = {}; // all[model][file] = resultado

  for (const model of args.models) {
    console.log(`═══ ${model} ═══`);
    console.log(`${pad('foto', 26)} ${pad('veredicto', 10)} ${pad('conf', 5)} ${pad('tokens', 11)} ${pad('ms', 6)} motivo`);
    const started = Date.now();

    const results = await mapLimit(files, args.concurrency, async (file) => {
      const { photoCriteria, photoCriteriaExclude, expected } = photoArgs(file);
      const r = await reviewPhotoDetailed({
        imagePath: path.join(folder, file),
        photoCriteria,
        photoCriteriaExclude,
        model,
        log: false,
      });
      const ok = expectedMatches(expected, r);
      const conf = r.result.confidence == null ? '-' : r.result.confidence.toFixed(2);
      const tokens = r.usage ? `${r.usage.input}/${r.usage.output}` : '-';
      const mark = ok === null ? '' : ok ? '  ✓' : `  ✗ (esperado: ${expected})`;
      const note = r.error ? ` [${r.error}]` : r.fallback ? ` [respondió ${r.servedBy} por fallback]` : '';
      console.log(`${pad(file, 26)} ${pad(verdict(r), 10)} ${pad(conf, 5)} ${pad(tokens, 11)} ${pad(r.ms, 6)} ${r.result.reason}${note}${mark}`);
      return { file, expected, ok, ...r };
    });

    all[model] = Object.fromEntries(results.map((r) => [r.file, r]));

    // Resumen del modelo
    const count = (v) => results.filter((r) => verdict(r) === v).length;
    const inTok = results.reduce((s, r) => s + (r.usage?.input || 0), 0);
    const outTok = results.reduce((s, r) => s + (r.usage?.output || 0), 0);
    const costs = results.map((r) => costUsd(model, r.usage)).filter((c) => c !== null);
    const cost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
    const answered = results.filter((r) => r.usage).length;
    const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
    const labeled = results.filter((r) => r.ok !== null);

    console.log(`\n  aprobadas ${count('aprobada')} · rechazadas ${count('rechazada')} · BLOQUEADAS ${count('BLOQUEADA')} · dudas ${count('duda')} · errores ${count('error')}`);
    console.log(`  tokens: ${inTok} entrada / ${outTok} salida · ${avgMs} ms de media por foto · ${((Date.now() - started) / 1000).toFixed(1)} s en total`);
    if (cost !== null) {
      console.log(`  coste: $${cost.toFixed(4)} esta tanda · ≈ $${((cost / Math.max(answered, 1)) * 1000).toFixed(2)} por 1.000 fotos`);
    } else {
      console.log(`  coste: ? (sin precio conocido para ${model}; añádelo en PRICES)`);
    }
    if (labeled.length) {
      console.log(`  aciertos: ${labeled.filter((r) => r.ok).length}/${labeled.length} fotos con resultado esperado`);
    }
    console.log('');
  }

  // Comparación entre modelos
  if (args.models.length > 1) {
    console.log('═══ Comparación ═══');
    console.log(`${pad('foto', 26)} ${args.models.map((m) => pad(m.replace('claude-', ''), 13)).join(' ')}`);
    let disagreements = 0;
    for (const file of files) {
      const verdicts = args.models.map((m) => verdict(all[m][file]));
      const differ = new Set(verdicts).size > 1;
      if (differ) disagreements++;
      const expected = photoArgs(file).expected;
      console.log(
        `${pad(file, 26)} ${verdicts.map((v) => pad(v, 13)).join(' ')}${differ ? '  ≠' : ''}${expected ? `  (esperado: ${expected})` : ''}`
      );
    }
    console.log(`\nFotos en las que los modelos NO coinciden: ${disagreements}/${files.length}\n`);
  }

  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(all, null, 2));
    console.log(`Resultados guardados en ${path.resolve(args.json)}`);
  }
}

main().catch((err) => {
  console.error('[reviewPhotosDryRun] Error:', err?.message || err);
  process.exit(1);
});
