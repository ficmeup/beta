// Runs Piper voices off the main thread, on the CPU, so it works on almost any device.
// The voice (~60 MB) downloads once into the browser's cache. The pronunciation module
// and the voice model are loaded once and reused for every sentence, which keeps the
// phone cool. Text never leaves the device.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs';
import { createPiperPhonemize } from 'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js';

const VOICES_BASE = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';
const PHONEMIZE_BASE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const CACHE_NAME = 'piper-voices-v1';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
ort.env.wasm.numThreads = 1;

let phonemizer = null;       // Promise of the pronunciation module
let phonemizerUses = 0;
const PHONEMIZER_MAX_USES = 40;   // it breaks after ~110 uses, so start a fresh one well before
const printed = [];          // its output lines
let voice = null;            // { id, session, config }

// "en_US-ljspeech-medium" -> "en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx"
function modelUrl(id) {
  const [lang, name, quality] = id.split('-');
  return `${VOICES_BASE}/${lang.split('_')[0]}/${lang}/${name}/${quality}/${id}.onnx`;
}

async function cachedDownload(url, onProgress) {
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  // Read straight into one buffer so the ~60 MB voice isn't held in memory several times over.
  let bytes = new Uint8Array(total || 1 << 20);
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > bytes.length) {
      const bigger = new Uint8Array(Math.max(bytes.length * 2, loaded + value.length));
      bigger.set(bytes.subarray(0, loaded));
      bytes = bigger;
    }
    bytes.set(value, loaded);
    loaded += value.length;
    if (total && onProgress) onProgress((loaded * 100) / total);
  }
  bytes = bytes.subarray(0, loaded);
  await cache?.put(url, new Response(bytes)).catch(() => {});   // if storage is full, it still works this time
  return bytes;
}

function getPhonemizer() {
  if (phonemizerUses >= PHONEMIZER_MAX_USES) { phonemizer = null; phonemizerUses = 0; }
  phonemizer ||= createPiperPhonemize({
    print: line => printed.push(line),
    printErr: () => {},
    noInitialRun: true,
    locateFile: f => (f.endsWith('.wasm') ? `${PHONEMIZE_BASE}.wasm` : f.endsWith('.data') ? `${PHONEMIZE_BASE}.data` : f),
  });
  return phonemizer;
}

// Earlier versions stored voices with a different library; free that space.
async function removeOldCopies() {
  try { await (await navigator.storage.getDirectory()).removeEntry('piper', { recursive: true }); } catch {}
}

async function loadVoice(id, onProgress) {
  if (voice?.id === id) return voice;
  const url = modelUrl(id);
  const config = JSON.parse(new TextDecoder().decode(await cachedDownload(`${url}.json`)));
  if (voice) { await voice.session.release().catch(() => {}); voice = null; }
  let model = new Uint8Array(await cachedDownload(url, onProgress));
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  model = null;
  await getPhonemizer();
  voice = { id, session, config };
  removeOldCopies();
  return voice;
}

// Sentences are joined into longer stretches by the app, so each one comes back as
// raw 16-bit samples with the model's own leading and trailing silence cut off.
// The app then puts in pauses of its own, which follow the playback speed.
function trimmedPcm(chunks, rate) {
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const loud = 0.012;
  let a = 0, b = all.length - 1;
  while (a < b && Math.abs(all[a]) < loud) a++;
  while (b > a && Math.abs(all[b]) < loud) b--;
  a = Math.max(0, a - Math.round(rate * 0.015));
  b = Math.min(all.length - 1, b + Math.round(rate * 0.04));
  const pcm = new Int16Array(Math.max(0, b - a + 1));
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, all[a + i]));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return pcm;
}

async function speak(text) {
  const { session, config } = voice;
  const mod = await getPhonemizer();
  phonemizerUses++;
  printed.length = 0;
  mod.callMain(['-l', config.espeak.voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  const rate = config.audio.sample_rate;
  const { noise_scale, length_scale, noise_w } = config.inference;
  const multiSpeaker = Object.keys(config.speaker_id_map || {}).length > 0;
  const chunks = [];
  for (const line of printed) {
    const ids = JSON.parse(line).phoneme_ids;
    if (!ids?.length) continue;
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([noise_scale, length_scale, noise_w]), [3]),
    };
    if (multiSpeaker) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    const { output } = await session.run(feeds);
    chunks.push(output.data);
  }
  const pcm = trimmedPcm(chunks, rate);
  return { pcm, rate, seconds: pcm.length / rate };
}

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'load') {
      await loadVoice(data.voice, percent => self.postMessage({ type: 'progress', id, percent }));
      await speak('Ready.');   // warm-up so the story starts promptly
      self.postMessage({ type: 'ready', id });
    } else if (data.type === 'generate') {
      const started = performance.now();
      await loadVoice(data.voice);
      const { pcm, rate, seconds } = await speak(data.text);
      self.postMessage({ type: 'audio', id, pcm, rate, seconds, ms: Math.round(performance.now() - started) }, [pcm.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
