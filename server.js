const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = 3000;
const LIMITE_MB = 25;
const LIMITE_BYTES = LIMITE_MB * 1024 * 1024;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

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

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, Date.now() + '-' + sanitizarNombre(decodificarNombre(file.originalname)))
});
const upload = multer({ storage });

app.use(express.static('public'));

app.post('/upload', upload.single('archivo'), (req, res) => {
  const archivoSubido = req.file;
  const esMP4 = path.extname(archivoSubido.filename).toLowerCase() === '.mp4';
  const nombreOriginal = decodificarNombre(archivoSubido.originalname);

  if (!esMP4) {
    if (archivoSubido.size > LIMITE_BYTES) {
      fs.unlinkSync(archivoSubido.path);
      return res.status(400).json({ error: `El archivo supera el límite de ${LIMITE_MB}MB` });
    }
    const mb = (archivoSubido.size / (1024 * 1024)).toFixed(1) + ' MB';
    return res.json({ mensaje: 'Archivo recibido', convertido: false, nombre: nombreOriginal, archivoMp3: archivoSubido.filename, tamaño: mb });
  }

  const mp3Filename = archivoSubido.filename.replace(/\.mp4$/i, '.mp3');
  const mp3Path = path.join(uploadsDir, mp3Filename);

  ffmpeg(archivoSubido.path)
    .audioBitrate(128)
    .noVideo()
    .output(mp3Path)
    .on('end', () => {
      fs.unlinkSync(archivoSubido.path);
      const mp3Size = fs.statSync(mp3Path).size;
      if (mp3Size > LIMITE_BYTES) {
        fs.unlinkSync(mp3Path);
        return res.status(400).json({ error: `El archivo supera el límite de ${LIMITE_MB}MB tras la conversión` });
      }
      const mb = (mp3Size / (1024 * 1024)).toFixed(1) + ' MB';
      res.json({ mensaje: 'Archivo recibido', convertido: true, nombre: nombreOriginal, archivoMp3: mp3Filename, tamaño: mb });
    })
    .on('error', (err) => {
      fs.unlinkSync(archivoSubido.path);
      res.status(500).json({ error: 'Error al convertir el archivo: ' + err.message });
    })
    .run();
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
