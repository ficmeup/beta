// The Listen bookmark's code, shared by the app and the guide so both copy the same thing.
// It runs in the reader's own AO3 tab and reads the page already on screen; it never
// contacts AO3. On iPhone and iPad it offers a second route, copying the story, because a
// Home Screen app has its own storage, separate from Safari's.
const Listen = (() => {
  const PREFIX = 'FICMEUP1:';
  function code(app, origin) {
    const src = `(()=>{const A=${JSON.stringify(app)},O=${JSON.stringify(origin)},P=${JSON.stringify(PREFIX)};`
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
      + `const b1=mk('Open in browser',true),b2=mk('Copy for the Home Screen app',false),b3=mk('Cancel',false);`
      + `b1.onclick=()=>{b.remove();go()};b3.onclick=()=>b.remove();`
      + `b2.onclick=async()=>{try{await navigator.clipboard.writeText(P+JSON.stringify({html:d.html,url:d.url}));b2.textContent='Copied. In the app, tap Paste';b2.disabled=true;setTimeout(()=>b.remove(),6000)}catch(e){alert('Copying didn’t work: '+e.message)}};`
      + `document.body.append(b)})()`;
    return 'javascript:' + encodeURIComponent(src);
  }
  return { PREFIX, code };
})();
