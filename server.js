const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

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
  const mb = (req.file.size / (1024 * 1024)).toFixed(1) + ' MB';
  res.json({
    mensaje: 'Archivo recibido',
    nombre: decodificarNombre(req.file.originalname),
    tamaño: mb
  });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
