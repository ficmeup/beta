// Runs Piper voices off the main thread. Each voice (~60 MB) downloads once and is kept
// in the browser's private storage. Runs on the CPU, so it works on almost any device.
// Text never leaves the device.
import * as piper from 'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/+esm';

async function wavSeconds(blob) {
  const header = new DataView(await blob.slice(0, 44).arrayBuffer());
  const byteRate = header.getUint32(28, true);
  return byteRate ? (blob.size - 44) / byteRate : 0;
}

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'load') {
      const stored = await piper.stored().catch(() => []);
      if (!stored.includes(data.voice)) {
        await piper.download(data.voice, p => {
          if (p.total) self.postMessage({ type: 'progress', id, percent: (p.loaded * 100) / p.total });
        });
      }
      // A first short sentence warms the voice up so the story starts promptly.
      await piper.predict({ text: 'Ready.', voiceId: data.voice });
      self.postMessage({ type: 'ready', id });
    } else if (data.type === 'generate') {
      const started = performance.now();
      const blob = await piper.predict({ text: data.text, voiceId: data.voice });
      self.postMessage({ type: 'audio', id, blob, ms: Math.round(performance.now() - started), seconds: await wavSeconds(blob) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
