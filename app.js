(() => {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const els = {
    appTitle: $('#appTitle'), backBtn: $('#backBtn'),
    libraryView: $('#libraryView'), readerView: $('#readerView'), player: $('#player'),
    fileInput: $('#fileInput'), pasteTitle: $('#pasteTitle'), pasteText: $('#pasteText'), pasteAdd: $('#pasteAdd'),
    bookmarkletBody: $('#bookmarkletBody'), status: $('#status'),
    library: $('#library'), emptyLibrary: $('#emptyLibrary'),
    chapterSelect: $('#chapterSelect'), text: $('#text'),
    prevBtn: $('#prevBtn'), playBtn: $('#playBtn'), nextBtn: $('#nextBtn'),
    playIcon: $('#playIcon'), pauseIcon: $('#pauseIcon'),
    rate: $('#rate'), rateValue: $('#rateValue'), voiceSelect: $('#voiceSelect'),
    previewBtn: $('#previewBtn'), playerStatus: $('#playerStatus'), debugLog: $('#debugLog'),
  };

  // ---------- Storage: works and reading positions live in IndexedDB on this device ----------

  const DB = (() => {
    const memory = { works: new Map(), positions: new Map() };
    let dbPromise;
    function open() {
      dbPromise ||= new Promise(resolve => {
        try {
          const req = indexedDB.open('fic-listener', 1);
          req.onupgradeneeded = () => {
            req.result.createObjectStore('works', { keyPath: 'id' });
            req.result.createObjectStore('positions', { keyPath: 'id' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
      return dbPromise;
    }
    async function run(store, mode, fn, fallback) {
      const db = await open();
      if (!db) return fallback(memory[store]);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      });
    }
    return {
      persistent: async () => !!(await open()),
      allWorks: () => run('works', 'readonly', s => s.getAll(), m => [...m.values()]),
      getWork: id => run('works', 'readonly', s => s.get(id), m => m.get(id)),
      putWork: w => run('works', 'readwrite', s => s.put(w), m => m.set(w.id, w)),
      deleteWork: async id => {
        await run('works', 'readwrite', s => s.delete(id), m => m.delete(id));
        await run('positions', 'readwrite', s => s.delete(id), m => m.delete(id));
      },
      allPositions: () => run('positions', 'readonly', s => s.getAll(), m => [...m.values()]),
      getPosition: id => run('positions', 'readonly', s => s.get(id), m => m.get(id)),
      putPosition: p => run('positions', 'readwrite', s => s.put(p), m => m.set(p.id, p)),
    };
  })();

  const settings = (() => {
    const defaults = { rate: 1, voiceURI: '' };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem('fic-listener-settings') || '{}') }; }
    catch { return defaults; }
  })();
  function saveSettings() {
    try { localStorage.setItem('fic-listener-settings', JSON.stringify(settings)); } catch {}
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function setStatus(msg) { els.status.textContent = msg; }

  // ---------- Library ----------

  async function addWork(parsed, sourceUrl) {
    if (!parsed.chapters.length) throw new Error('No story text was found in that file.');
    const works = await DB.allWorks();
    const existing = sourceUrl && works.find(w => w.sourceUrl === sourceUrl);
    const work = {
      id: existing?.id || newId(),
      title: parsed.title || 'Untitled',
      author: parsed.author || '',
      chapters: parsed.chapters,
      sourceUrl: sourceUrl || '',
      added: existing?.added || Date.now(),
    };
    await DB.putWork(work);
    return work;
  }

  async function renderLibrary() {
    const [works, positions] = await Promise.all([DB.allWorks(), DB.allPositions()]);
    const pos = new Map(positions.map(p => [p.id, p]));
    works.sort((a, b) => (pos.get(b.id)?.updated || b.added) - (pos.get(a.id)?.updated || a.added));

    els.library.replaceChildren(...works.map(w => {
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.className = 'open';
      const title = document.createElement('b');
      title.textContent = w.title;
      const meta = document.createElement('span');
      const p = pos.get(w.id);
      const count = w.chapters.length;
      meta.textContent = [
        w.author,
        count === 1 ? '1 chapter' : `${count} chapters`,
        p ? `at chapter ${p.chapter + 1}` : 'not started',
      ].filter(Boolean).join(' · ');
      open.append(title, meta);
      open.onclick = () => openWork(w.id);

      const del = document.createElement('button');
      del.className = 'delete';
      del.textContent = 'Remove';
      del.onclick = async () => {
        if (!confirm(`Remove “${w.title}” from your library?`)) return;
        await DB.deleteWork(w.id);
        renderLibrary();
      };
      li.append(open, del);
      return li;
    }));
    els.emptyLibrary.hidden = works.length > 0;
  }

  els.fileInput.onchange = async () => {
    const files = [...els.fileInput.files];
    els.fileInput.value = '';
    for (const file of files) {
      setStatus(`Reading ${file.name}…`);
      try {
        const work = await addWork(await Parsers.fromFile(file));
        setStatus(`Added “${work.title}” (${work.chapters.length} chapter${work.chapters.length === 1 ? '' : 's'}).`);
      } catch (err) {
        console.error(err);
        setStatus(`Couldn’t read ${file.name}: ${err.message}`);
      }
    }
    renderLibrary();
  };

  els.pasteAdd.onclick = async () => {
    const text = els.pasteText.value.trim();
    if (!text) return setStatus('Paste some text first.');
    try {
      const work = await addWork(Parsers.fromText(text, els.pasteTitle.value.trim() || 'Pasted story'));
      els.pasteText.value = els.pasteTitle.value = '';
      setStatus(`Added “${work.title}”.`);
      renderLibrary();
    } catch (err) { setStatus(err.message); }
  };

  // ---------- The AO3 "Listen" bookmark ----------
  // It runs in your own AO3 tab, copies the text already on screen and hands it to this
  // app. It makes no requests to AO3, so from AO3's side it's just you reading the page.

  const AO3_ORIGIN = /^https:\/\/(www\.)?(archiveofourown\.(org|com|net)|ao3\.org)$/;

  function bookmarkletCode() {
    const app = location.origin + location.pathname;
    const src = `(()=>{const A=${JSON.stringify(app)},O=${JSON.stringify(location.origin)};`
      + `const r=document.querySelector('#workskin');`
      + `if(!r){alert('Open a story on AO3 first, then tap Listen.');return}`
      + `if(document.querySelector('a[href*="view_full_work=true"]')&&!confirm('Only this chapter is on screen. OK = listen to just this chapter. Cancel = go back, tap "Entire Work", then tap Listen again.'))return;`
      + `const w=window.open(A+'#import','_blank');`
      + `if(!w){alert('Please allow pop-ups for AO3, then try again.');return}`
      + `const d={type:'fic-listener-import',html:r.outerHTML,url:location.href.split('#')[0]};`
      + `const h=e=>{if(e.source===w&&e.data==='fic-listener-ready'){w.postMessage(d,O);removeEventListener('message',h)}};`
      + `addEventListener('message',h)})()`;
    return 'javascript:' + encodeURIComponent(src);
  }

  function renderBookmarkletHelp() {
    const body = els.bookmarkletBody;
    if (!/^https?:$/.test(location.protocol)) {
      body.innerHTML = '<p class="hint">This works once the app is opened from a web address. Use <b>start.command</b> to open it.</p>';
      return;
    }
    const code = bookmarkletCode();
    body.innerHTML = `
      <p class="hint">A bookmark that reads the AO3 page you already have open. It never contacts AO3 itself, so it’s the same as you reading the page.</p>
      <p><b>On a computer:</b> drag this button onto your bookmarks bar.</p>
      <p><a class="bookmarklet" id="bmLink">🎧 Listen</a></p>
      <p><b>On iPhone or iPad (Safari), set it up once:</b></p>
      <ol>
        <li><button class="secondary-btn" id="bmCopy">Copy the Listen code</button></li>
        <li>Tap the Share button (square with an arrow) → <b>Add Bookmark</b>. Name it <b>Listen</b>, choose the <b>Favorites</b> folder, tap <b>Save</b>.</li>
        <li>Tap the Bookmarks button (open book) → <b>Favorites</b> → <b>Edit</b> → tap <b>Listen</b>. Delete the address underneath the name, paste the code, tap <b>Done</b>.</li>
      </ol>
      <p><b>Then on AO3:</b> open a story and tap <b>Entire Work</b> if it has chapters. Tap the address bar at the top; your Favorites appear. Tap <b>Listen</b>. (Or type “Listen” into the address bar and tap the bookmark when it shows up.)</p>`;
    body.querySelector('#bmLink').href = code;
    body.querySelector('#bmLink').onclick = e => { e.preventDefault(); alert('Drag this button to your bookmarks bar instead of clicking it.'); };
    body.querySelector('#bmCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(code); setStatus('Listen code copied.'); }
      catch { prompt('Copy this code:', code); }
    };
  }

  function listenForImport() {
    if (location.hash !== '#import' || !window.opener) return;
    history.replaceState(null, '', location.pathname);
    setStatus('Receiving the story from AO3…');
    window.addEventListener('message', async e => {
      if (!AO3_ORIGIN.test(e.origin) || e.data?.type !== 'fic-listener-import') return;
      try {
        const doc = new DOMParser().parseFromString(e.data.html, 'text/html');
        const work = await addWork(Parsers.fromDocument(doc), e.data.url);
        setStatus(`Added “${work.title}”.`);
        await renderLibrary();
        openWork(work.id);
      } catch (err) {
        setStatus(`Couldn’t read that page: ${err.message}`);
      }
    });
    window.opener.postMessage('fic-listener-ready', '*');
  }

  // ---------- Reader ----------

  // The whole work is laid out as one continuous text, so playback flows from
  // chapter to chapter without stopping. Chapter titles are read aloud as they come up.
  let work = null;
  let sentences = [];      // [{ text, el, chapter }] for the whole work
  let chapterStarts = [];  // index of each chapter's first sentence
  let idx = 0;
  const chapterOf = i => sentences[i]?.chapter ?? 0;

  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;
  const MAX_CHUNK = 220;

  function splitSentences(paragraph) {
    const raw = segmenter
      ? [...segmenter.segment(paragraph)].map(s => s.segment.trim())
      : paragraph.match(/[^.!?…]+[.!?…]+["'”’)\]]*|[^.!?…]+$/g)?.map(s => s.trim()) || [paragraph];
    // Some voices cut out on very long utterances, so split long sentences at commas or spaces.
    return raw.filter(Boolean).flatMap(s => {
      const out = [];
      while (s.length > MAX_CHUNK) {
        const head = s.slice(0, MAX_CHUNK);
        let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' — '), head.lastIndexOf(': '));
        if (cut < 60) cut = head.lastIndexOf(' ');
        if (cut < 1) cut = MAX_CHUNK;
        out.push(s.slice(0, cut + 1).trim());
        s = s.slice(cut + 1).trim();
      }
      if (s) out.push(s);
      return out;
    });
  }

  async function openWork(id) {
    stop();
    clearAudioCache();
    work = await DB.getWork(id);
    if (!work) return;
    updateMediaSession();
    const choice = downloadableChoice();
    if (choice) choice.engine.load(choice.voice).catch(err => setPlayerStatus(err.message));
    const pos = await DB.getPosition(id);

    els.chapterSelect.replaceChildren(...work.chapters.map((c, i) => new Option(c.title, i)));
    els.chapterSelect.hidden = work.chapters.length < 2;
    renderWork();
    const ch = Math.min(pos?.chapter || 0, work.chapters.length - 1);
    idx = Math.min((chapterStarts[ch] || 0) + (pos?.sentence || 0), Math.max(sentences.length - 1, 0));

    els.appTitle.textContent = work.title;
    els.backBtn.hidden = false;
    els.libraryView.hidden = true;
    els.readerView.hidden = false;
    els.player.hidden = false;
    highlight(true);
  }

  function closeWork() {
    stop();
    clearAudioCache();
    work = null;
    els.appTitle.textContent = 'Fic Listener';
    els.backBtn.hidden = true;
    els.readerView.hidden = true;
    els.player.hidden = true;
    els.libraryView.hidden = false;
    renderLibrary();
  }

  function renderWork() {
    sentences = [];
    chapterStarts = [];
    const frag = document.createDocumentFragment();
    const addSentence = (parent, text, chapter) => {
      const span = document.createElement('span');
      span.className = 's';
      span.textContent = text;
      span.dataset.i = sentences.length;
      sentences.push({ text, el: span, chapter });
      parent.append(span, ' ');
    };
    work.chapters.forEach((ch, c) => {
      chapterStarts.push(sentences.length);
      const h = document.createElement('h2');
      addSentence(h, ch.title, c);
      frag.append(h);
      for (const para of ch.paragraphs) {
        const p = document.createElement('p');
        for (const text of splitSentences(para)) addSentence(p, text, c);
        frag.append(p);
      }
    });
    els.text.replaceChildren(frag);
  }

  let highlighted = null;
  function highlight(forceScroll = false) {
    highlighted?.classList.remove('current');
    highlighted = sentences[idx]?.el || null;
    if (!highlighted) return;
    highlighted.classList.add('current');
    els.chapterSelect.value = chapterOf(idx);
    const r = highlighted.getBoundingClientRect();
    const bottomLimit = window.innerHeight - els.player.offsetHeight - 20;
    if (forceScroll || r.top < 70 || r.bottom > bottomLimit) {
      highlighted.scrollIntoView({ block: 'center', behavior: forceScroll ? 'auto' : 'smooth' });
    }
  }

  let saveTimer;
  function savePosition() {
    if (!work) return;
    const ch = chapterOf(idx);
    const p = { id: work.id, chapter: ch, sentence: idx - (chapterStarts[ch] || 0), updated: Date.now() };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DB.putPosition(p), 400);
  }

  function jump(i, forceScroll = false) {
    if (i < 0 || i >= sentences.length) return;
    idx = i;
    if (playing) { if (forceScroll) highlight(true); speakCurrent(); }
    else { highlight(forceScroll); savePosition(); }
  }

  // ---------- Speech ----------
  // Two engines: the device's built-in voices (speechSynthesis) and Kokoro, an open
  // voice model that runs in a worker and plays through an <audio> element.
  // The <audio> route keeps playing when the phone is locked.

  const synth = window.speechSynthesis;
  let playing = false;
  let token = 0;          // bumps on every new utterance so stale callbacks are ignored
  let utterance = null;   // keep a reference: Chrome drops callbacks for garbage-collected utterances
  let voices = [];

  const KOKORO_PREFIX = 'kokoro:';
  const KOKORO_VOICES = [
    ['af_heart', 'Heart', 'American woman'],
    ['af_bella', 'Bella', 'American woman'],
    ['af_nicole', 'Nicole', 'American woman, soft'],
    ['af_aoede', 'Aoede', 'American woman'],
    ['af_kore', 'Kore', 'American woman'],
    ['af_sarah', 'Sarah', 'American woman'],
    ['am_fenrir', 'Fenrir', 'American man'],
    ['am_michael', 'Michael', 'American man'],
    ['am_puck', 'Puck', 'American man'],
    ['bf_emma', 'Emma', 'British woman'],
    ['bm_george', 'George', 'British man'],
    ['bm_fable', 'Fable', 'British man'],
  ];
  const PIPER_PREFIX = 'piper:';
  const PIPER_VOICES = [
    ['en_US-ljspeech-medium', 'Linda', 'American woman, audiobook narrator'],
    ['en_US-hfc_female-medium', 'Hazel', 'American woman'],
    ['en_US-amy-medium', 'Amy', 'American woman'],
    ['en_US-kristin-medium', 'Kristin', 'American woman'],
    ['en_US-lessac-medium', 'Lessac', 'American woman'],
    ['en_US-hfc_male-medium', 'Hugo', 'American man'],
    ['en_US-ryan-medium', 'Ryan', 'American man'],
    ['en_US-joe-medium', 'Joe', 'American man'],
    ['en_GB-cori-medium', 'Cori', 'British woman, audiobook narrator'],
    ['en_GB-jenny_dioco-medium', 'Jenny', 'British woman'],
    ['en_GB-alan-medium', 'Alan', 'British man'],
    ['en_GB-northern_english_male-medium', 'Northern', 'British man'],
  ];

  // Returns { engine, voice } for a Kokoro/Piper choice, or null for a built-in voice.
  function downloadableChoice(uri = settings.voiceURI) {
    if (uri.startsWith(KOKORO_PREFIX)) return { engine: KokoroEngine, voice: uri.slice(KOKORO_PREFIX.length) };
    if (uri.startsWith(PIPER_PREFIX)) return { engine: PiperEngine, voice: uri.slice(PIPER_PREFIX.length) };
    return null;
  }
  const isDownloadable = () => !!downloadableChoice();

  const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Deranged|Hysterical|Pipe Organ)\b/;

  function voiceQuality(v) {
    const id = `${v.name} ${v.voiceURI}`;
    if (/premium/i.test(id)) return 'Premium';
    if (/enhanced/i.test(id)) return 'Enhanced';
    if (/natural|neural|google/i.test(id)) return 'Natural';
    return '';
  }

  const regionNames = (() => {
    try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }); } catch { return null; }
  })();

  function voiceLabel(v) {
    const name = v.name.replace(/\s*\((premium|enhanced)\)/i, '');
    const region = v.lang.split(/[-_]/)[1];
    let place = v.lang;
    try { if (region && regionNames) place = regionNames.of(region.toUpperCase()); } catch {}
    return [name, voiceQuality(v), place].filter(Boolean).join(' · ');
  }

  function loadVoices() {
    const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
    voices = synth ? synth.getVoices().filter(v => !NOVELTY.test(v.name)) : [];
    const rank = v => ({ Premium: 3, Enhanced: 2, Natural: 1 }[voiceQuality(v)] || 0);
    voices.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
    const mine = voices.filter(v => v.lang.toLowerCase().startsWith(lang));
    const group = (label, options) => {
      const g = document.createElement('optgroup');
      g.label = label;
      g.append(...options);
      return g;
    };
    const opts = list => list.map(v => new Option(voiceLabel(v), v.voiceURI));
    const best = mine.filter(v => rank(v) > 0);
    const rest = mine.filter(v => rank(v) === 0);
    const others = voices.filter(v => !v.lang.toLowerCase().startsWith(lang));
    els.voiceSelect.replaceChildren(
      group('Kokoro: most natural, needs a recent device (160 MB once)',
        KOKORO_VOICES.map(([id, name, desc]) => new Option(`${name} · ${desc}`, KOKORO_PREFIX + id))),
      group('Piper: natural, works on most devices (60 MB per voice)',
        PIPER_VOICES.map(([id, name, desc]) => new Option(`${name} · ${desc}`, PIPER_PREFIX + id))),
      ...(best.length ? [group('Best voices on this device', opts(best))] : []),
      ...(rest.length ? [group(best.length ? 'Other voices on this device' : 'Voices on this device', opts(rest))] : []),
      ...(others.length ? [group('Other languages', opts(others))] : []),
    );
    const choice = downloadableChoice();
    const known = choice
      ? [...KOKORO_VOICES, ...PIPER_VOICES].some(([id]) => id === choice.voice)
      : voices.some(v => v.voiceURI === settings.voiceURI);
    if (!known) settings.voiceURI = (mine[0] || voices[0])?.voiceURI || KOKORO_PREFIX + 'af_heart';
    els.voiceSelect.value = settings.voiceURI;
  }

  const currentVoice = () => voices.find(v => v.voiceURI === settings.voiceURI) || null;
  const speakable = text => /[\p{L}\p{N}]/u.test(text);

  let playerStatusTimer;
  function setPlayerStatus(msg, clearAfterMs) {
    els.playerStatus.textContent = msg;
    clearTimeout(playerStatusTimer);
    if (clearAfterMs) playerStatusTimer = setTimeout(() => { els.playerStatus.textContent = ''; }, clearAfterMs);
  }

  // A short log of what the voice is doing; tap the status line under the player to see it.
  const debugLines = [];
  function dbg(msg) {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    debugLines.push(`${t} ${msg}`);
    if (debugLines.length > 60) debugLines.shift();
    els.debugLog.textContent = debugLines.join('\n');
  }

  // ---------- Downloadable voices (Kokoro and Piper) ----------
  // Each engine runs in its own worker and downloads its voice files once.

  function makeEngine({ name, workerUrl, requirement, hint = '' }) {
    const STALL_MS = 45000;      // no download progress for this long = give up
    const GENERATE_MS = 60000;   // one sentence taking this long = the voice is stuck
    let worker = null;
    let nextId = 0;
    let chain = Promise.resolve();   // one request at a time
    let lastPercent = -1;
    let slowWarned = false;
    const pending = new Map();
    const loads = new Map();         // voice -> Promise

    function reset(err) {
      worker?.terminate();
      worker = null;
      for (const p of pending.values()) { p.done(); p.reject(err); }
      pending.clear();
      loads.clear();
    }

    function onMessage({ data }) {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.type === 'progress') {
        p.touch?.();
        const percent = Math.floor(data.percent);
        if (percent !== lastPercent) {
          lastPercent = percent;
          setPlayerStatus(`Downloading ${name} voice… ${percent}% (one time only)`);
        }
        return;
      }
      pending.delete(data.id);
      p.done();
      if (data.type === 'error') p.reject(new Error(data.message));
      else if (data.type === 'ready') p.resolve();
      else if (data.type === 'audio') {
        dbg(`${name}: made ${data.seconds.toFixed(1)}s of speech in ${(data.ms / 1000).toFixed(1)}s`);
        if (!slowWarned && data.seconds > 1.5 && data.ms > data.seconds * 1000 * 1.1 && nextId > 3) {
          slowWarned = true;
          setPlayerStatus(`${name} is slower than speech on this device, so expect pauses.${hint}`, 10000);
        }
        p.resolve(data.blob);
      }
    }

    function request(msg, timeoutMs, isDownload) {
      if (!worker) {
        worker = new Worker(workerUrl, { type: 'module' });
        worker.onmessage = onMessage;
        worker.onerror = e => reset(new Error(e.message || 'the voice worker crashed'));
      }
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        let timer;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => reset(new Error(isDownload ? 'the download stalled' : 'the voice stopped responding')), timeoutMs);
        };
        arm();
        pending.set(id, { resolve, reject, touch: isDownload ? arm : null, done: () => clearTimeout(timer) });
        worker.postMessage({ ...msg, id });
      });
    }

    function load(voice) {
      if (loads.has(voice)) return loads.get(voice);
      const promise = (async () => {
        const problem = requirement?.();
        if (problem) throw new Error(problem);
        setPlayerStatus(`Starting ${name} voice…`);
        dbg(`starting ${name} (${voice})`);
        let lastError;
        for (let attempt = 1; attempt <= 2; attempt++) {   // one retry covers a dropped download
          try {
            lastPercent = -1;
            await request({ type: 'load', voice }, STALL_MS, true);
            loads.set(voice, promise);
            dbg(`${name} ready`);
            setPlayerStatus(`${name} voice ready.`, 2500);
            return;
          } catch (err) {
            lastError = err;
            dbg(`${name} load attempt ${attempt} failed: ${err.message}`);
          }
        }
        throw new Error(`${name} couldn’t start (${lastError?.message || 'unknown error'}). Press play to try again, or pick another voice.${hint}`);
      })();
      loads.set(voice, promise);
      promise.catch(() => { if (loads.get(voice) === promise) loads.delete(voice); });
      return promise;
    }

    function generate(text, voice) {
      const run = async () => {
        await load(voice);
        return request({ type: 'generate', text, voice }, GENERATE_MS, false).catch(err => {
          throw new Error(`${name}: ${err.message}.${hint}`);
        });
      };
      const result = chain.then(run, run);
      chain = result.catch(() => {});
      return result;
    }

    // Free the memory when switching to a different kind of voice.
    function unload() { if (worker) { dbg(`${name} unloaded`); reset(new Error('voice changed')); } }

    return { name, load, generate, unload };
  }

  const KokoroEngine = makeEngine({
    name: 'Kokoro',
    workerUrl: 'kokoro-worker.js?v=8',
    // On the CPU Kokoro is slower than speech, so it's only offered with WebGPU.
    requirement: () => navigator.gpu ? null : 'Kokoro needs a newer browser (Safari on iOS 26 or macOS 26, or Chrome). Piper voices work here.',
    hint: ' Piper voices work on more devices.',
  });
  const PiperEngine = makeEngine({ name: 'Piper', workerUrl: 'piper-worker.js?v=8' });

  const audio = new Audio();
  audio.setAttribute('playsinline', '');
  audio.preload = 'auto';

  // iOS only lets audio start from a tap. Playing a moment of silence during the tap
  // "unlocks" the element so later sentences can start on their own.
  const SILENCE = (() => {
    const n = 2400, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 24000, true); v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  })();
  function unlockAudio() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    audio.onended = null;
    audio.src = SILENCE;
    audio.play().then(() => dbg('audio unlocked'), err => { if (err.name !== 'AbortError') dbg(`unlock refused: ${err.name}`); });
  }

  // Sentences are generated ahead of the one being read, one at a time.
  const LOOKAHEAD = 40;   // sentences, roughly 2–3 minutes of speech
  const audioCache = new Map();   // `${voice}|${index}` -> { promise, url }
  let generating = false;
  let generationWaiters = [];

  function clearAudioCache() {
    for (const e of audioCache.values()) if (e.url) URL.revokeObjectURL(e.url);
    audioCache.clear();
  }

  function pruneAudioCache() {
    for (const [key, e] of audioCache) {
      const i = Number(key.split('|')[1]);
      if (e.url && (i < idx - 2 || i > idx + LOOKAHEAD * 2)) {
        URL.revokeObjectURL(e.url);
        audioCache.delete(key);
      }
    }
  }

  function pumpGeneration() {
    const choice = downloadableChoice();
    if (generating || !choice || !work) return;
    const voice = settings.voiceURI;
    for (let i = idx; i < Math.min(sentences.length, idx + LOOKAHEAD); i++) {
      if (!speakable(sentences[i].text)) continue;
      const key = `${voice}|${i}`;
      if (audioCache.has(key)) continue;
      generating = true;
      const entry = {};
      entry.promise = choice.engine.generate(sentences[i].text, choice.voice).then(blob => (entry.url = URL.createObjectURL(blob)));
      audioCache.set(key, entry);
      entry.promise
        .catch(err => { audioCache.delete(key); entry.error = err; })
        .finally(() => {
          generating = false;
          const waiters = generationWaiters;
          generationWaiters = [];
          waiters.forEach(w => w(entry.error));
          pumpGeneration();
        });
      return;
    }
  }

  async function audioFor(i) {
    const key = `${settings.voiceURI}|${i}`;
    while (!audioCache.has(key)) {
      pumpGeneration();
      if (audioCache.has(key)) break;
      const err = await new Promise(r => generationWaiters.push(r));
      if (err) throw err;
    }
    return audioCache.get(key).promise;
  }

  async function speakDownloaded(my) {
    const key = `${settings.voiceURI}|${idx}`;
    const ready = !!audioCache.get(key)?.url;
    if (!ready) {
      keepAudioAlive();
      if (!/Downloading|Starting/.test(els.playerStatus.textContent)) setPlayerStatus('Preparing voice…');
    }
    let url;
    try {
      url = await audioFor(idx);
    } catch (err) {
      if (my !== token) return;
      stop();
      dbg(`could not make audio: ${err.message}`);
      return setPlayerStatus(err.message);
    }
    if (my !== token || !playing) return;
    audio.onended = () => { if (my === token && playing) advance(); };
    audio.loop = false;
    audio.src = url;
    audio.playbackRate = settings.rate;
    // If nothing starts within a few seconds, say so instead of sitting silently.
    const watchdog = setTimeout(() => {
      if (my !== token || !playing || !audio.paused) return;
      dbg(`audio did not start (readyState ${audio.readyState}, error ${audio.error?.code ?? 'none'})`);
      setPlayerStatus('The audio didn’t start. Tap play again; if it keeps happening, tap here for details.');
    }, 6000);
    try {
      await audio.play();
      if (my === token && /Preparing voice|ready\./.test(els.playerStatus.textContent)) setPlayerStatus('');
    } catch (err) {
      clearTimeout(watchdog);
      if (my !== token) return;
      dbg(`play() refused: ${err.name} ${err.message}`);
      stop();
      return setPlayerStatus(err.name === 'NotAllowedError'
        ? 'Tap play to continue.'
        : `This audio couldn’t play (${err.name}). Tap here for details.`);
    }
    pruneAudioCache();
    pumpGeneration();
  }

  audio.addEventListener('playing', () => { if (!audio.loop) dbg(`playing sentence ${idx + 1}`); });
  audio.addEventListener('error', () => dbg(`audio error code ${audio.error?.code}: ${audio.error?.message || ''}`));
  audio.addEventListener('stalled', () => dbg('audio stalled'));

  function speakDevice(my, text) {
    const u = new SpeechSynthesisUtterance(text);
    const v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = settings.rate;
    u.onend = () => { if (my === token && playing) advance(); };
    u.onerror = e => {
      if (my !== token || !playing || e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') { stop(); return setPlayerStatus('Tap play to start listening.'); }
      console.warn('Speech error:', e.error);
      advance();
    };
    utterance = u;
    const busy = synth.speaking || synth.pending;
    if (busy) {
      synth.cancel();
      // Safari sometimes drops an utterance queued in the same tick as cancel().
      setTimeout(() => { if (my === token) synth.speak(u); }, 60);
    } else {
      synth.speak(u);
    }
  }

  function silenceAll() {
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    audio.onended = null;
    audio.loop = false;
    audio.pause();
  }

  // iOS ends a web page's audio session (and soon suspends the page) once its audio
  // stops. Between sentences, or while the next one is still being made, loop a
  // moment of silence so playback carries on with the screen locked.
  function keepAudioAlive() {
    if (audio.loop && !audio.paused) return;
    audio.onended = null;
    audio.loop = true;
    audio.src = SILENCE;
    audio.play().catch(() => {});
  }

  function speakCurrent() {
    highlight();
    savePosition();
    const my = ++token;
    const s = sentences[idx];
    if (!s) return stop();
    const downloaded = isDownloadable();
    if (downloaded) { if (synth?.speaking) synth.cancel(); }
    else silenceAll();
    if (!speakable(s.text)) {           // scene breaks like "* * *": short pause, no speech
      if (downloaded) keepAudioAlive();
      setTimeout(() => { if (my === token && playing) advance(); }, 400);
      return;
    }
    if (isDownloadable()) speakDownloaded(my);
    else speakDevice(my, s.text);
  }

  function advance() {
    if (idx < sentences.length - 1) { idx++; speakCurrent(); return; }
    stop();
    setPlayerStatus(`Finished “${work.title}”.`);
  }

  function play() {
    if (!sentences.length) return;
    if (isDownloadable()) unlockAudio();
    else if (!synth) return setPlayerStatus('This browser can’t use built-in voices. Pick a Kokoro voice.');
    playing = true;
    updatePlayButton();
    keepScreenOn(!isDownloadable());
    speakCurrent();
  }

  function stop() {
    playing = false;
    token++;
    silenceAll();
    updatePlayButton();
    keepScreenOn(false);
  }

  function updatePlayButton() {
    // SVG elements have no .hidden property in Safari, so set the attribute itself.
    els.playIcon.toggleAttribute('hidden', playing);
    els.pauseIcon.toggleAttribute('hidden', !playing);
    els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !work) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: work.title, artist: work.author || 'Fic Listener' });
    } catch {}
  }
  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => play(),
      pause: () => stop(),
      previoustrack: () => jump(idx - 1),
      nexttrack: () => jump(idx + 1),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
    }
  }

  async function preview() {
    const text = 'Hi! This is how I sound reading your stories.';
    if (playing) stop();
    const choice = downloadableChoice();
    if (choice) {
      unlockAudio();
      if (!els.playerStatus.textContent) setPlayerStatus('Preparing voice…');
      try {
        const blob = await choice.engine.generate(text, choice.voice);
        if (playing) return;
        audio.onended = null;
        audio.src = URL.createObjectURL(blob);
        audio.playbackRate = settings.rate;
        await audio.play();
        if (/Preparing voice/.test(els.playerStatus.textContent)) setPlayerStatus('');
      } catch (err) {
        setPlayerStatus(err.message);
      }
    } else if (synth) {
      silenceAll();
      speakDevice(++token, text);
    }
  }

  // Built-in voices stop when the phone locks, so keep the screen awake while they play.
  let wakeLock = null;
  async function keepScreenOn(on) {
    try {
      if (on && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playing && !isDownloadable()) keepScreenOn(true);
  });

  // ---------- Wiring ----------

  els.backBtn.onclick = closeWork;
  els.playBtn.onclick = () => (playing ? stop() : play());
  els.prevBtn.onclick = () => jump(idx - 1);
  els.nextBtn.onclick = () => jump(idx + 1);
  els.previewBtn.onclick = preview;
  els.playerStatus.onclick = () => { els.debugLog.hidden = !els.debugLog.hidden; };
  els.chapterSelect.onchange = () => jump(chapterStarts[Number(els.chapterSelect.value)], true);
  els.text.onclick = e => {
    const span = e.target.closest('.s');
    if (!span || window.getSelection()?.toString()) return;
    idx = Number(span.dataset.i);
    if (playing) speakCurrent(); else play();
  };

  els.rate.value = settings.rate;
  els.rateValue.textContent = `${Number(settings.rate).toFixed(1)}×`;
  els.rate.oninput = () => {
    settings.rate = Number(els.rate.value);
    els.rateValue.textContent = `${settings.rate.toFixed(1)}×`;
    audio.playbackRate = settings.rate;   // Kokoro audio changes speed immediately
    saveSettings();
  };
  els.rate.onchange = () => { if (playing && !isDownloadable()) speakCurrent(); };
  els.voiceSelect.onchange = () => {
    settings.voiceURI = els.voiceSelect.value;
    saveSettings();
    clearAudioCache();
    const choice = downloadableChoice();
    for (const engine of [KokoroEngine, PiperEngine]) if (engine !== choice?.engine) engine.unload();
    if (choice) choice.engine.load(choice.voice).catch(err => setPlayerStatus(err.message));
    if (playing) {
      keepScreenOn(!choice);
      if (choice) unlockAudio();
      speakCurrent();
    }
  };

  document.addEventListener('keydown', e => {
    if (!work || e.target.closest('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? stop() : play(); }
    else if (e.key === 'ArrowRight') jump(idx + 1);
    else if (e.key === 'ArrowLeft') jump(idx - 1);
  });

  loadVoices();
  if (synth) {
    synth.addEventListener?.('voiceschanged', loadVoices);
    // Safari sometimes loads voices late without firing the event.
    let tries = 0;
    const poll = setInterval(() => { if (voices.length || ++tries > 20) clearInterval(poll); else loadVoices(); }, 250);
  }

  renderBookmarkletHelp();
  renderLibrary();
  listenForImport();
  DB.persistent().then(ok => {
    if (!ok) setStatus('This browser is in private mode, so your library won’t be saved after you close the tab.');
  });
})();
