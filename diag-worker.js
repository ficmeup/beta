// Kokoro diagnostics: runs each step separately and reports progress, so a freeze shows
// exactly where it happened. Used only by diag.html.
const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const PHONEMIZER_URL = 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/+esm';   // the pronunciation step Kokoro uses

async function timed(label, fn) {
  step(`${label}…`);
  const started = performance.now();
  const result = await fn();
  step(`${label}: done in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  return result;
}

async function pronunciationCheck() {
  const { phonemize } = await timed('Loading the pronunciation module', () => import(PHONEMIZER_URL));
  for (const text of ['Hi.', 'She paused at the door, listening to the rain.']) {
    const out = await timed(`Pronouncing "${text}"`, () => phonemize(text, 'en-us'));
    step(`Sounds: ${[].concat(out).join(' ')}`);
  }
  step('The pronunciation step works.');
}

const post = (type, extra = {}) => self.postMessage({ type, ...extra });
const step = msg => post('step', { msg });
setInterval(() => post('alive'), 1000);

async function gpuCheck() {
  if (!self.navigator.gpu) return step('No WebGPU in the worker (navigator.gpu missing).');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return step('WebGPU present, but no graphics adapter was given.');
  const info = adapter.info || {};
  step(`Adapter: ${info.vendor || '?'} ${info.architecture || ''} ${info.description || ''}`.trim());
  const L = adapter.limits;
  step(`Limits: maxBufferSize ${Math.round(L.maxBufferSize / 1048576)} MB, maxStorageBufferBindingSize ${Math.round(L.maxStorageBufferBindingSize / 1048576)} MB, maxComputeInvocationsPerWorkgroup ${L.maxComputeInvocationsPerWorkgroup}`);
  step(`Features: ${[...adapter.features].join(', ') || 'none'}`);
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var<storage, read_write> data: array<f32>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) { data[id.x] = data[id.x] * 2.0; }` });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const n = 1024, input = new Float32Array(n).map((_, i) => i);
  const buf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, input);
  const read = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(n / 64); pass.end();
  enc.copyBufferToBuffer(buf, 0, read, 0, n * 4);
  device.queue.submit([enc.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(read.getMappedRange());
  step(`GPU test calculation: ${out[10] === 20 && out[1000] === 2000 ? 'correct' : `WRONG (${out[10]}, ${out[1000]})`}`);
  device.destroy();
}

async function kokoroCheck(device, dtype) {
  step('Loading the Kokoro library…');
  const { KokoroTTS } = await import(KOKORO_URL);
  step('Library loaded. Loading the model (downloads if not cached)…');
  let lastPct = -10;
  const tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype, device,
    progress_callback: p => {
      if (p.status === 'progress' && /\.onnx$/.test(p.file || '') && p.progress - lastPct >= 10) {
        lastPct = p.progress;
        post('progress', { pct: Math.floor(p.progress) });
      }
      if (p.status === 'done' && /\.onnx$/.test(p.file || '')) step(`Model file ready: ${p.file}`);
    },
  });
  step('Model loaded and started.');
  // Kokoro's generate() = pronunciation, then the voice file, then the model. Time each alone.
  await pronunciationCheck();
  await timed('Fetching the voice file', async () => (await fetch(`https://huggingface.co/${MODEL}/resolve/main/voices/af_heart.bin`)).arrayBuffer());
  await timed('Running the voice model on ready-made sounds', async () => {
    const { input_ids } = tts.tokenizer('həlˈoʊ.', { truncation: true });
    await tts.generate_from_ids(input_ids, { voice: 'af_heart' });
  });
  for (const text of ['Hi.', 'She paused at the door, listening to the rain against the window.']) {
    step(`Generating "${text}"…`);
    const started = performance.now();
    const audio = await tts.generate(text, { voice: 'af_heart' });
    const ms = performance.now() - started;
    const x = audio.audio;
    let peak = 0, nan = 0;
    for (let i = 0; i < x.length; i++) { if (Number.isNaN(x[i])) nan++; else peak = Math.max(peak, Math.abs(x[i])); }
    const seconds = x.length / audio.sampling_rate;
    step(`Made ${seconds.toFixed(1)}s of speech in ${(ms / 1000).toFixed(1)}s (peak ${peak.toFixed(2)}, bad samples ${nan}).`);
    post('audio', { blob: audio.toBlob() });
  }
  step('Kokoro works in this mode.');
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'gpu') await gpuCheck();
    else if (data.type === 'pronounce') await pronunciationCheck();
    else await kokoroCheck(data.device, data.dtype);
    post('done');
  } catch (err) {
    post('error', { msg: String(err?.stack || err?.message || err).slice(0, 800) });
  }
};
