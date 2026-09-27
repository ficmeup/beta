// Runs Piper voices off the main thread, on the CPU, so it works on almost any device.
// The voice (~60 MB) downloads once into the browser's cache. The pronunciation module
// and the voice model are loaded once and reused for every sentence, which keeps the
// phone cool. Text never leaves the device.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/+esm';
import { createPiperPhonemize } from 'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js';

const VOICES_BASE = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';
const PHONEMIZE_BASE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const CACHE_NAME = 'piper-voices-v1';

ort.env.wasm.wasmPaths = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/';
ort.env.wasm.numThreads = 1;

let phonemizer = null;       // Promise of the pronunciation module
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
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total && onProgress) onProgress((loaded * 100) / total);
  }
  const blob = new Blob(chunks);
  await cache?.put(url, new Response(blob)).catch(() => {});   // if storage is full, it still works this time
  return blob.arrayBuffer();
}

function getPhonemizer() {
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
  const model = await cachedDownload(url, onProgress);
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  await getPhonemizer();
  voice = { id, session, config };
  removeOldCopies();
  return voice;
}

function wav16(chunks, rate) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + length * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, length * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function speak(text) {
  const { session, config } = voice;
  const mod = await getPhonemizer();
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
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  return { blob: wav16(chunks, rate), seconds: samples / rate };
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
      const { blob, seconds } = await speak(data.text);
      self.postMessage({ type: 'audio', id, blob, seconds, ms: Math.round(performance.now() - started) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
