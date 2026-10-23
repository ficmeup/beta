(() => {
  'use strict';

  const $ = sel => document.querySelector(sel);

  // The beta (ficmeup.github.io/beta/) keeps its own library, settings, queue and
  // notes, so a test version can't damage anyone's real library. Downloaded voices
  // are shared, so testers don't download them twice.
  const IS_BETA = /^\/beta(\/|$)/.test(location.pathname);
  const NS = IS_BETA ? 'beta-' : '';
  if (IS_BETA) document.documentElement.classList.add('beta');

  // Anonymous counts with GoatCounter (no cookies, nothing about the person or what
  // they read): which ways people add stories, and whether they actually listen.
  function track(event) {
    try { window.goatcounter?.count?.({ path: `${IS_BETA ? 'beta/' : ''}${event}`, title: event, event: true }); } catch {}
  }
  const els = {
    appTitle: $('#appTitle'), backBtn: $('#backBtn'),
    libraryView: $('#libraryView'), readerView: $('#readerView'), player: $('#player'),
    fileInput: $('#fileInput'), pasteTitle: $('#pasteTitle'), pasteText: $('#pasteText'), pasteAdd: $('#pasteAdd'), pasteBox: $('#pasteBox'),
    bookmarkletBody: $('#bookmarkletBody'), status: $('#status'),
    library: $('#library'), emptyLibrary: $('#emptyLibrary'),
    chapterSelect: $('#chapterSelect'), text: $('#text'),
    prevBtn: $('#prevBtn'), playBtn: $('#playBtn'), nextBtn: $('#nextBtn'),
    playIcon: $('#playIcon'), pauseIcon: $('#pauseIcon'),
    rate: $('#rate'), rateValue: $('#rateValue'), voiceSelect: $('#voiceSelect'),
    previewBtn: $('#previewBtn'), back30Btn: $('#back30Btn'), fwd30Btn: $('#fwd30Btn'),
    sleepChips: $('#sleepChips'), sleepLeft: $('#sleepLeft'),
    settingsToggle: $('#settingsToggle'), settingsPanel: $('#settings'),
    summaryRate: $('#summaryRate'), summaryVoice: $('#summaryVoice'), summarySleep: $('#summarySleep'),
    libraryCount: $('#libraryCount'), clipAdd: $('#clipAdd'),
    libTabs: $('#libTabs'), viewActions: $('#viewActions'),
    playerToggle: $('#playerToggle'),
    pronFrom: $('#pronFrom'), pronTo: $('#pronTo'), pronTest: $('#pronTest'), pronAdd: $('#pronAdd'),
    pronTarget: $('#pronTarget'), pronMine: $('#pronMine'), pronShared: $('#pronShared'),
    pronFab: $('#pronFab'), pronSheet: $('#pronSheet'), psFrom: $('#psFrom'), psTo: $('#psTo'),
    psHear: $('#psHear'), psTest: $('#psTest'), psAdd: $('#psAdd'), psTarget: $('#psTarget'),
    pronMineCount: $('#pronMineCount'), pronSharedCount: $('#pronSharedCount'), pronAdmin: $('#pronAdmin'), pronBox: $('#pronBox'), ao3Link: $('#ao3Link'),
    sheet: $('#sheet'), sheetTitle: $('#sheetTitle'), sheetActions: $('#sheetActions'),
    fontSelect: $('#fontSelect'), chapterBar: $('.chapter-bar'), topbar: $('.topbar'),
    textSmaller: $('#textSmaller'), textLarger: $('#textLarger'), textSizeValue: $('#textSizeValue'),
    downloadPrompt: $('#downloadPrompt'), downloadText: $('#downloadText'),
    promptPreviewBtn: $('#promptPreviewBtn'), downloadBtn: $('#downloadBtn'), playerStatus: $('#playerStatus'), debugLog: $('#debugLog'),
  };

  // ---------- Storage: works and reading positions live in IndexedDB on this device ----------

  const DB = (() => {
    const memory = { works: new Map(), positions: new Map() };
    let dbPromise;
    function open() {
      dbPromise ||= new Promise(resolve => {
        try {
          const req = indexedDB.open(`${NS}fic-listener`, 1);
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
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(`${NS}fic-listener-settings`) || '{}') }; }
    catch { return defaults; }
  })();
  function saveSettings() {
    try { localStorage.setItem(`${NS}fic-listener-settings`, JSON.stringify(settings)); } catch {}
  }

  // ---------- Rooms: Space (stored as 'dark'), Paper, Work ----------
  // The page follows the device until someone picks a room; then their pick wins.
  const roomButtons = document.querySelectorAll('.roomtog button');
  const ROOM_COLOURS = { dark: '#050505', paper: '#D8D8D3', work: '#FFFFFF' };
  let roomChosen = window.__roomStored;
  function applyRoom(room) {
    document.documentElement.setAttribute('data-room', room);
    roomButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.room === room)));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', ROOM_COLOURS[room] || ROOM_COLOURS.dark);
  }
  applyRoom(document.documentElement.getAttribute('data-room') || 'dark');
  roomButtons.forEach(b => b.addEventListener('click', () => {
    roomChosen = b.dataset.room;
    try { localStorage.setItem('fic-listener-room', roomChosen); } catch {}
    applyRoom(roomChosen);
  }));
  try {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
      if (!roomChosen) applyRoom(e.matches ? 'paper' : 'dark');
    });
  } catch {}

  // ---------- Colour field ----------
  // Each story gets two hues, 140° apart, taken from its title. The field shows
  // behind the story, drifts while it's being read, and holds still on pause.
  function setFieldFor(title) {
    let h = 0;
    for (const ch of title || '') h = (h * 31 + ch.codePointAt(0)) % 360;
    document.documentElement.style.setProperty('--h1', h);
    document.documentElement.style.setProperty('--h2', (h + 140) % 360);
  }

  // ---------- Queue, playlists and notes ----------
  // Small, so they live in localStorage alongside the settings.
  const Lists = (() => {
    const KEY = `${NS}fic-listener-lists`;
    let data = {};
    try { data = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
    data.queue ||= [];        // work ids, in order
    data.playlists ||= [];    // [{ id, name, items: [work ids] }]
    data.notes ||= {};        // work id -> text
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} };
    const forget = id => {
      data.queue = data.queue.filter(x => x !== id);
      data.playlists.forEach(pl => { pl.items = pl.items.filter(x => x !== id); });
      delete data.notes[id];
      save();
    };
    return { data, save, forget };
  })();

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function setStatus(msg) { els.status.textContent = msg; }

  // ---------- Library ----------

  async function addWork(parsed, sourceUrl) {
    if (!parsed.chapters.length) throw new Error('No story text was found in that file.');
    const works = await DB.allWorks();
    const url = sourceUrl || parsed.url || '';
    const existing = url && works.find(w => w.sourceUrl === url);
    const work = {
      id: existing?.id || newId(),
      title: parsed.title || 'Untitled',
      author: parsed.author || '',
      chapters: parsed.chapters,
      info: parsed.info || [],      // AO3's Rating…Stats block, shown but not read aloud
      sourceUrl: url,
      added: existing?.added || Date.now(),
    };
    await DB.putWork(work);
    fillStubs(work);
    return work;
  }

  // The library has four kinds of view: everything, the queue, notes, and each playlist.
  // A playlist item is a work id, or, for a shared playlist, a stub { t, a, u } for a
  // work that isn't in this library yet. Adding that work later fills the stub in.
  let libView = 'all';
  const isStub = x => typeof x === 'object' && x !== null;

  function fillStubs(work) {
    let changed = false;
    for (const pl of Lists.data.playlists) {
      pl.items = pl.items.map(x => {
        if (isStub(x) && ((x.u && x.u === work.sourceUrl) || (!x.u && x.t === work.title && (x.a || '') === (work.author || '')))) {
          changed = true;
          return work.id;
        }
        return x;
      });
    }
    if (changed) Lists.save();
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  // A shared playlist is a link carrying titles, authors and AO3 addresses only.
  async function sharePlaylist(pl) {
    const works = new Map((await DB.allWorks()).map(w => [w.id, w]));
    const items = pl.items.map(x => {
      if (isStub(x)) return x;
      const w = works.get(x);
      return w && { t: w.title, a: w.author || '', u: w.sourceUrl || '' };
    }).filter(Boolean);
    const url = `${location.origin}${location.pathname}#playlist=${b64encode(JSON.stringify({ v: 1, n: pl.name, i: items }))}`;
    const text = `“${pl.name}”: ${items.length} ${items.length === 1 ? 'work' : 'works'}${inWork() ? '' : ' from AO3'}, as a Fic Me Up playlist.`;
    try {
      if (navigator.share) { await navigator.share({ title: pl.name, text, url }); return; }
    } catch (err) { if (err.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); setStatus('Playlist link copied.'); }
    catch { prompt('Copy this playlist link:', url); }
  }

  // Opening a shared playlist link offers to add it.
  async function receivePlaylist() {
    const m = location.hash.match(/^#playlist=([\w-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    let data;
    try { data = JSON.parse(b64decode(m[1])); } catch { return setStatus('That playlist link is damaged. Ask for it again.'); }
    const works = await DB.allWorks();
    const items = (data.i || []).map(x => {
      const w = works.find(w => (x.u && w.sourceUrl === x.u) || (w.title === x.t && (w.author || '') === (x.a || '')));
      return w ? w.id : { t: String(x.t || 'Untitled'), a: String(x.a || ''), u: /^https:\/\/archiveofourown\.org\/works\/\d+$/.test(x.u) ? x.u : '' };
    });
    const have = items.filter(x => !isStub(x)).length;
    if (!confirm(`Add the shared playlist “${data.n}”? ${items.length} works; ${have} already in your library. ${inWork() ? 'The others come with links' : 'The others link to AO3'} so you can add them.`)) return;
    const pl = { id: newId(), name: String(data.n || 'Shared playlist').slice(0, 80), items };
    Lists.data.playlists.push(pl);
    Lists.save();
    libView = `pl:${pl.id}`;
    renderLibrary();
  }

  function renderTabs(total) {
    const noteCount = Object.keys(Lists.data.notes).length;
    const tabs = [['all', `All ${total}`], ['queue', `Queue ${Lists.data.queue.length}`],
      ...(noteCount ? [['notes', `Notes ${noteCount}`]] : []),
      ...Lists.data.playlists.map(pl => [`pl:${pl.id}`, `${pl.name} ${pl.items.length}`])];
    if (!tabs.some(([v]) => v === libView)) libView = 'all';
    els.libTabs.replaceChildren(...tabs.map(([v, label]) => {
      const b = document.createElement('button');
      b.className = 'fbtn';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(v === libView));
      b.onclick = () => { libView = v; renderLibrary(); };
      return b;
    }));
  }

  function renderViewActions(items) {
    const btn = (label, fn, primary) => {
      const b = document.createElement('button');
      b.className = primary ? 'primary-btn' : 'secondary-btn';
      b.textContent = label;
      b.onclick = fn;
      return b;
    };
    const acts = [];
    if (libView === 'queue' && items.length) {
      acts.push(btn('Play queue', () => startList(items.map(w => w.id)), true));
      acts.push(btn('Clear queue', () => { Lists.data.queue = []; Lists.save(); renderLibrary(); }));
    } else if (libView.startsWith('pl:')) {
      const pl = Lists.data.playlists.find(x => `pl:${x.id}` === libView);
      const ready = items.filter(w => !w.stub);
      if (ready.length) acts.push(btn('Play all', () => startList(ready.map(w => w.id)), true));
      acts.push(btn('Share', () => sharePlaylist(pl)));
      acts.push(btn('Rename', () => { const n = prompt('Playlist name', pl.name)?.trim(); if (n) { pl.name = n; Lists.save(); renderLibrary(); } }));
      acts.push(btn('Delete playlist', () => {
        if (!confirm(`Delete the playlist “${pl.name}”? The stories stay in your library.`)) return;
        Lists.data.playlists = Lists.data.playlists.filter(x => x !== pl); Lists.save(); libView = 'all'; renderLibrary();
      }));
    }
    els.viewActions.replaceChildren(...acts);
  }

  // Play a list in order: the first opens now, the rest go to the front of the queue.
  async function startList(ids) {
    if (!ids.length) return;
    const [first, ...rest] = ids;
    Lists.data.queue = [...rest, ...Lists.data.queue.filter(id => !ids.includes(id))];
    Lists.save();
    if (isDownloadable()) unlockAudio();   // this tap lets playback start once the story opens
    await openWork(first, { fromStart: true });
    play();
  }

  // Shares the fic's AO3 page (or an AO3 search for it), never the text.
  async function shareWork(w) {
    const url = isAo3(w) ? ao3Link(w) : w.sourceUrl;
    const text = `${w.title}${w.author ? ` by ${w.author}` : ''}${isAo3(w) && !inWork() ? ', on AO3' : ''}`;
    try {
      if (navigator.share) { await navigator.share({ title: w.title, text, url }); return; }
    } catch (err) { if (err.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); setStatus(`${inWork() ? 'Link' : 'AO3 link'} for “${w.title}” copied.`); }
    catch { prompt(inWork() ? 'Copy the link:' : 'Copy the AO3 link:', url); }
  }

  function openSheet(w) {
    els.sheetTitle.textContent = w.title;
    const acts = [];
    const add = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'sheet-btn';
      b.textContent = label;
      b.onclick = () => { els.sheet.close(); fn(); };
      acts.push(b);
    };
    const q = Lists.data.queue;
    add('Play next', () => { Lists.data.queue = [w.id, ...q.filter(x => x !== w.id)]; Lists.save(); renderLibrary(); setStatus(`“${w.title}” plays next.`); });
    if (!q.includes(w.id)) add('Add to queue', () => { q.push(w.id); Lists.save(); renderLibrary(); setStatus(`“${w.title}” added to the queue.`); });
    else add('Remove from queue', () => { Lists.data.queue = q.filter(x => x !== w.id); Lists.save(); renderLibrary(); });
    for (const pl of Lists.data.playlists) {
      if (pl.items.includes(w.id)) add(`Remove from “${pl.name}”`, () => { pl.items = pl.items.filter(x => x !== w.id); Lists.save(); renderLibrary(); });
      else add(`Add to “${pl.name}”`, () => { pl.items.push(w.id); Lists.save(); renderLibrary(); setStatus(`Added to “${pl.name}”.`); });
    }
    add('New playlist…', () => {
      const name = prompt('Name the playlist')?.trim();
      if (!name) return;
      Lists.data.playlists.push({ id: newId(), name, items: [w.id] });
      Lists.save(); renderLibrary(); setStatus(`Made “${name}” with “${w.title}” in it.`);
    });
    if (isAo3(w) || w.sourceUrl) add('Share', () => shareWork(w));
    if (isAo3(w) && !inWork()) add(w.sourceUrl ? 'Open on AO3' : 'Find on AO3', () => window.open(ao3Link(w), '_blank', 'noopener'));
    else if (w.sourceUrl) add('Open the original page', () => window.open(w.sourceUrl, '_blank', 'noopener'));
    add('Remove from library', async () => {
      if (!confirm(`Remove “${w.title}” from your library? Your notes on it go too.`)) return;
      await DB.deleteWork(w.id);
      Lists.forget(w.id);
      renderLibrary();
    });
    els.sheetActions.replaceChildren(...acts);
    els.sheet.showModal();
  }

  // A shared-playlist entry for a work that isn't in this library yet.
  function stubRow(w, i) {
    const li = document.createElement('li');
    li.className = 'stub';
    const a = document.createElement('a');
    a.className = 'open';
    a.href = w.sourceUrl || `https://archiveofourown.org/works/search?work_search%5Bquery%5D=${encodeURIComponent(`"${w.title}" ${w.author || ''}`.trim())}`;
    a.target = '_blank';
    a.rel = 'noopener';
    const b = document.createElement('b');
    b.textContent = w.title;
    const meta = document.createElement('span');
    meta.textContent = [String(i + 1).padStart(2, '0'), w.author, 'Not in your library'].filter(Boolean).join(' · ');
    const fromAo3 = document.createElement('span');
    fromAo3.className = 'not-work'; fromAo3.textContent = ' · add it from AO3';
    meta.append(fromAo3);
    a.append(b, meta);
    const rm = document.createElement('button');
    rm.className = 'delete';
    rm.textContent = '×';
    rm.setAttribute('aria-label', `Remove ${w.title} from this playlist`);
    rm.onclick = () => {
      const pl = Lists.data.playlists.find(x => `pl:${x.id}` === libView);
      if (pl) { pl.items = pl.items.filter(x => x !== w.stub); Lists.save(); renderLibrary(); }
    };
    li.append(a, rm);
    return li;
  }

  async function renderLibrary() {
    const [works, positions] = await Promise.all([DB.allWorks(), DB.allPositions()]);
    const pos = new Map(positions.map(p => [p.id, p]));
    const byId = new Map(works.map(w => [w.id, w]));
    // drop ids of works that no longer exist
    Lists.data.queue = Lists.data.queue.filter(id => byId.has(id));
    Lists.data.playlists.forEach(pl => { pl.items = pl.items.filter(x => isStub(x) || byId.has(x)); });
    renderTabs(works.length);

    let items;
    if (libView === 'queue') items = Lists.data.queue.map(id => byId.get(id));
    else if (libView.startsWith('pl:')) items = (Lists.data.playlists.find(x => `pl:${x.id}` === libView)?.items || [])
      .map(x => (isStub(x) ? { stub: x, id: null, title: x.t, author: x.a, sourceUrl: x.u, chapters: [] } : byId.get(x)));
    else if (libView === 'notes') items = works.filter(w => Lists.data.notes[w.id])
      .sort((a, b) => (pos.get(b.id)?.updated || b.added) - (pos.get(a.id)?.updated || a.added));
    else items = [...works].sort((a, b) => (pos.get(b.id)?.updated || b.added) - (pos.get(a.id)?.updated || a.added));
    renderViewActions(items);

    els.library.replaceChildren(...items.map((w, i) => {
      if (w.stub) return stubRow(w, i);
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.className = 'open';
      const title = document.createElement('b');
      title.textContent = w.title;
      const meta = document.createElement('span');
      const p = pos.get(w.id);
      const count = w.chapters.length;
      meta.textContent = [
        libView === 'all' ? '' : String(i + 1).padStart(2, '0'),
        w.author,
        count === 1 ? '1 chapter' : `${count} chapters`,
        p ? `at chapter ${p.chapter + 1}` : 'not started',
        Lists.data.queue.includes(w.id) && libView !== 'queue' ? 'queued' : '',
        Lists.data.notes[w.id] ? 'notes' : '',
      ].filter(Boolean).join(' · ');
      open.append(title, meta);
      if (libView === 'notes') {
        const note = document.createElement('i');
        note.className = 'note-preview';
        note.textContent = Lists.data.notes[w.id];
        open.append(note);
      }
      open.onclick = () => openWork(w.id);

      const more = document.createElement('button');
      more.className = 'delete';
      more.textContent = '⋯';
      more.setAttribute('aria-label', `More for ${w.title}`);
      more.onclick = () => openSheet(w);
      li.append(open, more);
      return li;
    }));
    const empty = !items.length;
    els.emptyLibrary.hidden = !empty;
    const emptyText = libView === 'notes' ? 'No notes yet.'
      : libView === 'queue' ? 'The queue is empty. Use ⋯ on a story to add it.'
      : libView.startsWith('pl:') ? 'This playlist is empty. Use ⋯ on a story to add it.'
      : null;
    if (emptyText) els.emptyLibrary.textContent = emptyText;
    else els.emptyLibrary.innerHTML = 'No stories yet. Open a file<span class="not-work"> from AO3</span> above.';
    els.libraryCount.textContent = works.length ? `${works.length} ${works.length === 1 ? 'story' : 'stories'}` : '';
  }

  els.fileInput.onchange = async () => {
    const files = [...els.fileInput.files];
    els.fileInput.value = '';
    for (const file of files) {
      setStatus(`Reading ${file.name}…`);
      try {
        const work = await addWork(await Parsers.fromFile(file));
        track('added-file');
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
    // something the Listen bookmark or a Shortcut copied: read it the same way as Paste
    if (text.startsWith(CLIP_PREFIX) || text.startsWith(FILE_PREFIX)) {
      els.pasteText.value = els.pasteTitle.value = '';
      return addPasted(text);
    }
    try {
      const work = await addWork(Parsers.fromText(text, els.pasteTitle.value.trim() || 'Pasted story'));
      track('added-typed-paste');
      els.pasteText.value = els.pasteTitle.value = '';
      setStatus(`Added “${work.title}”.`);
      renderLibrary();
    } catch (err) { setStatus(err.message); }
  };

  // ---------- The AO3 "Listen" bookmark ----------
  // It runs in your own AO3 tab, copies the text already on screen and hands it to this
  // app. It makes no requests to AO3, so from AO3's side it's just you reading the page.
  // The code itself is in listen.js, shared with the guide.
  const CLIP_PREFIX = Listen.PREFIX;
  const bookmarkletCode = () => Listen.code(location.origin + location.pathname, location.origin);

  // Browsers often refuse the first clipboard read: a computer asks for permission and
  // the page loses focus, and an iPhone's Paste bubble can be missed. Reading needs a
  // fresh tap, so after a refusal it asks for one more tap; if that's refused too it
  // opens the paste box, where a press-and-hold Paste always works.
  async function readClipboard() {
    const cb = navigator.clipboard;
    if (!cb) throw new Error('no clipboard');
    let text = '', html = '', kinds = [];
    if (cb.read) {
      const items = await cb.read();
      kinds = items.flatMap(i => [...i.types]);
      const item = items.find(i => i.types.includes('text/plain')) || items.find(i => i.types.includes('text/html'));
      if (item) {
        const type = item.types.includes('text/plain') ? 'text/plain' : 'text/html';
        const raw = await (await item.getType(type)).text();
        if (type === 'text/plain') text = raw; else html = raw;
      }
    } else {
      text = await cb.readText();
    }
    return { text, html, kinds };
  }

  let pasteRefused = 0;
  async function addFromClipboard() {
    let got;
    try {
      got = await readClipboard();
    } catch {
      if (++pasteRefused < 2) {
        els.clipAdd.textContent = 'Tap again';
        setTimeout(() => { els.clipAdd.textContent = 'Paste'; }, 8000);
        return setStatus('Tap Paste once more. If a small Paste bubble appears, tap it.');
      }
      pasteRefused = 0;
      els.clipAdd.textContent = 'Paste';
      els.pasteBox.open = true;
      els.pasteText.focus();
      return setStatus('Your browser didn’t let the app read the clipboard. Press and hold in the box below and tap Paste.');
    }
    pasteRefused = 0;
    els.clipAdd.textContent = 'Paste';
    await addPasted(got.text, got.html, got.kinds);
  }

  // Pasting what the Listen bookmark or a Shortcut copied into the box adds it straight away.
  els.pasteText.addEventListener('paste', e => {
    const text = (e.clipboardData?.getData('text/plain') || '').trim();
    if (!text.startsWith(CLIP_PREFIX) && !text.startsWith(FILE_PREFIX)) return;
    e.preventDefault();
    els.pasteBox.open = false;
    addPasted(text);
  });

  // Paste: reads what the Shortcuts or the Listen bookmark copied.
  //   FICMEUP1:{html,url}      a web page (an AO3 work or any other page)
  //   FICMEUPF1:name:base64    a file shared from another app (EPUB, PDF, Word…)
  //   anything else long        plain text, added as a story
  const FILE_PREFIX = 'FICMEUPF1:';
  async function addPasted(text, html = '', kinds = []) {
    text = (text || '').trim();
    try {
      let parsed, url = '';
      if (text.startsWith(CLIP_PREFIX)) {
        const data = JSON.parse(text.slice(CLIP_PREFIX.length));
        url = data.url || '';
        setStatus('Reading the page…');
        parsed = await Parsers.fromPage(new DOMParser().parseFromString(String(data.html), 'text/html'), url);
      } else if (!text && html) {
        // formatted text only: read it like a web page, keeping paragraphs and headings
        parsed = await Parsers.fromPage(new DOMParser().parseFromString(html, 'text/html'), '', 'Pasted text');
      } else if (text.startsWith(FILE_PREFIX)) {
        const rest = text.slice(FILE_PREFIX.length);
        const cut = rest.lastIndexOf(':');
        const name = rest.slice(0, cut) || 'Shared file';
        const bin = atob(rest.slice(cut + 1).replace(/\s+/g, ''));
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        setStatus(`Reading ${name}…`);
        parsed = await Parsers.fromFile(new File([bytes], name));
      } else if (/^https?:\/\/\S+$/.test(text)) {
        return setStatus('That’s a link. The app can’t download pages, so copy the story’s text instead: open the link in Safari, tap aA → Show Reader, press and hold the text, Select All, Copy, then Paste here.');
      } else if (text.length > 80) {
        const lines = text.split('\n');
        const at = lines.findIndex(l => l.trim());
        const firstLine = lines[at].trim();
        const short = firstLine.length <= 80;
        parsed = Parsers.fromText(short ? lines.slice(at + 1).join('\n') : text, short ? firstLine : 'Pasted text');
      } else {
        if (kinds.some(k => k.startsWith('image/'))) return setStatus('That’s a picture, not text. Copy the story’s text instead.');
        return setStatus('No text to paste. A copied book or file can’t be pasted into a web app: in Books or Files, tap Share → Save to Files, then use Open a file here. For a web page, copy its text: in Safari, aA → Show Reader, press and hold, Select All, Copy.');
      }
      const work = await addWork(parsed, url);
      track(text.startsWith(CLIP_PREFIX) ? 'added-shortcut-page' : text.startsWith(FILE_PREFIX) ? 'added-shortcut-file' : 'added-paste');
      setStatus(`Added “${work.title}”.`);
      await renderLibrary();
      openWork(work.id);
    } catch (err) {
      setStatus(`That couldn’t be read: ${err.message}`);
    }
  }

  function renderBookmarkletHelp() {
    const body = els.bookmarkletBody;
    if (!/^https?:$/.test(location.protocol)) {
      body.innerHTML = '<p class="hint">The bookmark needs the app to be opened from a web address. Use <b>start.command</b>, or the published link.</p>';
      return;
    }
    const code = bookmarkletCode();
    body.innerHTML = `
      <p><b>Computer.</b> Drag this onto your bookmarks bar:</p>
      <p><a class="bookmarklet" id="bmLink">Listen</a></p>
      <p><b>Phone or tablet.</b> Set it up once:</p>
      <ol>
        <li><button class="secondary-btn" id="bmCopy">Copy the Listen code</button></li>
        <li>Open any web page → <b>Share</b> → <b>Add Bookmark</b>. Name the bookmark <b>Listen</b> and save it to the folder <b>Favorites</b>.</li>
        <li>Go to <b>Bookmarks</b> → <b>Favorites</b> and <b>Edit</b> the <b>Listen</b> bookmark. Replace the address with the code copied above. Tap <b>Done</b>.</li>
        <li><span class="not-work">Open AO3 in your browser → tap <b>Entire Work</b> → </span><span class="only-work">Open the page in your browser → </span>tap <b>⋯</b> → click <b>Bookmarks</b> → <b>Listen</b>. It opens Fic Me Up, and you can listen away. On a phone, choose one of the two options: <b>Open in browser</b>, or <b>Copy for the Home Screen app</b>.</li>
      </ol>`;
    body.querySelector('#bmLink').href = code;
    body.querySelector('#bmLink').onclick = e => { e.preventDefault(); alert('Drag this onto your bookmarks bar. Clicking it here does nothing.'); };
    body.querySelector('#bmCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(code); setStatus('Listen code copied.'); }
      catch { prompt('Copy this code:', code); }
    };
  }

  function listenForImport() {
    if (location.hash !== '#import' || !window.opener) return;
    history.replaceState(null, '', location.pathname);
    setStatus('Receiving the page…');
    window.addEventListener('message', async e => {
      // only the page that opened this window, on any site
      if (e.source !== window.opener || e.data?.type !== 'fic-listener-import') return;
      try {
        const doc = new DOMParser().parseFromString(String(e.data.html), 'text/html');
        const work = await addWork(await Parsers.fromPage(doc, e.data.url), e.data.url);
        track('added-bookmark');
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

  async function openWork(id, { fromStart = false } = {}) {
    cancelQueueCountdown();
    stop();
    clearAudioCache();
    work = await DB.getWork(id);
    if (!work) return;
    // AO3's Rating…Stats block is shown above the story but never read aloud.
    const split = Parsers.splitAo3Info(work.chapters);
    work.chapters = split.chapters;
    if (!work.info?.length) work.info = split.info;
    setFieldFor(work.title);
    document.body.classList.add('reading');
    updateMediaSession();
    const choice = downloadableChoice();
    if (choice && isDownloaded()) choice.engine.load(choice.voice).catch(err => setPlayerStatus(err.message));
    updateDownloadPrompt();
    const pos = await DB.getPosition(id);

    els.chapterSelect.replaceChildren(...work.chapters.map((c, i) => new Option(c.title, i)));
    els.chapterSelect.hidden = work.chapters.length < 2;
    renderWork();
    if (pos?.rate) setRate(pos.rate);   // each story remembers its own speed
    const ch = Math.min(pos?.chapter || 0, work.chapters.length - 1);
    idx = Math.min((chapterStarts[ch] || 0) + (pos?.sentence || 0), Math.max(sentences.length - 1, 0));
    if (fromStart && idx >= sentences.length - 1) idx = 0;   // a finished work in the queue starts over

    els.appTitle.textContent = work.title;
    if (isAo3(work)) {
      els.ao3Link.hidden = false;
      els.ao3Link.href = ao3Link(work);
      els.ao3Link.textContent = work.sourceUrl ? 'AO3 ↗' : 'Find on AO3 ↗';
      els.ao3Link.classList.add('not-work');
    } else {
      els.ao3Link.hidden = !work.sourceUrl;
      els.ao3Link.href = work.sourceUrl || '#';
      els.ao3Link.textContent = 'Source ↗';
      els.ao3Link.classList.remove('not-work');
    }
    els.backBtn.hidden = false;
    els.libraryView.hidden = true;
    els.readerView.hidden = false;
    els.player.hidden = false;
    highlight(true);
    if (closedWhileReading) {
      closedWhileReading = false;
      setPlayerStatus('Fic Me Up was closed while reading. Tap here for details.');
    }
  }

  async function closeWork() {
    stop();
    await flushPosition();
    clearAudioCache();
    work = null;
    document.body.classList.remove('reading');
    els.appTitle.textContent = 'Fic Me Up';
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
    frag.append(...renderWorkExtras());
    work.chapters.forEach((ch, c) => {
      chapterStarts.push(sentences.length);
      const h = document.createElement('h2');
      if (ch.paragraphs.length) addSentence(h, ch.title, c);
      else h.textContent = ch.title;   // an empty chapter's title is shown, not read
      frag.append(h);
      for (const para of ch.paragraphs) {
        const p = document.createElement('p');
        for (const text of splitSentences(para)) addSentence(p, text, c);
        frag.append(p);
      }
    });
    frag.append(renderFinish());
    els.text.replaceChildren(frag);
  }

  // AO3 works get AO3 links; anything else links to its original page, if it has one.
  const inWork = () => document.documentElement.dataset.room === 'work';   // Work room: no AO3 mentions
  const isAo3 = w => /archiveofourown\.org/.test(w.sourceUrl || '') || !!w.info?.length;
  const ao3Link = w => w.sourceUrl
    || `https://archiveofourown.org/works/search?work_search%5Bquery%5D=${encodeURIComponent(`"${w.title}" ${w.author || ''}`.trim())}`;

  // AO3's info block and the reader's own notes, above the story. Neither is read aloud.
  function renderWorkExtras() {
    const out = [];
    if (work.info?.length) {
      const d = document.createElement('details');
      d.className = 'work-info';
      d.open = true;
      d.innerHTML = '<summary>Work info</summary>';
      const dl = document.createElement('dl');
      for (const [label, value] of work.info) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        dl.append(dt, dd);
      }
      d.append(dl);
      out.push(d);
    }
    const notes = document.createElement('details');
    notes.className = 'notes';
    const note = Lists.data.notes[work.id] || '';
    notes.open = !!note;
    notes.innerHTML = '<summary>Your notes</summary>';
    const ta = document.createElement('textarea');
    ta.rows = 4;
    ta.placeholder = 'Saved on this device for now; they move to your account once sign-in is on. Not read aloud.';
    ta.value = note;
    const id = work.id;
    let t;
    ta.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (ta.value.trim()) Lists.data.notes[id] = ta.value; else delete Lists.data.notes[id];
        Lists.save();
      }, 400);
    };
    notes.append(ta);
    out.push(notes);
    return out;
  }

  // After the last sentence: send the reader back to AO3, where the writer sees it.
  function renderFinish() {
    const f = document.createElement('section');
    f.className = 'finish';
    if (!isAo3(work)) {
      f.innerHTML = `<p class="mono">End</p><div class="cta"></div>`;
      if (work.sourceUrl) {
        const a = document.createElement('a');
        a.className = 'primary-btn'; a.target = '_blank'; a.rel = 'noopener';
        a.href = work.sourceUrl; a.textContent = 'Open the original page';
        f.querySelector('.cta').append(a);
      }
      const k = document.createElement('a');
      k.className = 'secondary-btn kofi'; k.target = '_blank'; k.rel = 'noopener';
      k.href = 'https://ko-fi.com/thisandthatspace'; k.textContent = 'Support Fic Me Up';
      f.querySelector('.cta').append(k);
      return f;
    }
    const onAo3 = !!work.sourceUrl;
    f.innerHTML = `
      <p class="mono">End of work</p>
      <p class="not-work">The writer sees kudos and comments on AO3, and nothing from this app.</p>
      <div class="cta">
        <a class="primary-btn" target="_blank" rel="noopener"></a>
        <a class="secondary-btn kofi" target="_blank" rel="noopener" href="https://ko-fi.com/thisandthatspace">Support Fic Me Up</a>
      </div>`;
    const a = f.querySelector('.primary-btn');
    a.classList.add('not-work');
    a.href = ao3Link(work);
    a.textContent = onAo3 ? 'Leave kudos on AO3' : 'Find it on AO3';
    return f;
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

  // Positions save a moment after each sentence; anything still waiting is written
  // straight away when the story closes, the chapter changes or the app goes away.
  let saveTimer, pendingPosition = null;
  function savePosition(now = false) {
    if (!work) return;
    const ch = chapterOf(idx);
    pendingPosition = { id: work.id, chapter: ch, sentence: idx - (chapterStarts[ch] || 0), rate: settings.rate, updated: Date.now() };
    clearTimeout(saveTimer);
    if (now) flushPosition();
    else saveTimer = setTimeout(flushPosition, 400);
  }
  function flushPosition() {
    clearTimeout(saveTimer);
    if (!pendingPosition) return Promise.resolve();
    const p = pendingPosition;
    pendingPosition = null;
    return DB.putPosition(p);
  }
  addEventListener('pagehide', flushPosition);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPosition(); });

  function jump(i, forceScroll = false) {
    if (i < 0 || i >= sentences.length) return;
    idx = i;
    if (playing) { if (forceScroll) highlight(true); speakCurrent(); }
    else { highlight(forceScroll); savePosition(); }
  }

  // ---------- Speech ----------
  // Two kinds of voice: the device's built-in voices (speechSynthesis), and Piper and
  // Kokoro, open voice models that run in a worker and play through Web Audio.
  // The Web Audio route keeps playing when the phone is locked.

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

  // ---------- Which downloadable voices are already on this device ----------
  // Piper voices are found in the browser cache; Kokoro (one shared model) is remembered
  // after its first successful download.
  const DOWNLOAD_MB = { Kokoro: 310, Piper: 60 };
  const downloaded = new Set((() => {
    try { return JSON.parse(localStorage.getItem('fic-listener-downloaded') || '[]'); } catch { return []; }
  })());
  const downloadKey = uri => (uri.startsWith(KOKORO_PREFIX) ? 'kokoro-fp32' : uri);
  const isDownloaded = (uri = settings.voiceURI) => !downloadableChoice(uri) || downloaded.has(downloadKey(uri));
  function markDownloaded(uri) {
    downloaded.add(downloadKey(uri));
    try { localStorage.setItem('fic-listener-downloaded', JSON.stringify([...downloaded])); } catch {}
  }
  async function findCachedPiperVoices() {
    try {
      const keys = await (await caches.open('piper-voices-v1')).keys();
      for (const req of keys) {
        const m = req.url.match(/\/([^/]+)\.onnx$/);
        if (m) downloaded.add(PIPER_PREFIX + m[1]);
      }
    } catch {}
  }

  function voiceDisplayName(uri = settings.voiceURI) {
    const choice = downloadableChoice(uri);
    const list = uri.startsWith(KOKORO_PREFIX) ? KOKORO_VOICES : PIPER_VOICES;
    return list.find(([id]) => id === choice?.voice)?.[1] || 'This voice';
  }

  function updateDownloadPrompt() {
    const choice = downloadableChoice();
    const show = !!choice && !isDownloaded();
    els.downloadPrompt.hidden = !show;
    if (show) {
      els.downloadText.textContent = `${voiceDisplayName()} is a ${choice.engine.name} voice: a ${DOWNLOAD_MB[choice.engine.name]} MB download, once. Preview it first, or download it now.`;
      els.downloadBtn.textContent = `Download (${DOWNLOAD_MB[choice.engine.name]} MB)`;
      els.downloadBtn.disabled = false;
    }
  }

  // Kokoro gets stuck making its first sentence on iPhones and iPads, so it's only offered on computers.
  const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const kokoroOffered = !isAppleMobile;

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
      group('Piper: natural, keeps playing when locked (60 MB per voice)',
        PIPER_VOICES.map(([id, name, desc]) => new Option(`${name} · ${desc}`, PIPER_PREFIX + id))),
      ...(kokoroOffered ? [group('Kokoro: most natural, computers only (310 MB once)',
        KOKORO_VOICES.map(([id, name, desc]) => new Option(`${name} · ${desc}`, KOKORO_PREFIX + id)))] : []),
      ...(best.length ? [group('Best voices on this device', opts(best))] : []),
      ...(rest.length ? [group(best.length ? 'Other voices on this device' : 'Voices on this device', opts(rest))] : []),
      ...(others.length ? [group('Other languages', opts(others))] : []),
    );
    const choice = downloadableChoice();
    const known = choice
      ? [...(kokoroOffered ? KOKORO_VOICES : []), ...PIPER_VOICES].some(([id]) => id === choice.voice)
      : voices.some(v => v.voiceURI === settings.voiceURI);
    if (!known) settings.voiceURI = (mine[0] || voices[0])?.voiceURI || KOKORO_PREFIX + 'af_heart';
    els.voiceSelect.value = settings.voiceURI;
    updateSummary();
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
  // It's kept on the phone as well, so if iOS closes the app mid-story the log survives.
  const LOG_KEY = `${NS}fic-listener-debug-log`;
  const READING_KEY = `${NS}fic-listener-was-reading`;
  const debugLines = (() => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } })();
  function dbg(msg) {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    debugLines.push(`${t} ${msg}`);
    if (debugLines.length > 150) debugLines.shift();
    els.debugLog.textContent = debugLines.join('\n');
    try { localStorage.setItem(LOG_KEY, JSON.stringify(debugLines)); } catch {}
  }
  els.debugLog.textContent = debugLines.join('\n');
  // Still marked as reading from last time = the app was closed mid-story.
  let closedWhileReading = false;
  try { closedWhileReading = !!localStorage.getItem(READING_KEY); localStorage.removeItem(READING_KEY); } catch {}
  if (closedWhileReading) dbg('— the app was closed while reading (by the phone, or swiped away) and has started again —');
  dbg(`Fic Me Up ${(document.body.innerHTML.match(/Version (\d+)/) || [])[0] || ''} started${IS_BETA ? ' (beta)' : ''}`);
  const markReading = on => { try { on ? localStorage.setItem(READING_KEY, '1') : localStorage.removeItem(READING_KEY); } catch {} };

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
        // Only slow ones, so the log keeps room for what matters; the 30 s note shows progress.
        if (data.ms > data.seconds * 1000 * 0.6) dbg(`${name}: made ${data.seconds.toFixed(1)}s of speech in ${(data.ms / 1000).toFixed(1)}s (slow)`);
        if (!slowWarned && data.seconds > 1.5 && data.ms > data.seconds * 1000 * 1.1 && nextId > 3) {
          slowWarned = true;
          setPlayerStatus(`${name} is slower than speech on this device, so expect pauses.${hint}`, 10000);
        }
        p.resolve({ pcm: data.pcm, rate: data.rate });
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

    function generate(text, voice, speed = 1) {
      const run = async () => {
        await load(voice);
        return request({ type: 'generate', text, voice, speed }, GENERATE_MS, false).catch(err => {
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
    workerUrl: 'kokoro-worker.js?v=41',
    // On the CPU Kokoro is slower than speech, so it's only offered with WebGPU.
    requirement: () => navigator.gpu ? null : 'Kokoro needs a newer browser (Safari on iOS 26 or macOS 26, or Chrome). Piper voices work here.',
    hint: ' Piper voices work on more devices.',
  });
  const PiperEngine = makeEngine({ name: 'Piper', workerUrl: 'piper-worker.js?v=47' });

  const audio = new Audio();
  audio.setAttribute('playsinline', '');
  audio.preload = 'auto';

  // A Home Screen app on a locked iPhone can keep audio playing, but can't load or
  // start anything new. So from the tap on play, the <audio> element loops a moment
  // of silence the whole time (holding the phone's audio session open), and the voice
  // plays through Web Audio, which mixes in sound without loading anything.
  // 30 seconds long: the loop plays the whole time, and a short clip would make the
  // phone restart it many times a second, which keeps it busy and warm.
  const SILENCE = (() => {
    const rate = 8000, n = rate * 30, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  })();
  function unlockAudio() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    keepAudioAlive();
    // iOS sometimes stops a page's sound for good while still calling it "running" (its
    // clock stops). A tap is the one time a fresh one is sure to start, so make one then.
    if (!playing && (!ctx || clockStopped || ctx.state === 'closed' || ctx.state === 'interrupted')) newAudioContext();
    const c = audioContext();
    if (c && c.state !== 'running') c.resume().catch(err => dbg(`sound couldn’t start: ${err.name}`));
  }

  let ctx = null;          // Web Audio, made during the first tap on play
  let source = null;       // the stretch playing now
  let followTimer = null;
  let clockStopped = false, lastClock = -1;
  function newAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    stopSource();
    if (ctx) { const old = ctx; old.onstatechange = null; old.close().catch(() => {}); }
    const c = new AC();
    c.onstatechange = () => dbg(`sound ${c.state}`);
    ctx = c;
    clockStopped = false; lastClock = -1;
    dbg(`new sound engine (${c.state})`);
    return c;
  }
  const audioContext = () => ctx || newAudioContext();
  // Is the sound's clock still moving? Checked every 2 seconds, playing or not.
  setInterval(() => {
    if (!ctx || ctx.state !== 'running') { lastClock = -1; return; }
    const t = ctx.currentTime;
    const stopped = lastClock >= 0 && t === lastClock;
    if (stopped && !clockStopped) dbg(`sound clock stopped at ${t.toFixed(1)}s`);
    clockStopped = stopped;
    lastClock = t;
  }, 2000);
  function stopSource() {
    clearInterval(followTimer);
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch {}
    source.disconnect();
    source = null;
  }

  // ---------- Buffering ----------
  // Sentences are made one at a time, ahead of the one being read. The buffer fills
  // quickly to about 2 minutes, then carries on gently up to about 10, resting between
  // sentences, locked or not. iOS closes a background app that keeps the processor
  // busy for minutes on end, and resting also keeps the phone cool.
  const FAST_AHEAD_S = 120;      // fill this much as fast as possible
  const MAX_AHEAD_S = 600;       // then keep going, gently, up to this
  const REST_MS = 350;           // shortest pause between sentences once past the fast part
  const REST_RATIO = 1.5;        // rest 1.5x as long as the last sentence took to make
  const MAX_AHEAD_SENTENCES = 400;
  const audioCache = new Map();  // `${voice}|${index}` -> { promise, data: { pcm, rate } }
  let generating = false, restTimer = null;
  let generationWaiters = [];

  function clearAudioCache() {
    audioCache.clear();
    clearTimeout(restTimer);
  }

  function pruneAudioCache() {
    for (const key of audioCache.keys()) {
      const i = Number(key.split('|')[1]);
      if (i < idx - 2 || i > idx + MAX_AHEAD_SENTENCES + 20) audioCache.delete(key);
    }
  }

  const clipSeconds = d => d.pcm.length / d.rate;

  // Seconds of speech already made, counting forward from the sentence being read.
  function secondsAhead() {
    let total = 0;
    for (let i = idx; i < sentences.length && i < idx + MAX_AHEAD_SENTENCES; i++) {
      if (!speakable(sentences[i].text)) continue;
      const d = audioCache.get(`${settings.voiceURI}|${i}`)?.data;
      if (!d) break;
      total += clipSeconds(d);
    }
    return total;
  }

  function pumpGeneration() {
    const choice = downloadableChoice();
    if (generating || restTimer || !choice || !work) return;
    const ahead = secondsAhead();
    if (ahead >= MAX_AHEAD_S) return;
    const voice = settings.voiceURI;
    for (let i = idx; i < Math.min(sentences.length, idx + MAX_AHEAD_SENTENCES); i++) {
      if (!speakable(sentences[i].text)) continue;
      const key = `${voice}|${i}`;
      if (audioCache.has(key)) continue;
      generating = true;
      const entry = {}, started = performance.now();
      // Made at the reading speed, so speeding up doesn't raise the voice's pitch.
      entry.promise = choice.engine.generate(Pron.apply(sentences[i].text), choice.voice, settings.rate).then(d => (entry.data = d));
      audioCache.set(key, entry);
      entry.promise
        .catch(err => { if (audioCache.get(key) === entry) audioCache.delete(key); entry.error = err; })
        .finally(() => {
          generating = false;
          const waiters = generationWaiters;
          generationWaiters = [];
          waiters.forEach(w => w(entry.error));
          // Past the fast part, rest between sentences.
          if (secondsAhead() > FAST_AHEAD_S) {
            const rest = Math.max(REST_MS, (performance.now() - started) * REST_RATIO);
            restTimer = setTimeout(() => { restTimer = null; pumpGeneration(); }, rest);
          } else {
            pumpGeneration();
          }
        });
      return;
    }
  }
  async function audioFor(i) {
    const key = `${settings.voiceURI}|${i}`;
    while (!audioCache.has(key)) {
      clearTimeout(restTimer); restTimer = null;   // the one being waited for comes first
      pumpGeneration();
      if (audioCache.has(key)) break;
      const err = await new Promise(r => generationWaiters.push(r));
      if (err) throw err;
    }
    return audioCache.get(key).promise;
  }

  // ---------- Stitched playback ----------
  // Sentences that are ready are joined into one stretch of up to a minute, with short
  // pauses between them, and played through Web Audio (see unlockAudio). The speech is
  // made at the reading speed, so the pauses are shortened to match.
  const PAUSE = { sentence: 0.16, paragraph: 0.42, heading: 0.6, sceneBreak: 0.8 };
  const MAX_STRETCH_S = 60, MAX_STRETCH_SENTENCES = 40;
  let stretch = null;          // { my, map: [{ i, start, end }], last, seconds, startAt }

  function pauseAfter(i) {
    const cur = sentences[i], next = sentences[i + 1];
    if (!next) return 0;
    if (cur.el.parentElement.tagName === 'H2') return PAUSE.heading;
    if (cur.el.parentElement !== next.el.parentElement) return PAUSE.paragraph;
    return PAUSE.sentence;
  }

  // Used by the pronunciation Test button, which plays through the <audio> element.
  function wavFromParts(parts, rate) {
    const length = parts.reduce((n, p) => n + p.length, 0);
    const buf = new ArrayBuffer(44 + length * 2);
    const v = new DataView(buf);
    const str = (o, t) => { for (let k = 0; k < t.length; k++) v.setUint8(o + k, t.charCodeAt(k)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + length * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, length * 2, true);
    const out = new Int16Array(buf, 44);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // Joins the ready sentences from idx onwards. Waits only for the first one.
  async function buildStretch() {
    let first = idx;
    while (first < sentences.length && !speakable(sentences[first].text)) first++;
    if (first >= sentences.length) return null;
    await audioFor(first);
    const parts = [], map = [];
    let t = 0, rate = 0, last = idx;
    const silence = s => new Int16Array(Math.round(s * rate));
    const sceneBreak = PAUSE.sceneBreak / settings.rate;
    for (let i = idx; i < sentences.length; i++) {
      if (i > idx && (t >= MAX_STRETCH_S || i - idx >= MAX_STRETCH_SENTENCES)) break;
      if (i > idx && sleep.mode === 'chapter' && chapterOf(i) !== chapterOf(idx)) break;
      const sent = sentences[i];
      if (!speakable(sent.text)) {
        if (!rate) { map.push({ i, start: t, end: t }); last = i; continue; }
        parts.push(silence(sceneBreak));
        map.push({ i, start: t, end: t + sceneBreak });
        t += sceneBreak; last = i;
        continue;
      }
      const d = audioCache.get(`${settings.voiceURI}|${i}`)?.data;
      if (!d || (rate && d.rate !== rate)) break;
      rate = d.rate;
      const len = clipSeconds(d);
      parts.push(d.pcm);
      map.push({ i, start: t, end: t + len });
      t += len; last = i;
      const gap = pauseAfter(i) / settings.rate;
      if (gap) { parts.push(silence(gap)); t += gap; }
    }
    if (!rate) return null;
    const c = audioContext();
    if (!c) throw new Error('This browser can’t play the downloaded voices. Pick a built-in voice.');
    const buffer = c.createBuffer(1, parts.reduce((n, p) => n + p.length, 0), rate);
    const out = buffer.getChannelData(0);
    let o = 0;
    for (const p of parts) { for (let k = 0; k < p.length; k++) out[o + k] = p[k] / 32768; o += p.length; }
    return { buffer, map, last, seconds: t };
  }

  async function speakDownloaded(my) {
    stopSource();
    keepAudioAlive();
    const key = `${settings.voiceURI}|${idx}`;
    if (!audioCache.get(key)?.data) {
      dbg(`waiting for sentence ${idx + 1} to be made`);
      if (!/Downloading|Starting/.test(els.playerStatus.textContent)) setPlayerStatus('Preparing voice…');
    }
    let built;
    try {
      built = await buildStretch();
    } catch (err) {
      if (my !== token) return;
      stop();
      dbg(`could not make audio: ${err.message}`);
      return setPlayerStatus(err.message);
    }
    if (my !== token || !playing) return;
    if (!built) { idx = sentences.length - 1; return advance(); }
    const c = audioContext();
    if (c.state !== 'running') c.resume().catch(() => {});
    const src = c.createBufferSource();
    src.buffer = built.buffer;
    src.connect(c.destination);
    const startAt = c.currentTime + 0.05;
    stretch = { my, ...built, startAt };
    source = src;
    dbg(`playing ${built.map.length} sentences as one ${built.seconds.toFixed(0)}s stretch (sound ${c.state})`);
    src.onended = () => {
      if (source !== src) return;
      source = null;
      clearInterval(followTimer);
      if (my !== token || !playing) return;
      dbg(`stretch done (through sentence ${built.last + 1})`);
      idx = built.last;
      advance();
    };
    src.start(startAt);
    // Follow along: move the highlight as each sentence in the stretch comes up.
    followTimer = setInterval(() => follow(my), 200);
    if (/Preparing voice|ready\.|Waiting for the voice/.test(els.playerStatus.textContent)) setPlayerStatus('');
    // If the sound hasn't started within a few seconds, say so instead of sitting silently.
    setTimeout(() => {
      if (my !== token || !playing || c.state === 'running') return;
      dbg(`sound did not start: ${playbackState()}`);
      setPlayerStatus('The audio didn’t start. Tap play again; if it keeps happening, tap here for details.');
    }, 6000);
    pruneAudioCache();
    pumpGeneration();
  }

  function follow(my) {
    if (my !== token || !playing || !stretch || !ctx) return;
    const now = ctx.currentTime - stretch.startAt;
    const at = stretch.map.find(m => now >= m.start && now < m.end + 0.05) || null;
    if (!at || at.i === idx) return;
    if (sleep.mode === 'time' && Date.now() >= sleep.endsAt) return goToSleep(at.i);
    idx = at.i;
    highlight();
    savePosition();
    pruneAudioCache();
    pumpGeneration();
  }

  // Stall guard: if the voice goes quiet while the player still says it's playing,
  // either with a stretch frozen or while waiting for the next sentence to be made,
  // notice it. Every 2 seconds, check speech is actually moving. A frozen stretch
  // starts again from the current sentence; a long wait is shown, with details.
  let lastTime = -1, stuckSince = 0, heardAt = 0, quietReported = 0, recoveries = 0, loopWarned = false, lastBeat = 0;
  function playbackState() {
    const e = audioCache.get(`${settings.voiceURI}|${idx}`);
    const made = !e ? 'not started' : e.data ? 'ready' : 'being made';
    return `sentence ${idx + 1} ${made}; making ${generating}, resting ${!!restTimer}, ` +
      `speaking ${!!source}, sound ${ctx?.state ?? 'none'} at ${(ctx?.currentTime ?? 0).toFixed(1)}s, ` +
      `silence loop ${audio.paused ? 'paused' : 'playing'}, screen ${document.visibilityState}`;
  }
  setInterval(() => {
    if (!playing || !isDownloadable()) { stuckSince = heardAt = quietReported = lastBeat = 0; loopWarned = false; return; }
    const now = Date.now();
    if (!heardAt) heardAt = now;
    if (now - lastBeat >= 30000) {   // a regular note, so the log shows when and how things stopped
      lastBeat = now;
      dbg(`reading: ${playbackState()}; ${secondsAhead().toFixed(0)}s made ahead`);
    }
    if (audio.paused && !loopWarned) {
      loopWarned = true;
      dbg(`silence loop stopped: ${playbackState()}`);
      keepAudioAlive();
    } else if (!audio.paused) loopWarned = false;
    const t = ctx?.currentTime ?? 0;
    const speaking = !!source && stretch?.my === token;
    if (speaking && ctx.state === 'running' && t !== lastTime) {
      lastTime = t;
      heardAt = now; stuckSince = 0; quietReported = 0;
      if (t - stretch.startAt > 5) recoveries = 0;
      return;
    }
    lastTime = t;
    if (speaking) {
      if (!stuckSince) { stuckSince = now; return; }
      if (now - stuckSince < 4000) return;
      stuckSince = 0;
      dbg(`sound stuck: ${playbackState()}`);
      if (++recoveries > 3) {
        stop();
        return setPlayerStatus('The sound stopped. Tap play to carry on (a tap starts it afresh), or tap here for details.');
      }
      dbg(`restarting from sentence ${idx + 1} (try ${recoveries})`);
      setPlayerStatus('The audio stopped, so it’s starting again from this sentence. Tap here for details.');
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      else newAudioContext().resume().catch(() => {});   // stopped clock, or interrupted: start afresh
      return speakCurrent();
    }
    // Not speaking: waiting for the next sentence to be made.
    stuckSince = 0;
    if (/Downloading|Starting/.test(els.playerStatus.textContent)) return;
    if (now - heardAt > 12000 && now - quietReported > 15000) {
      quietReported = now;
      dbg(`quiet for ${Math.round((now - heardAt) / 1000)}s: ${playbackState()}`);
      setPlayerStatus('Waiting for the voice to make the next part… tap here for details.');
    }
  }, 2000);

  audio.addEventListener('pause', () => { if (playing && isDownloadable()) dbg('silence loop paused by the system'); });
  audio.addEventListener('error', () => dbg(`audio error code ${audio.error?.code}: ${audio.error?.message || ''}`));
  audio.addEventListener('stalled', () => dbg('audio stalled'));

  function speakDevice(my, text) {
    const u = new SpeechSynthesisUtterance(Pron.apply(text));
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

  // keepLoop leaves the silence playing, so a queue can carry on with the phone locked.
  function silenceAll(keepLoop = false) {
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    stopSource();
    if (keepLoop) return;
    audio.onended = null;
    audio.loop = false;
    audio.pause();
  }

  // iOS ends a web page's audio session (and soon suspends the page) once its audio
  // stops, and a Home Screen app can't start it again while locked. So while a
  // downloaded voice is reading, the element loops a moment of silence throughout.
  function keepAudioAlive() {
    if (audio.loop && !audio.paused) return;
    audio.onended = null;
    audio.loop = true;
    if (audio.src !== SILENCE) audio.src = SILENCE;
    audio.play().then(() => dbg('silence loop playing'), err => { if (err.name !== 'AbortError') dbg(`silence loop refused: ${err.name}`); });
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
    if (downloaded) return speakDownloaded(my);   // stretches handle scene breaks themselves
    if (!speakable(s.text)) {           // scene breaks like "* * *": short pause, no speech
      setTimeout(() => { if (my === token && playing) advance(); }, 400);
      return;
    }
    speakDevice(my, s.text);
  }

  // ---------- Sleep timer ----------
  // Checked between sentences, so it never cuts one off mid-way.
  let sleep = { mode: 'off', endsAt: 0 };

  function updateSleepLabel() {
    if (sleep.mode === 'time') {
      const mins = Math.max(0, Math.ceil((sleep.endsAt - Date.now()) / 60000));
      els.sleepLeft.textContent = `· ${mins} min left`;
    } else {
      els.sleepLeft.textContent = sleep.mode === 'chapter' ? '· end of chapter' : '';
    }
    updateSummary();
  }
  setInterval(updateSleepLabel, 15000);

  // Buttons rather than a dropdown: the dropdown didn't respond on some iPhones.
  function setSleepChips(v) {
    els.sleepChips.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sleep === v)));
  }
  els.sleepChips.addEventListener('click', e => {
    const b = e.target.closest('button[data-sleep]');
    if (!b) return;
    const v = b.dataset.sleep;
    sleep = v === 'off' ? { mode: 'off' }
      : v === 'chapter' ? { mode: 'chapter' }
      : { mode: 'time', endsAt: Date.now() + Number(v) * 60000 };
    setSleepChips(v);
    updateSleepLabel();
    // a chapter stretch may run past the chapter end; rebuild it so it stops there
    if (playing && isDownloadable() && v === 'chapter') speakCurrent();
    setPlayerStatus(v === 'off' ? 'Sleep timer off.'
      : v === 'chapter' ? 'Sleep timer: stops at the end of this chapter.'
      : `Sleep timer: stops in ${v} minutes, at the end of a sentence.`, 4000);
  });

  function sleepNow(nextIdx) {
    if (sleep.mode === 'time') return Date.now() >= sleep.endsAt;
    if (sleep.mode === 'chapter') return chapterOf(nextIdx) !== chapterOf(idx);
    return false;
  }

  function goToSleep(nextIdx) {
    if (sleep.mode === 'chapter') idx = nextIdx;   // resume at the start of the next chapter
    sleep = { mode: 'off' };
    setSleepChips('off');
    updateSleepLabel();
    stop();
    highlight();
    savePosition();
    setPlayerStatus('Sleep timer: paused. Press play to carry on.');
  }

  // ---------- Skipping by time ----------
  // Roughly 15 characters per second of speech at normal speed.
  const estimatedSeconds = i => (sentences[i]?.text.length || 0) / 15;

  function skipSeconds(delta) {
    let i = idx, total = 0;
    if (delta < 0) {
      while (i > 0 && total < -delta) { i--; total += estimatedSeconds(i); }
    } else {
      while (i < sentences.length - 1 && total < delta) { total += estimatedSeconds(i); i++; }
    }
    jump(i, true);
  }

  function advance() {
    if (idx < sentences.length - 1 && sleepNow(idx + 1)) return goToSleep(idx + 1);
    if (idx < sentences.length - 1) { idx++; speakCurrent(); return; }
    const wasDownloaded = isDownloadable();
    stop({ keepLoop: wasDownloaded });
    els.text.querySelector('.finish')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    playNextInQueue(wasDownloaded);
  }

  // ---------- The queue ----------
  // When a work ends, the next queued one opens and plays after a short pause, so a
  // queue runs without anyone touching the phone.
  let queueTimer = null;
  function cancelQueueCountdown() { clearTimeout(queueTimer); queueTimer = null; }

  async function playNextInQueue(keepAlive) {
    cancelQueueCountdown();
    const finished = work?.title;
    Lists.data.queue = Lists.data.queue.filter(id => id !== work?.id);
    Lists.save();
    const nextId = Lists.data.queue[0];
    const next = nextId && await DB.getWork(nextId);
    if (!next) { if (keepAlive) silenceAll(); return setPlayerStatus(`Finished “${finished}”.`); }
    if (keepAlive) keepAudioAlive();   // keeps a locked phone from ending the audio session
    setPlayerStatus(`Finished “${finished}”. Next: “${next.title}” in 8 seconds. `);
    const cancel = document.createElement('a');
    cancel.href = '#';
    cancel.textContent = 'Stay here';
    cancel.onclick = e => { e.preventDefault(); e.stopPropagation(); cancelQueueCountdown(); silenceAll(); setPlayerStatus(`Finished “${finished}”.`); };
    els.playerStatus.append(cancel);
    queueTimer = setTimeout(async () => {
      queueTimer = null;
      Lists.data.queue = Lists.data.queue.filter(id => id !== nextId);
      Lists.save();
      await openWork(nextId, { fromStart: true });
      play();
    }, 8000);
  }

  function play() {
    if (!sentences.length) return;
    if (sleep.mode === 'time' && Date.now() >= sleep.endsAt) {   // timer ran out while paused
      sleep = { mode: 'off' };
      setSleepChips('off');
      updateSleepLabel();
    }
    if (!isDownloaded()) {
      updateDownloadPrompt();
      return setPlayerStatus('Download this voice to start listening, or pick another one.');
    }
    if (isDownloadable()) unlockAudio();
    else if (!synth) return setPlayerStatus('This browser can’t use built-in voices. Pick a Piper voice.');
    playing = true;
    markReading(true);
    updatePlayButton();
    keepScreenOn(!isDownloadable());
    keptOpen = false;
    scheduleMini();
    if (!window.__trackedPlay) { window.__trackedPlay = true; track(isDownloadable() ? 'listened-downloaded-voice' : 'listened-builtin-voice'); }
    speakCurrent();
  }

  function stop({ keepLoop = false } = {}) {
    clearTimeout(miniTimer);
    setMini(false);
    playing = false;
    markReading(false);
    token++;
    silenceAll(keepLoop);
    updatePlayButton();
    keepScreenOn(false);
  }

  function updatePlayButton() {
    // SVG elements have no .hidden property in Safari, so set the attribute itself.
    els.playIcon.toggleAttribute('hidden', playing);
    els.pauseIcon.toggleAttribute('hidden', !playing);
    els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    document.body.classList.toggle('playing', playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !work) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: work.title,
        artist: work.author || 'Fic Me Up',
        album: 'Fic Me Up',
        artwork: [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
      });
    } catch {}
  }
  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => play(),
      pause: () => stop(),
      previoustrack: () => jump(idx - 1),
      nexttrack: () => jump(idx + 1),
      seekbackward: () => skipSeconds(-30),
      seekforward: () => skipSeconds(30),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
    }
  }

  async function preview() {
    const text = 'This is this voice, at the speed you have set.';
    if (playing) stop();
    const choice = downloadableChoice();
    if (choice) {
      // A short recorded sample, so a voice can be heard before downloading it.
      silenceAll();
      const prefix = choice.engine === KokoroEngine ? 'kokoro' : 'piper';
      audio.src = `samples/${prefix}-${choice.voice}.m4a`;
      audio.playbackRate = settings.rate;
      try { await audio.play(); }
      catch (err) { setPlayerStatus(`Couldn’t play the preview (${err.name}).`); }
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
  els.clipAdd.onclick = addFromClipboard;
  els.promptPreviewBtn.onclick = preview;
  els.downloadBtn.onclick = async () => {
    const choice = downloadableChoice();
    if (!choice) return;
    const uri = settings.voiceURI;
    unlockAudio();   // this tap lets the story start playing once the download finishes
    els.downloadBtn.disabled = true;
    els.downloadBtn.textContent = 'Downloading…';
    try {
      await choice.engine.load(choice.voice);
      markDownloaded(uri);
      updateDownloadPrompt();
      if (settings.voiceURI === uri && work && !playing) play();
    } catch (err) {
      setPlayerStatus(err.message);
      updateDownloadPrompt();
    }
  };
  els.back30Btn.onclick = () => skipSeconds(-30);
  els.fwd30Btn.onclick = () => skipSeconds(30);
  els.playerStatus.onclick = () => { els.debugLog.hidden = !els.debugLog.hidden; };
  els.chapterSelect.onchange = () => { jump(chapterStarts[Number(els.chapterSelect.value)], true); savePosition(true); };
  els.text.onclick = e => {
    const span = e.target.closest('.s');
    if (!span || window.getSelection()?.toString()) return;
    idx = Number(span.dataset.i);
    if (playing) speakCurrent(); else play();
  };

  // ---------- The one-line settings summary in the player ----------
  function updateSummary() {
    els.summaryRate.textContent = `${Number(settings.rate).toFixed(1)}×`;
    const opt = els.voiceSelect.selectedOptions?.[0];
    els.summaryVoice.textContent = opt ? opt.textContent.split(' · ')[0] : 'Voice';
    els.summarySleep.textContent = sleep.mode === 'off' ? 'Sleep off'
      : sleep.mode === 'chapter' ? 'Sleep: end of chapter'
      : `Sleep ${Math.max(0, Math.ceil((sleep.endsAt - Date.now()) / 60000))} min`;
  }
  // The player shrinks to one slim row 10 seconds after playback starts, and opens
  // again on a tap, on pause, or when something needs an answer.
  // The ⌄ / ⌃ button minimises or opens it by hand; opened by hand, it stays open
  // until the next time play is pressed.
  let miniTimer = null, keptOpen = false;
  function setMini(on) {
    els.player.classList.toggle('mini', on);
    els.playerToggle.setAttribute('aria-expanded', String(!on));
    els.playerToggle.setAttribute('aria-label', on ? 'Open player' : 'Minimise player');
    if (on) { els.settingsPanel.hidden = true; els.settingsToggle.setAttribute('aria-expanded', 'false'); }
  }
  function scheduleMini() {
    clearTimeout(miniTimer);
    if (keptOpen) return;
    miniTimer = setTimeout(() => {
      if (playing && !keptOpen && els.downloadPrompt.hidden && !els.player.matches(':focus-within')) setMini(true);
    }, 10000);
  }
  els.playerToggle.onclick = e => {
    e.stopPropagation();
    const mini = els.player.classList.contains('mini');
    keptOpen = mini;          // opening by hand keeps it open
    clearTimeout(miniTimer);
    setMini(!mini);
  };
  els.player.addEventListener('pointerdown', e => {
    if (e.target.closest('#playerToggle')) return;
    if (els.player.classList.contains('mini') && !e.target.closest('button')) { e.preventDefault(); keptOpen = false; setMini(false); }
    scheduleMini();
  });

  // Font for the story text. The extra ones load from Google Fonts only when chosen.
  const FONTS = {
    newsreader: { stack: "'Newsreader', 'Iowan Old Style', Georgia, serif" },
    literata: { stack: "'Literata', Georgia, serif", css: 'Literata:ital,opsz,wght@0,7..72,400;1,7..72,400' },
    atkinson: { stack: "'Atkinson Hyperlegible', system-ui, sans-serif", css: 'Atkinson+Hyperlegible:ital,wght@0,400;1,400' },
    system: { stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  };
  function applyFont() {
    const f = FONTS[settings.font] ? settings.font : 'newsreader';
    if (FONTS[f].css && !document.getElementById(`font-${f}`)) {
      const link = document.createElement('link');
      link.id = `font-${f}`;
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${FONTS[f].css}&display=swap`;
      document.head.append(link);
    }
    document.documentElement.style.setProperty('--story-font', FONTS[f].stack);
    els.fontSelect.value = f;
  }
  els.fontSelect.onchange = () => { settings.font = els.fontSelect.value; saveSettings(); applyFont(); };
  applyFont();

  // Text size, remembered across stories.
  const TEXT_SIZES = [15, 17, 19, 21, 24, 28, 32];
  function applyTextSize() {
    const size = TEXT_SIZES.includes(settings.textSize) ? settings.textSize : 19;
    document.documentElement.style.setProperty('--text-size', `${size}px`);
    els.textSizeValue.textContent = size;
    els.textSmaller.disabled = size === TEXT_SIZES[0];
    els.textLarger.disabled = size === TEXT_SIZES[TEXT_SIZES.length - 1];
  }
  const stepTextSize = d => {
    const i = TEXT_SIZES.indexOf(TEXT_SIZES.includes(settings.textSize) ? settings.textSize : 19);
    settings.textSize = TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, i + d))];
    saveSettings();
    applyTextSize();
    highlight(true);
  };
  els.textSmaller.onclick = () => stepTextSize(-1);
  els.textLarger.onclick = () => stepTextSize(1);
  applyTextSize();

  els.settingsToggle.onclick = () => {
    const open = els.settingsPanel.hidden;
    els.settingsPanel.hidden = !open;
    els.settingsToggle.setAttribute('aria-expanded', String(open));
  };
  // The chapter menu sticks just under the top bar while scrolling.
  try {
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--topbar-h', `${els.topbar.offsetHeight}px`);
    }).observe(els.topbar);
  } catch {}
  // Keep the story clear of the player, whatever height it currently is.
  try {
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--player-h', `${els.player.offsetHeight}px`);
    }).observe(els.player);
  } catch {}

  function setRate(rate) {
    settings.rate = Number(rate);
    els.rate.value = settings.rate;
    els.rateValue.textContent = `${settings.rate.toFixed(1)}×`;
    audio.playbackRate = settings.rate;   // voice samples follow the speed too
    saveSettings();
    updateSummary();
  }
  setRate(settings.rate);
  els.rate.oninput = () => { setRate(els.rate.value); savePosition(); };
  els.rate.onchange = () => {
    if (isDownloadable()) clearAudioCache();   // downloaded voices are made at the speed, so remake them
    if (playing) speakCurrent();
  };
  els.voiceSelect.onchange = () => {
    settings.voiceURI = els.voiceSelect.value;
    saveSettings();
    updateSummary();
    clearAudioCache();
    const choice = downloadableChoice();
    for (const engine of [KokoroEngine, PiperEngine]) if (engine !== choice?.engine) engine.unload();
    updateDownloadPrompt();
    if (!isDownloaded()) {   // ask first: preview, then download if they like it
      if (playing) stop();
      return;
    }
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

  // iOS can grey out EPUB files when a page restricts file types, so accept any
  // file there; unsupported ones get a clear message from the parser.
  if (isAppleMobile) els.fileInput.removeAttribute('accept');

  // ---------- Pronunciations ----------
  // Words the voice says wrong, respelled the way they sound. Applied to what the
  // voice is given, never to the text on screen. Two lists: a shared one (managed by
  // the app's owner, published at /data/pronunciations.json) and each person's own,
  // which wins when both have the same word.
  const Pron = (() => {
    const KEY = `${NS}fic-listener-pronunciations`;
    const SHARED_URL = '/data/pronunciations.json';
    let mine = [], shared = [], compiled = null;
    try { mine = JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch {}
    const valid = e => e && typeof e.from === 'string' && typeof e.to === 'string' && e.from.trim() && e.to.trim();
    const esc = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function changed() {
      compiled = null;
      clearAudioCache();              // sentences already made used the old sounds
      renderPronunciations();
    }
    function merged() {
      const m = new Map();
      for (const e of shared) m.set(e.from.toLowerCase(), e);
      for (const e of mine) m.set(e.from.toLowerCase(), e);
      return [...m.values()];
    }
    function compile() {
      const list = merged().sort((x, y) => y.from.length - x.from.length);   // longest first
      if (!list.length) return false;
      return {
        re: new RegExp(`(?<![\\p{L}\\p{N}])(${list.map(e => esc(e.from.trim())).join('|')})(?![\\p{L}\\p{N}])`, 'giu'),
        map: new Map(list.map(e => [e.from.trim().toLowerCase(), e.to.trim()])),
      };
    }
    function apply(text) {
      if (compiled === null) compiled = compile();
      if (!compiled) return text;
      return text.replace(compiled.re, w => compiled.map.get(w.toLowerCase()) ?? w);
    }
    function saveMine() { try { localStorage.setItem(KEY, JSON.stringify(mine)); } catch {} changed(); }
    async function loadShared() {
      try {
        const r = await fetch(`${SHARED_URL}?t=${Date.now()}`);
        if (r.ok) { shared = ((await r.json()).entries || []).filter(valid); changed(); }
      } catch {}
    }
    return {
      apply, loadShared,
      get mine() { return mine; }, get shared() { return shared; },
      setShared(list) { shared = list; changed(); },
      addMine(from, to) { mine = mine.filter(e => e.from.toLowerCase() !== from.toLowerCase()); mine.push({ from, to }); saveMine(); },
      removeMine(from) { mine = mine.filter(e => e.from !== from); saveMine(); },
    };
  })();

  // Owner mode: a GitHub token (write access to ficmeup/data only), kept on the
  // owner's device, lets the app publish the shared list.
  const ADMIN_KEY = 'fic-listener-admin-token';
  const adminToken = () => { try { return localStorage.getItem(ADMIN_KEY) || ''; } catch { return ''; } };
  const DATA_API = 'https://api.github.com/repos/ficmeup/data/contents/pronunciations.json';

  async function publishShared(list, what) {
    const headers = { Authorization: `Bearer ${adminToken()}`, Accept: 'application/vnd.github+json' };
    setStatus('Publishing the shared list…');
    try {
      const cur = await fetch(DATA_API, { headers });
      if (!cur.ok) throw new Error(`GitHub said ${cur.status}`);
      const { sha } = await cur.json();
      const body = JSON.stringify({
        version: 1,
        about: 'Shared pronunciations for Fic Me Up. Each entry: what’s written, and how to say it. Edited from the app’s admin mode.',
        entries: list,
      }, null, 2) + '\n';
      const bytes = new TextEncoder().encode(body);
      let bin = '';
      bytes.forEach(b => { bin += String.fromCharCode(b); });
      const who = { name: 'Fic Me Up', email: 'ficmeup@users.noreply.github.com' };
      const put = await fetch(DATA_API, {
        method: 'PUT', headers,
        body: JSON.stringify({ message: what, content: btoa(bin), sha, author: who, committer: who }),
      });
      if (!put.ok) throw new Error(`GitHub said ${put.status}`);
      Pron.setShared(list);
      setStatus('Published. Everyone gets it within about a minute.');
    } catch (err) {
      setStatus(`The shared list couldn’t be published (${err.message}). Nothing changed for anyone else.`);
    }
  }

  // Hears a respelling in the current voice.
  async function testSay(text) {
    if (!text.trim()) return;
    const choice = downloadableChoice();
    if (choice && isDownloaded()) {
      unlockAudio();
      try {
        const d = await choice.engine.generate(text, choice.voice);
        silenceAll();
        audio.src = URL.createObjectURL(wavFromParts([d.pcm], d.rate));
        audio.playbackRate = settings.rate;
        await audio.play();
      } catch (err) { setStatus(`Couldn’t play the test: ${err.message}`); }
    } else if (synth) {
      silenceAll();
      const u = new SpeechSynthesisUtterance(text);
      const v = currentVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = settings.rate;
      synth.speak(u);
    }
  }

  function renderPronunciations() {
    const admin = !!adminToken();
    const row = (e, removable, onRemove) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = e.from;
      label.append(b, ` → ${e.to}`);
      const test = document.createElement('button');
      test.type = 'button'; test.className = 'link-btn'; test.textContent = 'Test';
      test.onclick = () => testSay(e.to);
      li.append(label, test);
      if (removable) {
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'link-btn'; x.textContent = 'Remove';
        x.onclick = onRemove;
        li.append(x);
      }
      return li;
    };
    els.pronMine.replaceChildren(...Pron.mine.map(e => row(e, true, () => Pron.removeMine(e.from))));
    els.pronShared.replaceChildren(...Pron.shared.map(e => row(e, admin, () => {
      if (!confirm(`Remove “${e.from}” from the shared list, for everyone?`)) return;
      publishShared(Pron.shared.filter(x => x !== e), `Remove ${e.from}`);
    })));
    els.pronMineCount.textContent = Pron.mine.length ? `· ${Pron.mine.length}` : '· none yet';
    els.pronSharedCount.textContent = Pron.shared.length ? `· ${Pron.shared.length}` : '· none yet';
    // For now the pronunciation tools are the owner's alone; everyone else just hears the shared list.
    els.pronBox.hidden = !admin;
    els.pronTarget.hidden = !admin;
    if (admin) els.pronTarget.value = els.psTarget.value = 'shared';
    els.pronAdmin.textContent = admin ? 'Leave owner mode on this device' : 'I manage the shared list';
  }

  function addPronunciation(from, to, target) {
    from = from.trim(); to = to.trim();
    if (!from || !to) { setStatus('Fill in both: the word as written, and how to say it.'); return false; }
    if (adminToken() && target === 'shared') {
      const list = Pron.shared.filter(e => e.from.toLowerCase() !== from.toLowerCase()).concat({ from, to });
      publishShared(list, `Add ${from}`);
    } else {
      Pron.addMine(from, to);
      setStatus(`Added “${from}”. It applies from the next sentence made.`);
    }
    return true;
  }
  els.pronTest.onclick = () => testSay(els.pronTo.value || els.pronFrom.value);
  els.pronAdd.onclick = () => {
    if (addPronunciation(els.pronFrom.value, els.pronTo.value, els.pronTarget.value)) els.pronFrom.value = els.pronTo.value = '';
  };

  // Press and hold a word in a fic: a Pronounce button appears for the selection.
  let pronPick = '';
  document.addEventListener('selectionchange', () => {
    clearTimeout(pronPick.timer);
    const sel = window.getSelection();
    const text = (sel?.toString() || '').trim().replace(/\s+/g, ' ');
    const inFic = sel?.rangeCount && els.text.contains(sel.getRangeAt(0).commonAncestorContainer);
    const ok = inFic && text.length >= 2 && text.length <= 40 && text.split(' ').length <= 4 && /[\p{L}]/u.test(text);
    if (!ok || !adminToken()) { els.pronFab.hidden = true; return; }
    pronPick = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/[’']s$/i, '');
    els.pronFab.textContent = `Pronounce “${pronPick}”`;
    els.pronFab.hidden = false;
  });
  els.pronFab.onclick = () => {
    const known = [...Pron.mine, ...Pron.shared].find(e => e.from.toLowerCase() === pronPick.toLowerCase());
    els.psFrom.value = pronPick;
    els.psTo.value = known?.to || '';
    els.psTarget.hidden = !adminToken();
    els.pronFab.hidden = true;
    window.getSelection()?.removeAllRanges();
    els.pronSheet.showModal();
  };
  els.psHear.onclick = () => testSay(Pron.apply(els.psFrom.value));
  els.psTest.onclick = () => testSay(els.psTo.value || els.psFrom.value);
  els.psAdd.onclick = () => {
    if (addPronunciation(els.psFrom.value, els.psTo.value, els.psTarget.value)) {
      els.pronSheet.close();
      if (playing) speakCurrent();   // rebuild from here so the new sound is used straight away
    }
  };
  els.pronAdmin.onclick = e => { e.preventDefault(); ownerMode(); };
  async function ownerMode() {
    if (adminToken()) {
      if (confirm('Leave owner mode on this device? The token is forgotten here; the shared list stays as it is.')) {
        try { localStorage.removeItem(ADMIN_KEY); } catch {}
        renderPronunciations();
      }
      return;
    }
    const token = prompt('Owner mode: paste the GitHub token for the shared pronunciations.')?.trim();
    if (!token) return;
    try {
      const r = await fetch('https://api.github.com/repos/ficmeup/data', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
      const repo = r.ok ? await r.json() : null;
      if (!repo?.permissions?.push) throw new Error(r.ok ? 'this token can’t change the list' : `GitHub said ${r.status}`);
      localStorage.setItem(ADMIN_KEY, token);
      renderPronunciations();
      setStatus('Owner mode is on for this device. “Add to” now offers the shared list.');
    } catch (err) {
      setStatus(`That token didn’t work: ${err.message}.`);
    }
  }
  // The owner turns owner mode on by opening the app with #owner at the end of the address.
  if (location.hash === '#owner') {
    history.replaceState(null, '', location.pathname + location.search);
    if (!adminToken()) setTimeout(ownerMode, 300);
  }
  renderPronunciations();
  Pron.loadShared();

  loadVoices();
  findCachedPiperVoices().then(updateDownloadPrompt);
  if (synth) {
    synth.addEventListener?.('voiceschanged', loadVoices);
    // Safari sometimes loads voices late without firing the event.
    let tries = 0;
    const poll = setInterval(() => { if (voices.length || ++tries > 20) clearInterval(poll); else loadVoices(); }, 250);
  }

  renderBookmarkletHelp();
  renderLibrary();
  listenForImport();
  receivePlaylist();
  DB.persistent().then(ok => {
    if (!ok) setStatus('This browser is in private mode, so your library won’t be saved after you close the tab.');
  });
})();
