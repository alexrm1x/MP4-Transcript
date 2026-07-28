require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const Groq = require('groq-sdk');
const db = require('./database');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const app = express();
const PORT = 3000;
const LIMITE_MB = 25;
const LIMITE_BYTES = LIMITE_MB * 1024 * 1024;
const TROZO_BYTES = 24 * 1024 * 1024; // tamaño objetivo de cada trozo al dividir archivos grandes

// Progreso en vivo de cada trabajo, indexado por jobId. El frontend lo consulta
// por polling mientras la subida está en curso.
const progreso = new Map();

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const insertarTranscripcion = db.prepare(
  'INSERT INTO transcriptions (filename, status, created_at, duration_seconds) VALUES (?, ?, ?, ?)'
);

function obtenerDuracion(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return resolve(null);
      resolve(Math.round(metadata.format.duration) || null);
    });
  });
}
const actualizarCompletada = db.prepare(
  'UPDATE transcriptions SET status = ?, transcription = ?, completed_at = ? WHERE id = ?'
);
const actualizarError = db.prepare(
  'UPDATE transcriptions SET status = ?, error_message = ? WHERE id = ?'
);

function decodificarNombre(nombre) {
  return Buffer.from(nombre, 'latin1').toString('utf8');
}

function sanitizarNombre(nombre) {
  return nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ñÑ]/g, 'n')
    .replace(/ /g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '');
}

function formatearTiempo(seg) {
  const s = Math.floor(seg % 60).toString().padStart(2, '0');
  const m = Math.floor((seg / 60) % 60).toString().padStart(2, '0');
  const h = Math.floor(seg / 3600);
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

async function transcribir(mp3Path, conTimestamps = false, offsetSeg = 0) {
  const respuesta = await groq.audio.transcriptions.create({
    file: fs.createReadStream(mp3Path),
    model: 'whisper-large-v3-turbo',
    language: 'es',
    response_format: conTimestamps ? 'verbose_json' : 'json',
    ...(conTimestamps && { timestamp_granularities: ['segment'] }),
  });

  if (conTimestamps && Array.isArray(respuesta.segments)) {
    return respuesta.segments
      .map((s) => `[${formatearTiempo(s.start + offsetSeg)}] ${s.text.trim()}`)
      .join('\n');
  }
  return respuesta.text.trim();
}

// Parte un audio en trozos MP3 por duración, re-codificando a 128k para que
// funcione con cualquier formato de entrada (m4a/aac, wav, mp3…).
// Cada trozo empieza en 0 (reset_timestamps).
function dividirEnTrozos(audioPath, segDur, outDir) {
  return new Promise((resolve, reject) => {
    const patron = path.join(outDir, 'chunk-%03d.mp3');
    ffmpeg(audioPath)
      .outputOptions([
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-f', 'segment',
        '-segment_time', String(segDur),
        '-reset_timestamps', '1',
      ])
      .output(patron)
      .on('end', () => {
        const trozos = fs.readdirSync(outDir)
          .filter((f) => f.endsWith('.mp3'))
          .sort()
          .map((f) => path.join(outDir, f));
        resolve(trozos);
      })
      .on('error', reject)
      .run();
  });
}

// Transcribe un MP3; si supera el límite de Groq lo trocea, transcribe cada
// parte en orden y une los textos (desplazando las marcas de tiempo).
async function transcribirArchivo(mp3Path, conTimestamps = false, onProgreso = () => {}) {
  const size = fs.statSync(mp3Path).size;
  if (size <= LIMITE_BYTES) {
    onProgreso({ trozoActual: 1, totalTrozos: 1 });
    return transcribir(mp3Path, conTimestamps);
  }

  // Los trozos se re-codifican a 128k, así que su tamaño depende de ese bitrate
  // fijo (16000 bytes/s), no del bitrate del archivo original.
  const bytesPorSeg = 128000 / 8;
  const segDur = Math.max(30, Math.floor(TROZO_BYTES / bytesPorSeg));

  const outDir = fs.mkdtempSync(path.join(uploadsDir, 'trozos-'));
  try {
    const trozos = await dividirEnTrozos(mp3Path, segDur, outDir);
    const partes = [];
    let offset = 0;
    for (let i = 0; i < trozos.length; i++) {
      onProgreso({ trozoActual: i + 1, totalTrozos: trozos.length });
      partes.push(await transcribir(trozos[i], conTimestamps, offset));
      offset += (await obtenerDuracion(trozos[i])) || segDur;
    }
    return partes.join(conTimestamps ? '\n' : ' ');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, Date.now() + '-' + sanitizarNombre(decodificarNombre(file.originalname)))
});
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, 'public')));

app.post('/upload', upload.single('archivo'), async (req, res) => {
  const archivoSubido = req.file;
  const esMP4 = path.extname(archivoSubido.filename).toLowerCase() === '.mp4';
  const nombreOriginal = decodificarNombre(archivoSubido.originalname);
  const conTimestamps = req.body.timestamps === 'true';
  const jobId = req.body.jobId || String(archivoSubido.filename);

  const duracion = await obtenerDuracion(archivoSubido.path);
  const registro = insertarTranscripcion.run(nombreOriginal, 'processing', new Date().toISOString(), duracion);
  const registroId = registro.lastInsertRowid;

  // Datos para la ventana de estado
  const formato = path.extname(nombreOriginal).replace('.', '').toUpperCase();
  const bitrateKbps = duracion ? Math.round((archivoSubido.size * 8) / duracion / 1000) : null;
  const fijarProgreso = (extra) => progreso.set(jobId, { ...(progreso.get(jobId) || {}), ...extra });
  fijarProgreso({ formato, duracionSeg: duracion, bitrateKbps, fase: 'preparando' });

  const onProgreso = ({ trozoActual, totalTrozos }) =>
    fijarProgreso({ fase: 'transcribiendo', trozoActual, totalTrozos });

  if (!esMP4) {
    const mp3Path = archivoSubido.path;
    try {
      const transcripcion = await transcribirArchivo(mp3Path, conTimestamps, onProgreso);
      fs.unlinkSync(mp3Path);
      actualizarCompletada.run('completed', transcripcion, new Date().toISOString(), registroId);
      const mb = (archivoSubido.size / (1024 * 1024)).toFixed(1) + ' MB';
      return res.json({ id: registroId, convertido: false, nombre: nombreOriginal, tamaño: mb, transcripcion });
    } catch (err) {
      fs.unlinkSync(mp3Path);
      actualizarError.run('error', err.message, registroId);
      return res.status(500).json({ error: 'Error al transcribir: ' + err.message });
    } finally {
      progreso.delete(jobId);
    }
  }

  const mp3Filename = archivoSubido.filename.replace(/\.mp4$/i, '.mp3');
  const mp3Path = path.join(uploadsDir, mp3Filename);

  fijarProgreso({ fase: 'convirtiendo' });
  ffmpeg(archivoSubido.path)
    .audioBitrate(128)
    .noVideo()
    .output(mp3Path)
    .on('end', async () => {
      fs.unlinkSync(archivoSubido.path);
      const mp3Size = fs.statSync(mp3Path).size;
      try {
        const transcripcion = await transcribirArchivo(mp3Path, conTimestamps, onProgreso);
        fs.unlinkSync(mp3Path);
        actualizarCompletada.run('completed', transcripcion, new Date().toISOString(), registroId);
        const mb = (mp3Size / (1024 * 1024)).toFixed(1) + ' MB';
        res.json({ id: registroId, convertido: true, nombre: nombreOriginal, tamaño: mb, transcripcion });
      } catch (err) {
        fs.unlinkSync(mp3Path);
        actualizarError.run('error', err.message, registroId);
        res.status(500).json({ error: 'Error al transcribir: ' + err.message });
      } finally {
        progreso.delete(jobId);
      }
    })
    .on('error', (err) => {
      fs.unlinkSync(archivoSubido.path);
      actualizarError.run('error', err.message, registroId);
      progreso.delete(jobId);
      res.status(500).json({ error: 'Error al convertir el archivo: ' + err.message });
    })
    .run();
});

app.get('/progress/:id', (req, res) => {
  res.json(progreso.get(req.params.id) || {});
});

app.get('/transcriptions', (_req, res) => {
  const filas = db.prepare('SELECT * FROM transcriptions ORDER BY created_at DESC').all();
  res.json(filas);
});

app.delete('/transcriptions/:id', (req, res) => {
  db.prepare('DELETE FROM transcriptions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
}); */

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});