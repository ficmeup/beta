// Runs the Kokoro voice model off the main thread. The model (~90 MB) downloads once,
// then the browser caches it. Text never leaves the device.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;

self.onmessage = async ({ data }) => {
  if (data.type === 'load') {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL, {
        dtype: data.dtype,
        device: data.device,
        progress_callback: p => self.postMessage({ type: 'progress', p }),
      });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  } else if (data.type === 'generate') {
    try {
      const audio = await tts.generate(data.text, { voice: data.voice });
      self.postMessage({ type: 'audio', id: data.id, blob: audio.toBlob() });
    } catch (err) {
      self.postMessage({ type: 'audio', id: data.id, error: String(err?.message || err) });
    }
  }
};
