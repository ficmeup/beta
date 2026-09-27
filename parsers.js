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
    c.querySelectorAll('script,style,.landmark').forEach(n => n.remove());
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

  // A page from AO3 (via the Listen button) or a downloaded .html file.
  function fromDocument(doc, fallbackTitle = 'Untitled') {
    const title = workTitle(doc) || fallbackTitle;
    return { title, author: workAuthor(doc), chapters: extractChapters(doc, title) };
  }

  const CHAPTER_LINE = /^(chapter|part|prologue|epilogue|interlude)\b.{0,80}$/i;

  function fromText(text, title = 'Untitled') {
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
    return { title, author: '', chapters: chapters.filter(c => c.paragraphs.length) };
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
    const parts = [];
    for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
      const href = manifest[ref.getAttribute('idref')];
      if (!href) continue;
      const str = await readText(resolvePath(base, href));
      if (!str) continue;
      const doc = parseMarkup(str);
      const heading = firstMatch(doc, ['h2.heading', 'h3.title', 'h1', 'h2', 'h3']);
      parts.push({ ao3: hasUserstuff(doc), chapters: extractChapters(doc, heading ? textOf(heading) : `Part ${parts.length + 1}`) });
    }
    // AO3 EPUBs also contain a title page and tag list; keep only the story parts.
    const story = parts.some(p => p.ao3) ? parts.filter(p => p.ao3) : parts;
    return { title, author: meta('creator'), chapters: story.flatMap(p => p.chapters) };
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
      return fromDocument(new DOMParser().parseFromString(await file.text(), 'text/html'), bare);
    }
    if (/\.(mobi|azw3?)$/.test(name)) {
      throw new Error('Kindle files (MOBI/AZW3) aren’t supported. Download the EPUB version from AO3 instead; it’s the same story.');
    }
    return fromText(await file.text(), bare);
  }

  return { fromFile, fromText, fromDocument };
})();
