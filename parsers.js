// Turns files and pages into { title, author, chapters: [{ title, paragraphs: [string] }] }.
// Everything happens locally in the browser; nothing is fetched from AO3.
const Parsers = (() => {
  'use strict';

  const BLOCKS = 'p,div,br,li,h1,h2,h3,h4,h5,h6,blockquote,tr,hr,pre,section,article,dd,dt,center';
  const HEADING_MARK = '\u0001';

  const clean = s => s.replace(/ /g, ' ').replace(/[ \t\r\f\v]+/g, ' ').trim();
  const textOf = el => clean((el?.textContent || '').replace(/\s+/g, ' '));

  // Split an element into paragraphs, treating every block element and <br> as a break.
  function paragraphsOf(el, { markHeadings = false } = {}) {
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style,.landmark,dl.tags,dl.work.meta,dl.stats').forEach(n => n.remove());
    if (markHeadings) c.querySelectorAll('h1,h2').forEach(h => h.prepend(HEADING_MARK));
    c.querySelectorAll(BLOCKS).forEach(n => { n.before('\n'); n.after('\n'); });
    return c.textContent.split('\n').map(clean).filter(Boolean);
  }

  function firstMatch(doc, selectors) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el && textOf(el)) return el;
    }
    return null;
  }

  function workTitle(doc) {
    const el = firstMatch(doc, ['#preface .meta h1', '.preface h2.title', 'h2.title.heading', 'h1', 'title']);
    return el ? textOf(el).replace(/\s+-\s+.*Archive of Our Own.*$/i, '') : '';
  }

  function workAuthor(doc) {
    const links = [...doc.querySelectorAll('a[rel="author"]')].map(textOf).filter(Boolean);
    return [...new Set(links)].join(', ');
  }

  // AO3 pages and downloads keep the story in div.userstuff, with chapter
  // headings in h2.heading (downloads) or h3.title (the website).
  function hasUserstuff(doc) {
    const root = doc.querySelector('#chapters') || doc.body || doc.documentElement;
    return !!root && [...root.querySelectorAll('div.userstuff')].some(n => n !== root);
  }

  function extractChapters(doc, fallbackTitle) {
    const root = doc.querySelector('#chapters') || doc.body || doc.documentElement;
    if (!root) return [];
    if (!hasUserstuff(doc)) return genericChapters(root, fallbackTitle);

    const insideText = n => {
      const outer = n.parentElement?.closest('div.userstuff');
      return !!outer && outer !== root && root.contains(outer);
    };

    const chapters = [];
    let current = null;
    for (const n of root.querySelectorAll('h2.heading, h3.title, div.userstuff')) {
      if (n === root || insideText(n)) continue;
      if (n.matches('div.userstuff')) {
        if (!current) chapters.push(current = { title: fallbackTitle || 'Chapter 1', paragraphs: [] });
        current.paragraphs.push(...paragraphsOf(n));
      } else {
        chapters.push(current = { title: textOf(n) || `Chapter ${chapters.length + 1}`, paragraphs: [] });
      }
    }
    return chapters.filter(c => c.paragraphs.length);
  }

  // Anything that isn't AO3-shaped: split at h1/h2 headings.
  function genericChapters(root, fallbackTitle) {
    const chapters = [];
    let current = null;
    for (const line of paragraphsOf(root, { markHeadings: true })) {
      if (line.startsWith(HEADING_MARK)) {
        const title = clean(line.replaceAll(HEADING_MARK, ''));
        if (!title) continue;
        if (current && !current.paragraphs.length) current.title += ' – ' + title;
        else chapters.push(current = { title, paragraphs: [] });
      } else {
        if (!current) chapters.push(current = { title: fallbackTitle || 'Start', paragraphs: [] });
        current.paragraphs.push(line.replaceAll(HEADING_MARK, ''));
      }
    }
    return chapters.filter(c => c.paragraphs.length);
  }

  // The work's own AO3 address, if the page or file mentions it.
  const WORK_URL = /archiveofourown\.org\/works\/(\d+)/i;
  const workUrlIn = text => {
    const m = (text || '').match(WORK_URL);
    return m ? `https://archiveofourown.org/works/${m[1]}` : '';
  };

  // AO3's info block (Rating … Stats) as [label, value] rows, from the <dl> on the
  // website (dl.work.meta) or in downloads (dl.tags). Stats are nested, so flattened.
  function infoFromDocument(doc) {
    const dl = doc.querySelector('dl.work.meta, dl.tags');
    if (!dl) return [];
    const rows = [];
    for (const dt of dl.querySelectorAll(':scope > dt')) {
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName.toLowerCase() !== 'dd') continue;
      const label = textOf(dt).replace(/:$/, '');
      const nested = dd.querySelector('dl');
      if (nested) {
        for (const ndt of nested.querySelectorAll('dt')) {
          const ndd = ndt.nextElementSibling;
          if (ndd) rows.push([textOf(ndt).replace(/:$/, ''), textOf(ndd)]);
        }
      } else {
        const items = [...dd.querySelectorAll('li a, a.tag')].map(textOf).filter(Boolean);
        rows.push([label, items.length ? [...new Set(items)].join(', ') : textOf(dd)]);
      }
    }
    return rows.filter(([l, v]) => l && v);
  }

  // A page from AO3 (via the Listen button) or a downloaded .html file.
  function fromDocument(doc, fallbackTitle = 'Untitled') {
    const title = workTitle(doc) || fallbackTitle;
    const url = workUrlIn(doc.documentElement?.innerHTML);
    return { title, author: workAuthor(doc), chapters: extractChapters(doc, title), info: infoFromDocument(doc), url };
  }

  const CHAPTER_LINE = /^(chapter|part|prologue|epilogue|interlude)\b.{0,80}$/i;

  function fromText(text, title = 'Untitled') {
    const url = workUrlIn(text);
    const normalized = text.replace(/\r\n?/g, '\n');
    // Prefer blank-line paragraphs; fall back to one paragraph per line.
    const blocks = /\n\s*\n/.test(normalized) ? normalized.split(/\n\s*\n/) : normalized.split('\n');
    const chapters = [];
    let current = null;
    for (const raw of blocks) {
      const lines = raw.split('\n').map(clean).filter(Boolean);
      if (!lines.length) continue;
      if (lines.length === 1 && CHAPTER_LINE.test(lines[0])) {
        chapters.push(current = { title: lines[0], paragraphs: [] });
        continue;
      }
      if (!current) chapters.push(current = { title, paragraphs: [] });
      current.paragraphs.push(lines.join(' '));
    }
    return { title, author: '', chapters: chapters.filter(c => c.paragraphs.length), url };
  }

  function parseMarkup(str) {
    let doc = new DOMParser().parseFromString(str, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(str, 'text/html');
    return doc;
  }

  function resolvePath(base, href) {
    const parts = (base + href.split('#')[0]).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.' && p !== '') out.push(p);
    }
    return out.join('/');
  }

  async function fromEpub(file) {
    if (typeof JSZip === 'undefined') throw new Error('The EPUB reader could not load. Check your internet connection and reload.');
    const zip = await JSZip.loadAsync(file);
    const readText = path => {
      const f = zip.file(path) || zip.file(decodeURIComponent(path));
      return f ? f.async('string') : Promise.resolve(null);
    };

    const container = new DOMParser().parseFromString(await readText('META-INF/container.xml') || '', 'application/xml');
    const opfPath = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
    if (!opfPath) throw new Error('This EPUB looks damaged (no table of contents).');
    const opf = new DOMParser().parseFromString(await readText(opfPath) || '', 'application/xml');
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    const manifest = {};
    for (const item of opf.getElementsByTagNameNS('*', 'item')) manifest[item.getAttribute('id')] = item.getAttribute('href');
    const meta = name => textOf(opf.getElementsByTagNameNS('*', name)[0]);

    const title = meta('title') || file.name.replace(/\.epub$/i, '');
    let info = [], url = '';
    const parts = [];
    for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
      const href = manifest[ref.getAttribute('idref')];
      if (!href) continue;
      const str = await readText(resolvePath(base, href));
      if (!str) continue;
      const doc = parseMarkup(str);
      if (!info.length) info = infoFromDocument(doc);
      url ||= workUrlIn(str);
      const heading = firstMatch(doc, ['h2.heading', 'h3.title', 'h1', 'h2', 'h3']);
      parts.push({ ao3: hasUserstuff(doc), chapters: extractChapters(doc, heading ? textOf(heading) : `Part ${parts.length + 1}`) });
    }
    // AO3 EPUBs also contain a title page and tag list; keep only the story parts.
    const story = parts.some(p => p.ao3) ? parts.filter(p => p.ao3) : parts;
    return { title, author: meta('creator'), chapters: story.flatMap(p => p.chapters), info, url };
  }

  // Loads a library from a CDN once, only when it's first needed.
  const scriptPromises = {};
  function loadScript(url, globalName, what) {
    scriptPromises[url] ||= new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = url;
      el.onload = () => resolve(window[globalName]);
      el.onerror = () => { delete scriptPromises[url]; reject(new Error(`The ${what} reader could not load. Check your internet connection.`)); };
      document.head.append(el);
    });
    return scriptPromises[url];
  }

  // Any web page that isn't an AO3 work: Mozilla's Readability (the engine behind
  // Firefox Reader View) picks out the article and drops menus, ads and comments.
  async function fromPage(doc, url = '', fallbackTitle = 'Untitled') {
    if (doc.querySelector('#workskin') || hasUserstuff(doc)) return fromDocument(doc, fallbackTitle);
    const Readability = await loadScript('https://cdn.jsdelivr.net/npm/@mozilla/readability@0.6.0/Readability.js', 'Readability', 'web page');
    const base = doc.createElement('base');
    if (url) { base.href = url; doc.head?.prepend(base); }
    const article = new Readability(doc.cloneNode(true)).parse();
    if (!article?.content) return fromDocument(doc, fallbackTitle);
    const body = new DOMParser().parseFromString(article.content, 'text/html');
    const heading = body.querySelector('h1, h2');
    const title = (heading && textOf(heading)) || clean(article.title || '').split(/\s+[|–—]\s+/)[0] || workTitle(doc) || fallbackTitle;
    return { title, author: clean(article.byline || ''), chapters: genericChapters(body.body, title), info: [], url: workUrlIn(url) };
  }

  // Word documents, converted to HTML with mammoth, then read like any page.
  async function fromDocx(file, title) {
    const mammoth = await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js', 'mammoth', 'Word document');
    const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    const doc = new DOMParser().parseFromString(value, 'text/html');
    const firstHeading = doc.querySelector('h1, h2');
    return { title: firstHeading ? textOf(firstHeading) : title, author: '', chapters: genericChapters(doc.body, title), info: [], url: workUrlIn(value) };
  }

  let pdfjsPromise;
  function loadPdfjs() {
    const v = '3.11.174';
    pdfjsPromise ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${v}/pdf.min.js`;
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${v}/pdf.worker.min.js`;
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { pdfjsPromise = null; reject(new Error('The PDF reader could not load. Check your internet connection.')); };
      document.head.append(s);
    });
    return pdfjsPromise;
  }

  // PDFs have no paragraphs, only positioned lines. Rebuild paragraphs from line gaps,
  // then reuse the plain-text parser for chapter detection.
  async function fromPdf(file) {
    const pdfjs = await loadPdfjs();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const { items } = await page.getTextContent();
      let line = null;
      for (const it of items) {
        if (!it.str) continue;
        const x = it.transform[4], y = it.transform[5];
        if (!line || Math.abs(y - line.y) > 2) {
          if (line) lines.push(line);
          line = { page: p, y, text: '', end: x };
        }
        const needsSpace = line.text && !/\s$/.test(line.text) && !/^\s/.test(it.str) && x - line.end > 1;
        line.text += (needsSpace ? ' ' : '') + it.str;
        line.end = x + (it.width || 0);
      }
      if (line) lines.push(line);
    }

    const kept = lines.map(l => ({ ...l, text: clean(l.text) })).filter(l => l.text && !/^\d+$/.test(l.text));
    const gaps = [];
    for (let i = 1; i < kept.length; i++) {
      if (kept[i].page === kept[i - 1].page) gaps.push(Math.abs(kept[i - 1].y - kept[i].y));
    }
    gaps.sort((a, b) => a - b);
    const typical = gaps[Math.floor(gaps.length / 2)] || 14;

    let text = '';
    kept.forEach((l, i) => {
      const prev = kept[i - 1];
      let breakBefore = false;
      if (prev) {
        breakBefore = l.page === prev.page
          ? Math.abs(prev.y - l.y) > typical * 1.4
          : /[.!?"”’)]$/.test(prev.text);
      }
      text += (i === 0 ? '' : breakBefore ? '\n\n' : ' ') + l.text;
    });
    return fromText(text, file.name.replace(/\.pdf$/i, ''));
  }

  async function fromFile(file) {
    const name = file.name.toLowerCase();
    const bare = file.name.replace(/\.[^.]+$/, '');
    if (name.endsWith('.epub') || file.type === 'application/epub+zip') return fromEpub(file);
    if (name.endsWith('.pdf') || file.type === 'application/pdf') return fromPdf(file);
    if (/\.html?$/.test(name) || file.type === 'text/html') {
      return fromPage(new DOMParser().parseFromString(await file.text(), 'text/html'), '', bare);
    }
    if (name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return fromDocx(file, bare);
    }
    if (/\.(doc|pages|rtf)$/.test(name)) {
      throw new Error('This format can’t be read. Save it as .docx, PDF or plain text first (Share → Export or Save As).');
    }
    if (/\.(mobi|azw3?)$/.test(name)) {
      throw new Error('Kindle files (MOBI/AZW3) aren’t supported. Download the EPUB version from AO3 instead; it’s the same story.');
    }
    if (file.type && !file.type.startsWith('text/') && !/\.(txt|text|md)$/.test(name)) {
      throw new Error('This isn’t a file Fic Me Up can read. EPUB, PDF, Word (.docx), HTML and text files work.');
    }
    return fromText(await file.text(), bare);
  }

  // AO3 puts an info block before the story: Rating, Archive Warning, Category, Fandom,
  // Relationship, Characters, Additional Tags, Language, Series, Stats. Downloads (PDF
  // especially) and pasted text include it as ordinary paragraphs, so drop it when found
  // near the start, along with the "Posted originally on the Archive of Our Own" line.
  const META_START = /^Rating\s*:/i;
  const STATS_LINE = /^(Stats|Published|Updated|Completed|Words|Chapters|Comments|Kudos|Bookmarks|Hits)\s*:/i;
  const AO3_LABEL = /^(Archive Warnings?|Categor(y|ies)|Fandoms?|Relationships?|Characters?|Additional Tags|Language|Series|Collections?)\s*:/i;
  const POSTED_LINE = /^(Posted originally on the Archive of Our Own|at https?:\/\/(www\.)?archiveofourown\.org\/works\/)/i;

  const STATS_KEYS = /(Published|Updated|Completed|Words|Chapters|Comments|Kudos|Bookmarks|Hits)\s*:\s*/gi;

  // Turn the block's lines into [label, value] rows. In PDFs a label and its value
  // are often on separate lines, and all the stats share one line.
  function rowsFromLines(lines) {
    const rows = [];
    for (const line of lines) {
      if (/^Stats\s*:/i.test(line) || (STATS_KEYS.lastIndex = 0, (line.match(STATS_KEYS) || []).length > 1)) {
        const parts = line.replace(/^Stats\s*:\s*/i, '').split(STATS_KEYS).map(clean).filter(Boolean);
        for (let i = 0; i + 1 < parts.length; i += 2) rows.push([parts[i], parts[i + 1]]);
        continue;
      }
      const m = line.match(/^([A-Z][A-Za-z ]{1,30}):\s*(.*)$/);
      if (m) rows.push([m[1], m[2]]);
      else if (rows.length) rows[rows.length - 1][1] = clean(`${rows[rows.length - 1][1]} ${line}`);
    }
    return rows.filter(([, v]) => v);
  }

  // Splits AO3's info block (and the "Posted originally…" line) out of the story text,
  // so it can be shown without being read aloud.
  function splitAo3Info(chapters) {
    let info = [];
    const out = chapters.map((ch, c) => {
      if (c > 1) return ch;   // the block only ever appears at the very beginning
      let paras = ch.paragraphs.filter((p, i) => !(i < 5 && POSTED_LINE.test(p)));
      const start = paras.slice(0, 40).findIndex(p => META_START.test(p));
      if (start >= 0) {
        let end = -1;
        for (let i = start + 1; i < Math.min(paras.length, start + 80); i++) {
          if (STATS_LINE.test(paras[i])) end = i;
          else if (end >= 0 && i - end > 2) break;   // past the stats lines
        }
        // Stat values sometimes sit on their own lines just after a "Label:" line.
        while (end >= 0 && end + 1 < paras.length && /^[\d,./?]+$/.test(paras[end + 1])) end++;
        // Only treat it as AO3's block if AO3's other labels are there too.
        const labels = paras.slice(start, end + 1).filter(p => AO3_LABEL.test(p)).length;
        if (end > start && labels >= 2) {
          info = rowsFromLines(paras.slice(start, end + 1));
          paras = [...paras.slice(0, start), ...paras.slice(end + 1)];
        }
      }
      return paras.length === ch.paragraphs.length ? ch : { ...ch, paragraphs: paras };
    });
    return { chapters: out, info };
  }

  return { fromFile, fromText, fromDocument, fromPage, splitAo3Info };
})();
