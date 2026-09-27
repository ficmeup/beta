// Runs the Kokoro voice model off the main thread. The model (~160 MB) downloads once,
// then the browser caches it. Text never leaves the device.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;

// Kokoro's own WAV output uses 32-bit float samples, which not every browser plays.
// 16-bit PCM plays everywhere.
function wav16(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'load') {
      tts ||= await KokoroTTS.from_pretrained(MODEL, {
        dtype: 'fp16',
        device: 'webgpu',
        progress_callback: p => {
          if (p.status === 'progress' && /\.onnx$/.test(p.file || '')) self.postMessage({ type: 'progress', id, percent: p.progress });
        },
      });
      self.postMessage({ type: 'ready', id });
    } else if (data.type === 'generate') {
      const started = performance.now();
      const audio = await tts.generate(data.text, { voice: data.voice });
      self.postMessage({
        type: 'audio', id,
        blob: wav16(audio.audio, audio.sampling_rate),
        ms: Math.round(performance.now() - started),
        seconds: audio.audio.length / audio.sampling_rate,
      });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
