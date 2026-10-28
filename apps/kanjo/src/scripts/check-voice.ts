import { writeFileSync } from "node:fs";
import { synthesizeVoice, transcribeAudio } from "../voice.js";

// Prueba real de ElevenLabs (gasta pocos créditos): TTS en mp3 y Ogg/Opus, y STT de vuelta
const phrase = "Hola, soy Kanjō. ¿Qué te preparo hoy? Tenemos café de Chiapas y croissant recién horneado.";

const mp3 = await synthesizeVoice(phrase, "mp3_44100_128");
writeFileSync("data/voice-check.mp3", mp3);
console.log(`✔ TTS mp3: ${mp3.length} bytes → data/voice-check.mp3`);

const ogg = await synthesizeVoice(phrase, "opus_48000_32");
writeFileSync("data/voice-check.ogg", ogg);
const isOgg = Buffer.from(ogg.subarray(0, 4)).toString("ascii") === "OggS";
console.log(`${isOgg ? "✔" : "✘"} TTS Ogg/Opus: ${ogg.length} bytes, cabecera ${isOgg ? "OggS" : "desconocida"} → data/voice-check.ogg`);
console.log(`${ogg.length <= 512 * 1024 ? "✔" : "✘"} Tamaño de nota de voz ≤ 512 KB`);

const text = await transcribeAudio(mp3, "audio/mpeg");
const ok = !!text && /kanj|caf|croissant/i.test(text);
console.log(`${ok ? "✔" : "✘"} STT: "${text}"`);
if (!isOgg || !ok) process.exitCode = 1;
