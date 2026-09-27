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
    work = await DB.getWork(id);
    if (!work) return;
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

  // ---------- Speech (the device's built-in voices) ----------

  const synth = window.speechSynthesis;
  let playing = false;
  let token = 0;          // bumps on every new utterance so stale callbacks are ignored
  let utterance = null;   // keep a reference: Chrome drops callbacks for garbage-collected utterances
  let voices = [];

  const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Deranged|Hysterical|Pipe Organ)\b/;

  function voiceScore(v) {
    const lang = (navigator.language || 'en').toLowerCase();
    const vl = v.lang.toLowerCase().replace('_', '-');
    let s = 0;
    if (vl === lang) s += 4; else if (vl.split('-')[0] === lang.split('-')[0]) s += 3;
    if (/premium|enhanced|natural|neural/i.test(v.name)) s += 2;
    if (/google|siri/i.test(v.name)) s += 1;
    return s;
  }

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices().filter(v => !NOVELTY.test(v.name));
    if (!voices.length) return;
    voices.sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));
    const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
    const mine = voices.filter(v => v.lang.toLowerCase().startsWith(lang));
    const others = voices.filter(v => !v.lang.toLowerCase().startsWith(lang));
    const group = (label, list) => {
      const g = document.createElement('optgroup');
      g.label = label;
      g.append(...list.map(v => new Option(`${v.name} (${v.lang})`, v.voiceURI)));
      return g;
    };
    els.voiceSelect.replaceChildren(
      ...(mine.length ? [group('Your language', mine)] : []),
      ...(others.length ? [group('Other languages', others)] : []),
    );
    if (!voices.some(v => v.voiceURI === settings.voiceURI)) settings.voiceURI = voices[0].voiceURI;
    els.voiceSelect.value = settings.voiceURI;
  }

  const currentVoice = () => voices.find(v => v.voiceURI === settings.voiceURI) || null;
  const speakable = text => /[\p{L}\p{N}]/u.test(text);

  function speakCurrent() {
    highlight();
    savePosition();
    const my = ++token;
    const s = sentences[idx];
    if (!s) return stop();
    if (!speakable(s.text)) {           // scene breaks like "* * *": short pause, no speech
      setTimeout(() => { if (my === token && playing) advance(); }, 400);
      return;
    }
    const u = new SpeechSynthesisUtterance(s.text);
    const v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = settings.rate;
    u.onend = () => { if (my === token && playing) advance(); };
    u.onerror = e => {
      if (my !== token || !playing || e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') { stop(); return setStatus('Tap play to start listening.'); }
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

  function advance() {
    if (idx < sentences.length - 1) { idx++; speakCurrent(); return; }
    stop();
    setStatus(`Finished “${work.title}”.`);
  }

  function play() {
    if (!synth) return alert('This browser can’t read aloud. Try Safari or Chrome.');
    if (!sentences.length) return;
    playing = true;
    updatePlayButton();
    keepScreenOn(true);
    speakCurrent();
  }

  function stop() {
    playing = false;
    token++;
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    updatePlayButton();
    keepScreenOn(false);
  }

  function updatePlayButton() {
    els.playIcon.hidden = playing;
    els.pauseIcon.hidden = !playing;
    els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  // Built-in voices stop when the phone locks, so keep the screen awake while playing.
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
    if (document.visibilityState === 'visible' && playing) keepScreenOn(true);
  });

  // ---------- Wiring ----------

  els.backBtn.onclick = closeWork;
  els.playBtn.onclick = () => (playing ? stop() : play());
  els.prevBtn.onclick = () => jump(idx - 1);
  els.nextBtn.onclick = () => jump(idx + 1);
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
    saveSettings();
  };
  els.rate.onchange = () => { if (playing) speakCurrent(); };
  els.voiceSelect.onchange = () => {
    settings.voiceURI = els.voiceSelect.value;
    saveSettings();
    if (playing) speakCurrent();
  };

  document.addEventListener('keydown', e => {
    if (!work || e.target.closest('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? stop() : play(); }
    else if (e.key === 'ArrowRight') jump(idx + 1);
    else if (e.key === 'ArrowLeft') jump(idx - 1);
  });

  if (synth) {
    loadVoices();
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
