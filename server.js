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

async function transcribir(mp3Path) {
  const respuesta = await groq.audio.transcriptions.create({
    file: fs.createReadStream(mp3Path),
    model: 'whisper-large-v3-turbo',
    language: 'es',
  });
  return respuesta.text.trim();
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

  const duracion = await obtenerDuracion(archivoSubido.path);
  const registro = insertarTranscripcion.run(nombreOriginal, 'processing', new Date().toISOString(), duracion);
  const registroId = registro.lastInsertRowid;

  if (!esMP4) {
    if (archivoSubido.size > LIMITE_BYTES) {
      fs.unlinkSync(archivoSubido.path);
      actualizarError.run('error', `El archivo supera el límite de ${LIMITE_MB}MB`, registroId);
      return res.status(400).json({ error: `El archivo supera el límite de ${LIMITE_MB}MB` });
    }
    const mp3Path = archivoSubido.path;
    try {
      const transcripcion = await transcribir(mp3Path);
      fs.unlinkSync(mp3Path);
      actualizarCompletada.run('completed', transcripcion, new Date().toISOString(), registroId);
      const mb = (archivoSubido.size / (1024 * 1024)).toFixed(1) + ' MB';
      return res.json({ id: registroId, convertido: false, nombre: nombreOriginal, tamaño: mb, transcripcion });
    } catch (err) {
      fs.unlinkSync(mp3Path);
      actualizarError.run('error', err.message, registroId);
      return res.status(500).json({ error: 'Error al transcribir: ' + err.message });
    }
  }

  const mp3Filename = archivoSubido.filename.replace(/\.mp4$/i, '.mp3');
  const mp3Path = path.join(uploadsDir, mp3Filename);

  ffmpeg(archivoSubido.path)
    .audioBitrate(128)
    .noVideo()
    .output(mp3Path)
    .on('end', async () => {
      fs.unlinkSync(archivoSubido.path);
      const mp3Size = fs.statSync(mp3Path).size;
      if (mp3Size > LIMITE_BYTES) {
        fs.unlinkSync(mp3Path);
        actualizarError.run('error', `El archivo supera el límite de ${LIMITE_MB}MB tras la conversión`, registroId);
        return res.status(400).json({ error: `El archivo supera el límite de ${LIMITE_MB}MB tras la conversión` });
      }
      try {
        const transcripcion = await transcribir(mp3Path);
        fs.unlinkSync(mp3Path);
        actualizarCompletada.run('completed', transcripcion, new Date().toISOString(), registroId);
        const mb = (mp3Size / (1024 * 1024)).toFixed(1) + ' MB';
        res.json({ id: registroId, convertido: true, nombre: nombreOriginal, tamaño: mb, transcripcion });
      } catch (err) {
        fs.unlinkSync(mp3Path);
        actualizarError.run('error', err.message, registroId);
        res.status(500).json({ error: 'Error al transcribir: ' + err.message });
      }
    })
    .on('error', (err) => {
      fs.unlinkSync(archivoSubido.path);
      actualizarError.run('error', err.message, registroId);
      res.status(500).json({ error: 'Error al convertir el archivo: ' + err.message });
    })
    .run();
});

app.get('/transcriptions', (_req, res) => {
  const filas = db.prepare('SELECT * FROM transcriptions ORDER BY created_at DESC').all();
  res.json(filas);
});

app.delete('/transcriptions/:id', (req, res) => {
  db.prepare('DELETE FROM transcriptions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
