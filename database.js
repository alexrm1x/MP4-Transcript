const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'transcriptions.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    status TEXT,
    transcription TEXT,
    error_message TEXT,
    created_at TEXT,
    completed_at TEXT
  )
`);

module.exports = db;
