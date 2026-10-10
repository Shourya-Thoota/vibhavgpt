import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "dotenv/config";

const filePath = process.env.VOICE_TEST_FILE;
const mimeType = process.env.VOICE_TEST_MIME ?? "audio/wav";
if (!filePath) throw new Error("VOICE_TEST_FILE is required.");
for (const name of ["INFERENCE_PRIMARY_API_KEY", "INFERENCE_PRIMARY_BASE_URL", "TRANSCRIPTION_MODEL"]) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}

const vocabularyHint =
  "This is a VibhavGPT conversation. Product and model names are VibhavGPT, Lumen, Nova, Nebula, and Vesper.";
const audio = await readFile(filePath);
const form = new FormData();
form.append("file", new Blob([audio], { type: mimeType }), `vibhavgpt-vocabulary-test.${mimeType === "audio/mpeg" ? "mp3" : "wav"}`);
form.append("model", process.env.TRANSCRIPTION_MODEL);
form.append("language", "en");
form.append("prompt", vocabularyHint);

const response = await fetch(`${process.env.INFERENCE_PRIMARY_BASE_URL.replace(/\/+$/, "")}/audio/transcriptions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.INFERENCE_PRIMARY_API_KEY}` },
  body: form,
  signal: AbortSignal.timeout(30_000),
});
const body = await response.json();
assert.equal(response.status, 200, JSON.stringify(body));
const text = String(body.text ?? "").trim();
assert.match(text, /VibhavGPT/i, `Expected VibhavGPT in transcription, received: ${text}`);
console.log(JSON.stringify({ transcription: text, recognizedVibhavGPT: true }));
