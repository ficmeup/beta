// Runs the Kokoro voice model off the main thread. The model (~310 MB) downloads once,
// then the browser caches it. Text never leaves the device.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;

// The app joins sentences into longer stretches, so each comes back as raw 16-bit
// samples with leading and trailing silence cut off; the app adds its own pauses.
function trimmedPcm(samples, rate) {
  const loud = 0.012;
  let a = 0, b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < loud) a++;
  while (b > a && Math.abs(samples[b]) < loud) b--;
  a = Math.max(0, a - Math.round(rate * 0.015));
  b = Math.min(samples.length - 1, b + Math.round(rate * 0.04));
  const pcm = new Int16Array(Math.max(0, b - a + 1));
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[a + i]));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return pcm;
}

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'load') {
      tts ||= await KokoroTTS.from_pretrained(MODEL, {
        dtype: 'fp32',
        device: 'webgpu',
        progress_callback: p => {
          if (p.status === 'progress' && /\.onnx$/.test(p.file || '')) self.postMessage({ type: 'progress', id, percent: p.progress });
        },
      });
      self.postMessage({ type: 'ready', id });
    } else if (data.type === 'generate') {
      const started = performance.now();
      const audio = await tts.generate(data.text, { voice: data.voice });
      const rate = audio.sampling_rate;
      const pcm = trimmedPcm(audio.audio, rate);
      self.postMessage({ type: 'audio', id, pcm, rate, seconds: pcm.length / rate, ms: Math.round(performance.now() - started) }, [pcm.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
