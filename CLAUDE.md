# MP4-Transcript

## ¿Qué es este proyecto?
Servidor local en Node.js + Express para subir archivos MP4 o MP3,
transcribirlos a texto en español usando la API de Groq (Whisper),
y guardar las transcripciones en una base de datos SQLite.

## Stack técnico
- Node.js + Express
- SQLite con better-sqlite3
- Groq API (modelo Whisper) para transcripción
- ffmpeg + fluent-ffmpeg para conversión de audio
- HTML + CSS + JavaScript vanilla en el frontend

## Reglas importantes
- Todo el código en JavaScript, nunca Python
- Idioma de transcripción: español forzado
- Puerto: 3000
- Archivos aceptados: MP4 y MP3
- Calidad de conversión MP4 a MP3: 128kbps
- Límite de archivo: 25MB — rechazar con mensaje de error si se supera
- Los archivos subidos se guardan temporalmente en /uploads
- Borrar siempre los archivos temporales tras transcribir

## Base de datos
Tabla `transcriptions` con estos campos:
- id, filename, status, transcription, error_message, created_at, completed_at

## Estados de una transcripción
- processing — enviado a Groq, esperando respuesta
- completed — transcripción lista
- error — algo falló

## Cómo trabajamos
- Construimos paso a paso, una cosa cada vez
- Primero Node + Express básico, luego vamos añadiendo capas
- Cada paso se prueba antes de continuar

## Entorno de desarrollo
- Windows 11 con PowerShell
- VS Code con Claude Code
- Despliegue final: servidor Debian en clouding.io