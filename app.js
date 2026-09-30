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
    fileInput: $('#fileInput'), pasteTitle: $('#pasteTitle'), pasteText: $('#pasteText'), pasteAdd: $('#pasteAdd'),
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
    playerToggle: $('#playerToggle'), ao3Link: $('#ao3Link'),
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

  // ---------- Rooms (dark / paper) ----------
  // The page follows the device until someone picks a room; then their pick wins.
  const roomButtons = document.querySelectorAll('.roomtog button');
  let roomChosen = window.__roomStored;
  function applyRoom(room) {
    document.documentElement.setAttribute('data-room', room);
    roomButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.room === room)));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', room === 'paper' ? '#D8D8D3' : '#050505');
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
    const text = `“${pl.name}”: ${items.length} ${items.length === 1 ? 'work' : 'works'} from AO3, as a Fic Me Up playlist.`;
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
    if (!confirm(`Add the shared playlist “${data.n}”? ${items.length} works; ${have} already in your library. The others link to AO3 so you can add them.`)) return;
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
    const text = `${w.title}${w.author ? ` by ${w.author}` : ''}${isAo3(w) ? ', on AO3' : ''}`;
    try {
      if (navigator.share) { await navigator.share({ title: w.title, text, url }); return; }
    } catch (err) { if (err.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); setStatus(`AO3 link for “${w.title}” copied.`); }
    catch { prompt('Copy the AO3 link:', url); }
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
    if (isAo3(w)) add(w.sourceUrl ? 'Open on AO3' : 'Find on AO3', () => window.open(ao3Link(w), '_blank', 'noopener'));
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
    meta.textContent = [String(i + 1).padStart(2, '0'), w.author, 'Not in your library · add it from AO3'].filter(Boolean).join(' · ');
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
    els.emptyLibrary.textContent = libView === 'notes' ? 'No notes yet.'
      : libView === 'queue' ? 'The queue is empty. Use ⋯ on a story to add it.'
      : libView.startsWith('pl:') ? 'This playlist is empty. Use ⋯ on a story to add it.'
      : 'No stories yet. Open a file from AO3 above.';
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


  // The Listen bookmark. It runs in the reader's own AO3 tab and reads the page already
  // on screen; it never contacts AO3. On iPhone and iPad it offers a second route,
  // copying the story, because a Home Screen app has its own storage, separate from
  // Safari's, and a link from Safari always opens in Safari.
  const CLIP_PREFIX = 'FICMEUP1:';
  function bookmarkletCode() {
    const app = location.origin + location.pathname;
    const src = `(()=>{const A=${JSON.stringify(app)},O=${JSON.stringify(location.origin)},P=${JSON.stringify(CLIP_PREFIX)};`
      + `const r=document.querySelector('#workskin');`
      + `if(r&&document.querySelector('a[href*="view_full_work=true"]')&&!confirm('Only this chapter is on screen. OK: listen to this chapter only. Cancel: tap Entire Work first, then Listen again.'))return;`
      + `const m=document.querySelector('dl.work.meta');`
      + `const d={type:'fic-listener-import',html:r?(m?m.outerHTML:'')+r.outerHTML:document.documentElement.outerHTML,url:location.href.split('#')[0]};`
      + `const go=()=>{const w=window.open(A+'#import','_blank');if(!w){alert('Allow pop-ups for AO3, then tap Listen again.');return}`
      + `const h=e=>{if(e.source===w&&e.data==='fic-listener-ready'){w.postMessage(d,O);removeEventListener('message',h)}};addEventListener('message',h)};`
      + `const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&/Mac/.test(navigator.platform));`
      + `if(!ios)return go();`
      + `document.getElementById('ficmeup-box')?.remove();`
      + `const b=document.createElement('div');b.id='ficmeup-box';`
      + `b.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#050505;color:#EFEFF1;padding:16px;display:grid;gap:10px;font:15px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5)';`
      + `const t=document.createElement('div');t.textContent='Fic Me Up';t.style.cssText='font:11px ui-monospace,Menlo,monospace;letter-spacing:.15em;text-transform:uppercase;color:#8C8C95';b.append(t);`
      + `const mk=(label,fill)=>{const x=document.createElement('button');x.textContent=label;x.style.cssText='font:12px ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;padding:13px;border:1px solid #EFEFF1;border-radius:0;'+(fill?'background:#EFEFF1;color:#050505':'background:#050505;color:#EFEFF1');b.append(x);return x};`
      + `const b1=mk('Open in Safari',true),b2=mk('Copy for the Home Screen app',false),b3=mk('Cancel',false);`
      + `b1.onclick=()=>{b.remove();go()};b3.onclick=()=>b.remove();`
      + `b2.onclick=async()=>{try{await navigator.clipboard.writeText(P+JSON.stringify({html:d.html,url:d.url}));b2.textContent='Copied. In the app, tap Paste';b2.disabled=true;setTimeout(()=>b.remove(),6000)}catch(e){alert('Copying didn’t work: '+e.message)}};`
      + `document.body.append(b)})()`;
    return 'javascript:' + encodeURIComponent(src);
  }

  // Paste: reads what the Shortcuts or the Listen bookmark copied.
  //   FICMEUP1:{html,url}      a web page (an AO3 work or any other page)
  //   FICMEUPF1:name:base64    a file shared from another app (EPUB, PDF, Word…)
  //   anything else long        plain text, added as a story
  const FILE_PREFIX = 'FICMEUPF1:';
  async function addFromClipboard() {
    // read() shows what kind of thing was copied; websites only get text and images,
    // so a copied file (a book from Books, a PDF from Files) arrives as nothing.
    let text = '', html = '', kinds = [];
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        kinds = items.flatMap(i => [...i.types]);
        const item = items.find(i => i.types.includes('text/plain')) || items.find(i => i.types.includes('text/html'));
        if (item) {
          const type = item.types.includes('text/plain') ? 'text/plain' : 'text/html';
          const raw = await (await item.getType(type)).text();
          if (type === 'text/plain') text = raw; else html = raw;
        }
      } else {
        text = await navigator.clipboard.readText();
      }
    } catch {
      return setStatus('The clipboard couldn’t be read. When your phone shows a Paste button, tap it.');
    }
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
      <p class="hint">A bookmark that reads the AO3 page already open in your browser and sends the text here. It makes no requests to AO3 of its own.</p>
      <p><b>Computer.</b> Drag this onto your bookmarks bar:</p>
      <p><a class="bookmarklet" id="bmLink">Listen</a></p>
      <p><b>iPhone or iPad, Safari.</b> Set it up once:</p>
      <ol>
        <li><button class="secondary-btn" id="bmCopy">Copy the Listen code</button></li>
        <li>Share → <b>Add Bookmark</b>. Name it <b>Listen</b>, folder <b>Favorites</b>, <b>Save</b>.</li>
        <li>Bookmarks → <b>Favorites</b> → <b>Edit</b> → <b>Listen</b>. Replace the address with the code. <b>Done</b>.</li>
      </ol>
      <p><b>On AO3.</b> Open a work, tap <b>Entire Work</b> if it has chapters, tap the address bar, then <b>Listen</b> in Favorites. Choose <b>Open in Safari</b>, or, if you use Fic Me Up from your Home Screen, <b>Copy for the Home Screen app</b>; then open the app and tap <b>Paste</b>. It works on other websites too.</p>`;
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
    } else {
      els.ao3Link.hidden = !work.sourceUrl;
      els.ao3Link.href = work.sourceUrl || '#';
      els.ao3Link.textContent = 'Source ↗';
    }
    els.backBtn.hidden = false;
    els.libraryView.hidden = true;
    els.readerView.hidden = false;
    els.player.hidden = false;
    highlight(true);
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
      k.className = 'secondary-btn'; k.target = '_blank'; k.rel = 'noopener';
      k.href = 'https://ko-fi.com/thisandthatspace'; k.textContent = 'Support Fic Me Up';
      f.querySelector('.cta').append(k);
      return f;
    }
    const onAo3 = !!work.sourceUrl;
    f.innerHTML = `
      <p class="mono">End of work</p>
      <p>The writer sees kudos and comments on AO3, and nothing from this app.</p>
      <div class="cta">
        <a class="primary-btn" target="_blank" rel="noopener"></a>
        <a class="secondary-btn" target="_blank" rel="noopener" href="https://ko-fi.com/thisandthatspace">Support Fic Me Up</a>
      </div>`;
    const a = f.querySelector('.primary-btn');
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
    workerUrl: 'kokoro-worker.js?v=25',
    // On the CPU Kokoro is slower than speech, so it's only offered with WebGPU.
    requirement: () => navigator.gpu ? null : 'Kokoro needs a newer browser (Safari on iOS 26 or macOS 26, or Chrome). Piper voices work here.',
    hint: ' Piper voices work on more devices.',
  });
  const PiperEngine = makeEngine({ name: 'Piper', workerUrl: 'piper-worker.js?v=25' });

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

  // ---------- Buffering ----------
  // Sentences are made one at a time, ahead of the one being read. The buffer fills
  // quickly to about 2 minutes, then carries on in gentle bursts up to about 10, so a
  // locked phone (where iOS may pause this work) still has plenty to play, and the
  // phone isn't running flat out the whole time it's in your hand.
  const FAST_AHEAD_S = 120;      // fill this much as fast as possible
  const MAX_AHEAD_S = 600;       // then keep going, gently, up to this
  const REST_MS = 350;           // pause between sentences once past the fast part
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
      const entry = {};
      entry.promise = choice.engine.generate(sentences[i].text, choice.voice).then(d => (entry.data = d));
      audioCache.set(key, entry);
      entry.promise
        .catch(err => { audioCache.delete(key); entry.error = err; })
        .finally(() => {
          generating = false;
          const waiters = generationWaiters;
          generationWaiters = [];
          waiters.forEach(w => w(entry.error));
          // Past the fast part, rest between sentences while the screen is on.
          if (document.visibilityState === 'visible' && secondsAhead() > FAST_AHEAD_S) {
            restTimer = setTimeout(() => { restTimer = null; pumpGeneration(); }, REST_MS);
          } else {
            pumpGeneration();
          }
        });
      return;
    }
  }
  document.addEventListener('visibilitychange', () => {
    // Hidden or locked: skip the rests and make as much as iOS allows.
    if (document.visibilityState === 'hidden' && restTimer) { clearTimeout(restTimer); restTimer = null; pumpGeneration(); }
  });

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
  // pauses between them. The phone then starts a new clip about once a minute rather
  // than every sentence, which removes the gaps and keeps a locked phone playing.
  // The pauses are part of the audio, so they speed up with the playback speed.
  const PAUSE = { sentence: 0.16, paragraph: 0.42, heading: 0.6, sceneBreak: 0.8 };
  const MAX_STRETCH_S = 60, MAX_STRETCH_SENTENCES = 40;
  let stretch = null;          // { my, map: [{ i, start, end }], last, url }

  function pauseAfter(i) {
    const cur = sentences[i], next = sentences[i + 1];
    if (!next) return 0;
    if (cur.el.parentElement.tagName === 'H2') return PAUSE.heading;
    if (cur.el.parentElement !== next.el.parentElement) return PAUSE.paragraph;
    return PAUSE.sentence;
  }

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
    for (let i = idx; i < sentences.length; i++) {
      if (i > idx && (t >= MAX_STRETCH_S || i - idx >= MAX_STRETCH_SENTENCES)) break;
      if (i > idx && sleep.mode === 'chapter' && chapterOf(i) !== chapterOf(idx)) break;
      const sent = sentences[i];
      if (!speakable(sent.text)) {
        if (!rate) { map.push({ i, start: t, end: t }); last = i; continue; }
        parts.push(silence(PAUSE.sceneBreak));
        map.push({ i, start: t, end: t + PAUSE.sceneBreak });
        t += PAUSE.sceneBreak; last = i;
        continue;
      }
      const d = audioCache.get(`${settings.voiceURI}|${i}`)?.data;
      if (!d || (rate && d.rate !== rate)) break;
      rate = d.rate;
      const len = clipSeconds(d);
      parts.push(d.pcm);
      map.push({ i, start: t, end: t + len });
      t += len; last = i;
      const gap = pauseAfter(i);
      if (gap) { parts.push(silence(gap)); t += gap; }
    }
    if (!rate) return null;
    return { url: URL.createObjectURL(wavFromParts(parts, rate)), map, last, seconds: t };
  }

  async function speakDownloaded(my) {
    const key = `${settings.voiceURI}|${idx}`;
    if (!audioCache.get(key)?.data) {
      keepAudioAlive();
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
    if (my !== token || !playing) { if (built) URL.revokeObjectURL(built.url); return; }
    if (!built) { idx = sentences.length - 1; return advance(); }
    const previous = stretch;
    stretch = { my, ...built };
    dbg(`playing ${built.map.length} sentences as one ${built.seconds.toFixed(0)}s stretch`);

    // Follow along: move the highlight as each sentence in the stretch comes up.
    audio.ontimeupdate = () => {
      if (my !== token || !playing || audio.loop) return;
      const now = audio.currentTime;
      const at = stretch.map.find(m => now >= m.start && now < m.end + 0.05) || null;
      if (!at || at.i === idx) return;
      if (sleep.mode === 'time' && Date.now() >= sleep.endsAt) return goToSleep(at.i);
      idx = at.i;
      highlight();
      savePosition();
      pruneAudioCache();
      pumpGeneration();
    };
    audio.onended = () => {
      if (my !== token || !playing) return;
      idx = stretch.last;
      advance();
    };
    audio.loop = false;
    audio.src = built.url;
    audio.playbackRate = settings.rate;
    if (previous) URL.revokeObjectURL(previous.url);
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
    stop();
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
    if (!next) return setPlayerStatus(`Finished “${finished}”.`);
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
    updatePlayButton();
    keepScreenOn(!isDownloadable());
    keptOpen = false;
    scheduleMini();
    if (!window.__trackedPlay) { window.__trackedPlay = true; track(isDownloadable() ? 'listened-downloaded-voice' : 'listened-builtin-voice'); }
    speakCurrent();
  }

  function stop() {
    clearTimeout(miniTimer);
    setMini(false);
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
    document.body.classList.toggle('playing', playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !work) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: work.title, artist: work.author || 'Fic Me Up' });
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
    audio.playbackRate = settings.rate;   // downloaded voices change speed immediately
    saveSettings();
    updateSummary();
  }
  setRate(settings.rate);
  els.rate.oninput = () => { setRate(els.rate.value); savePosition(); };
  els.rate.onchange = () => { if (playing && !isDownloadable()) speakCurrent(); };
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
