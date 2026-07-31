/* ═══════════════════════════════════════════════════════════════
   AUDIO BOOKS — PICTURE-IN-PICTURE PLAYER
   ───────────────────────────────────────────────────────────────
   Dua mode, auto-pilih sesuai kemampuan browser:

   MODE A · Document Picture-in-Picture  (Chrome / Edge desktop 116+)
     Window floating berisi DOM asli → tombol bisa diklik,
     teks live ikut jalan, styling penuh mengikuti tema app.

   MODE B · Canvas → Video PiP          (Safari macOS/iPadOS, Firefox)
     Canvas di-render tiap frame lalu di-captureStream ke <video>
     tersembunyi, terus masuk PiP native. Tampilan sama persis,
     kontrol lewat Media Session (play/pause/prev/next OS-level).

   Dependensi global dari app.js: bookTitle, chapters, currentChapter,
   currentSentence, isPlaying, isMuted, window._currentBookMeta,
   togglePlay(), rewindSentence(), forwardSentence(), toggleMute(),
   prevChapter(), nextChapter()
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── KONFIG ───────────────────────────────────────────────── */
  const PIP_W = 420;
  const PIP_H = 296;
  const CANVAS_W = 640;   // mode B — resolusi render
  const CANVAS_H = 452;
  const LS_AUTO = 'ab_pip_auto';   // '1' = auto masuk PiP saat tab disembunyikan

  /* ── STATE ────────────────────────────────────────────────── */
  let mode = null;          // 'doc' | 'video' | null
  let pipWin = null;        // mode A
  let videoEl = null;       // mode B
  let canvasEl = null;
  let ctx = null;
  let rafId = null;
  let coverImg = null;      // HTMLImageElement (CORS-safe) atau null
  let coverSrcLoaded = null;
  let active = false;
  let opening = false;
  let refs = {};            // element refs di dalam pip window

  /* ── FEATURE DETECTION ────────────────────────────────────── */
  const hasDocPiP = typeof window !== 'undefined' && 'documentPictureInPicture' in window;

  function hasVideoPiP() {
    const v = document.createElement('video');
    return !!(
      (document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function') ||
      (typeof v.webkitSupportsPresentationMode === 'function' &&
        v.webkitSupportsPresentationMode('picture-in-picture'))
    );
  }

  const supported = hasDocPiP || (hasVideoPiP() && !!HTMLCanvasElement.prototype.captureStream);

  /* ── HELPER: baca state app dengan aman ───────────────────── */
  // app.js mengekspos window.abGetState() sebagai bridge. Kalau belum ada
  // (misal pip.js ke-load duluan), semua nilai jatuh ke default aman.
  function snap() {
    let st = {};
    try { if (typeof window.abGetState === 'function') st = window.abGetState() || {}; } catch (e) {}

    const chs = Array.isArray(st.chapters) ? st.chapters : [];
    const ci = typeof st.currentChapter === 'number' ? st.currentChapter : -1;
    const si = typeof st.currentSentence === 'number' ? st.currentSentence : 0;
    const ch = chs[ci] || null;
    const sents = (ch && Array.isArray(ch.sentences)) ? ch.sentences : [];

    return {
      title: st.bookTitle || 'Audio Books',
      chapterTitle: (ch && ch.title) || '—',
      chapterIdx: ci,
      chapterTotal: chs.length,
      sentIdx: si,
      sentTotal: sents.length,
      prevText: sents[si - 1] || '',
      currText: sents[si] || 'Pilih bab untuk mulai mendengarkan.',
      nextText: sents[si + 1] || '',
      playing: !!st.isPlaying,
      muted: !!st.isMuted,
      cover: (window._currentBookMeta && window._currentBookMeta.cover_url) || null,
      night: document.body.classList.contains('night'),
      pct: sents.length ? Math.min(100, Math.round(((si + 1) / sents.length) * 100)) : 0
    };
  }

  // Function declaration di classic script otomatis nempel ke window,
  // jadi togglePlay/rewindSentence/dst bisa dipanggil langsung.
  function call(fn) {
    try { if (typeof window[fn] === 'function') return window[fn](); } catch (e) {}
  }

  /* ── COVER LOADER (CORS-safe untuk canvas) ────────────────── */
  function ensureCover(src) {
    if (!src) { coverImg = null; coverSrcLoaded = null; return; }
    if (src === coverSrcLoaded) return;
    coverSrcLoaded = src;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (coverSrcLoaded === src) coverImg = img; };
    img.onerror = () => { if (coverSrcLoaded === src) coverImg = null; };
    img.src = src;
  }

  /* ═══════════════════════════════════════════════════════════
     MODE A — DOCUMENT PICTURE-IN-PICTURE
     ═══════════════════════════════════════════════════════════ */

  const PIP_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=DM+Sans:opsz,wght@9..40,400;9..40,500&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#eaeae8; --surface:#f3f3f1; --surface2:#e0e0dd;
  --border:rgba(40,40,35,.12); --border-strong:rgba(40,40,35,.24);
  --ink:#1c1c1a; --ink-dim:#454542; --ink-muted:#77776f;
  --accent:#5a5a52; --accent-light:rgba(90,90,82,.09); --accent-mid:rgba(90,90,82,.16);
  --u: 1.05vw;
}
body.night{
  --bg:#16130e; --surface:#1f1c13; --surface2:#272318;
  --border:rgba(190,160,90,.08); --border-strong:rgba(190,160,90,.15);
  --ink:#e4dcc8; --ink-dim:#9a8e78; --ink-muted:#b3a78f;
  --accent:#c09848; --accent-light:rgba(192,152,72,.10); --accent-mid:rgba(192,152,72,.20);
}
html,body{height:100%;overflow:hidden}
body{
  font-family:'DM Sans',system-ui,-apple-system,sans-serif;
  background:var(--bg); color:var(--ink);
  display:flex; flex-direction:column;
  user-select:none; -webkit-user-select:none;
  transition:background .3s ease,color .3s ease;
}

/* ── HEADER ── */
.pip-head{
  display:flex; align-items:center; gap:calc(var(--u)*.9);
  padding:calc(var(--u)*1.15) calc(var(--u)*1.35) calc(var(--u)*.9);
  border-bottom:1px solid var(--border); flex-shrink:0;
}
.pip-cover{
  width:calc(var(--u)*3.6); height:calc(var(--u)*5.2); min-width:26px; min-height:38px;
  border-radius:calc(var(--u)*.42); overflow:hidden; flex-shrink:0;
  background:var(--surface2); border:1px solid var(--border);
  display:flex; align-items:center; justify-content:center;
  font-size:calc(var(--u)*1.8); box-shadow:0 2px 6px rgba(0,0,0,.10);
}
.pip-cover img{width:100%;height:100%;object-fit:cover;display:block}
.pip-meta{min-width:0;flex:1}
.pip-title{
  font-family:'Lora',Georgia,serif; font-weight:600;
  font-size:calc(var(--u)*1.35); line-height:1.25; color:var(--ink);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.pip-chapter{
  font-size:calc(var(--u)*1.02); color:var(--ink-muted); margin-top:calc(var(--u)*.18);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; letter-spacing:.01em;
}
.pip-live{
  display:flex; align-items:center; gap:calc(var(--u)*.4);
  font-size:calc(var(--u)*.92); color:var(--ink-muted);
  flex-shrink:0; align-self:flex-start; padding-top:calc(var(--u)*.2);
}
.pip-dot{
  width:calc(var(--u)*.6); height:calc(var(--u)*.6); min-width:5px; min-height:5px;
  border-radius:50%; background:var(--ink-muted); opacity:.45;
}
body.is-playing .pip-dot{background:var(--accent);opacity:1;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}

/* ── TELEPROMPTER ── */
.pip-text{
  flex:1; min-height:0; overflow:hidden; position:relative;
  padding:calc(var(--u)*1.1) calc(var(--u)*1.5);
  display:flex; flex-direction:column; justify-content:center; gap:calc(var(--u)*.55);
}
.pip-line{
  font-family:'Lora',Georgia,serif;
  line-height:1.5; letter-spacing:.005em;
  display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden;
  transition:opacity .25s ease;
}
.pip-line.ghost{
  font-size:calc(var(--u)*1.08); color:var(--ink-muted); opacity:.5;
  -webkit-line-clamp:1; line-clamp:1;
}
.pip-line.now{
  font-size:calc(var(--u)*1.62); color:var(--ink); font-weight:500;
  -webkit-line-clamp:4; line-clamp:4;
  border-left:calc(var(--u)*.22) solid var(--accent-mid);
  padding-left:calc(var(--u)*.85);
}
body.is-playing .pip-line.now{border-left-color:var(--accent)}

/* ── FOOTER ── */
.pip-foot{flex-shrink:0;border-top:1px solid var(--border);background:var(--surface)}
.pip-track{height:calc(var(--u)*.28);min-height:2px;background:var(--surface2);overflow:hidden}
.pip-fill{height:100%;width:0%;background:var(--accent);transition:width .3s ease}
.pip-ctrls{
  display:flex; align-items:center; justify-content:space-between;
  gap:calc(var(--u)*.5); padding:calc(var(--u)*.85) calc(var(--u)*1.2);
}
.pip-side{display:flex;align-items:center;gap:calc(var(--u)*.25);flex:1}
.pip-side.right{justify-content:flex-end}
.pip-center{display:flex;align-items:center;gap:calc(var(--u)*.7)}
.pip-counter{
  font-size:calc(var(--u)*.95); color:var(--ink-muted);
  font-variant-numeric:tabular-nums; white-space:nowrap;
}
button{
  font-family:inherit; border:none; background:none; color:var(--ink-dim);
  cursor:pointer; display:flex; align-items:center; justify-content:center;
  border-radius:50%; transition:background .18s ease,color .18s ease,transform .12s ease;
}
button:hover{background:var(--accent-light);color:var(--ink)}
button:active{transform:scale(.9)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button svg{width:100%;height:100%;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.b-sm{width:calc(var(--u)*2.5);height:calc(var(--u)*2.5);min-width:22px;min-height:22px;padding:calc(var(--u)*.5)}
.b-md{width:calc(var(--u)*2.9);height:calc(var(--u)*2.9);min-width:26px;min-height:26px;padding:calc(var(--u)*.55)}
.b-play{
  width:calc(var(--u)*3.9);height:calc(var(--u)*3.9);min-width:36px;min-height:36px;
  padding:calc(var(--u)*1);background:var(--accent);color:var(--bg);
  box-shadow:0 2px 8px rgba(0,0,0,.16);
}
.b-play:hover{background:var(--accent);color:var(--bg);filter:brightness(1.12)}
.b-play svg{fill:currentColor;stroke:none}
.b-on{color:var(--accent);background:var(--accent-light)}
.hide{display:none !important}
`;

  const PIP_HTML = `
<div class="pip-head">
  <div class="pip-cover" id="p-cover">📖</div>
  <div class="pip-meta">
    <div class="pip-title" id="p-title">—</div>
    <div class="pip-chapter" id="p-chapter">—</div>
  </div>
  <div class="pip-live"><span class="pip-dot"></span><span id="p-live">Jeda</span></div>
</div>

<div class="pip-text">
  <div class="pip-line ghost" id="p-prev"></div>
  <div class="pip-line now" id="p-now">—</div>
  <div class="pip-line ghost" id="p-next"></div>
</div>

<div class="pip-foot">
  <div class="pip-track"><div class="pip-fill" id="p-fill"></div></div>
  <div class="pip-ctrls">
    <div class="pip-side">
      <button class="b-sm" id="p-mute" title="Bisukan / nyalakan suara" aria-label="Bisukan suara">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" id="p-ico-vol">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        </svg>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" id="p-ico-mute" class="hide">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
        </svg>
      </button>
      <button class="b-sm" id="p-chprev" title="Bab sebelumnya" aria-label="Bab sebelumnya">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polyline points="15 18 9 12 15 6"/><line x1="6" y1="6" x2="6" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="pip-center">
      <button class="b-md" id="p-prevs" title="Kalimat sebelumnya" aria-label="Kalimat sebelumnya">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>
        </svg>
      </button>
      <button class="b-play" id="p-play" title="Putar / jeda" aria-label="Putar atau jeda">
        <svg viewBox="0 0 24 24" id="p-ico-play"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <svg viewBox="0 0 24 24" id="p-ico-pause" class="hide"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      </button>
      <button class="b-md" id="p-nexts" title="Kalimat berikutnya" aria-label="Kalimat berikutnya">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>
        </svg>
      </button>
    </div>

    <div class="pip-side right">
      <span class="pip-counter" id="p-count">—</span>
      <button class="b-sm" id="p-chnext" title="Bab berikutnya" aria-label="Bab berikutnya">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polyline points="9 18 15 12 9 6"/><line x1="18" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <button class="b-sm" id="p-back" title="Kembali ke aplikasi" aria-label="Kembali ke aplikasi">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polyline points="15 3 21 3 21 9"/><line x1="21" y1="3" x2="14" y2="10"/>
          <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>
        </svg>
      </button>
    </div>
  </div>
</div>
`;

  async function openDoc() {
    const w = Number(localStorage.getItem('ab_pip_w')) || PIP_W;
    const h = Number(localStorage.getItem('ab_pip_h')) || PIP_H;

    pipWin = await documentPictureInPicture.requestWindow({
      width: w, height: h, disallowReturnToOpener: false
    });

    const d = pipWin.document;
    d.documentElement.lang = 'id';
    d.title = snap().title || 'Audio Books';

    const style = d.createElement('style');
    style.textContent = PIP_CSS;
    d.head.appendChild(style);
    d.body.innerHTML = PIP_HTML;

    refs = {
      cover: d.getElementById('p-cover'),
      title: d.getElementById('p-title'),
      chapter: d.getElementById('p-chapter'),
      live: d.getElementById('p-live'),
      prev: d.getElementById('p-prev'),
      now: d.getElementById('p-now'),
      next: d.getElementById('p-next'),
      fill: d.getElementById('p-fill'),
      count: d.getElementById('p-count'),
      icoPlay: d.getElementById('p-ico-play'),
      icoPause: d.getElementById('p-ico-pause'),
      icoVol: d.getElementById('p-ico-vol'),
      icoMute: d.getElementById('p-ico-mute'),
      btnMute: d.getElementById('p-mute'),
      body: d.body
    };

    const on = (id, fn) => {
      const el = d.getElementById(id);
      if (el) el.addEventListener('click', (e) => { e.preventDefault(); fn(); setTimeout(sync, 60); });
    };
    on('p-play', () => call('togglePlay'));
    on('p-prevs', () => call('rewindSentence'));
    on('p-nexts', () => call('forwardSentence'));
    on('p-chprev', () => call('prevChapter'));
    on('p-chnext', () => call('nextChapter'));
    on('p-mute', () => call('toggleMute'));
    on('p-back', () => { try { window.focus(); } catch (e) {} close(); });

    // Keyboard shortcut di dalam window PiP
    d.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); call('togglePlay'); setTimeout(sync, 60); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); call('rewindSentence'); setTimeout(sync, 60); }
      if (e.key === 'ArrowRight') { e.preventDefault(); call('forwardSentence'); setTimeout(sync, 60); }
      if (e.key === 'm' || e.key === 'M') { call('toggleMute'); setTimeout(sync, 60); }
    });

    pipWin.addEventListener('resize', () => {
      try {
        localStorage.setItem('ab_pip_w', String(pipWin.innerWidth));
        localStorage.setItem('ab_pip_h', String(pipWin.innerHeight));
      } catch (e) {}
    });

    pipWin.addEventListener('pagehide', () => { teardown(); });

    mode = 'doc';
    active = true;
    syncDoc(snap());
  }

  function syncDoc(s) {
    if (!pipWin || !refs.title) return;
    refs.body.classList.toggle('night', s.night);
    refs.body.classList.toggle('is-playing', s.playing);

    if (refs.title.textContent !== s.title) refs.title.textContent = s.title;
    const chLabel = s.chapterIdx >= 0
      ? `Bab ${s.chapterIdx + 1}/${s.chapterTotal} · ${s.chapterTitle}`
      : 'Belum ada bab dipilih';
    if (refs.chapter.textContent !== chLabel) refs.chapter.textContent = chLabel;

    refs.live.textContent = s.playing ? 'Membaca' : 'Jeda';
    refs.prev.textContent = s.prevText;
    if (refs.now.textContent !== s.currText) refs.now.textContent = s.currText;
    refs.next.textContent = s.nextText;
    refs.fill.style.width = s.pct + '%';
    refs.count.textContent = s.sentTotal ? `${s.sentIdx + 1}/${s.sentTotal}` : '—';

    refs.icoPlay.classList.toggle('hide', s.playing);
    refs.icoPause.classList.toggle('hide', !s.playing);
    refs.icoVol.classList.toggle('hide', s.muted);
    refs.icoMute.classList.toggle('hide', !s.muted);
    refs.btnMute.classList.toggle('b-on', s.muted);

    // Cover
    const want = s.cover || '';
    if (refs.cover.dataset.src !== want) {
      refs.cover.dataset.src = want;
      refs.cover.innerHTML = want
        ? `<img src="${want}" alt="">`
        : '📖';
    }
  }

  /* ═══════════════════════════════════════════════════════════
     MODE B — CANVAS → VIDEO PIP (Safari / Firefox)
     ═══════════════════════════════════════════════════════════ */

  const PALETTE = {
    light: { bg: '#eaeae8', surf: '#f3f3f1', surf2: '#e0e0dd', line: 'rgba(40,40,35,.14)', ink: '#1c1c1a', dim: '#77776f', accent: '#5a5a52' },
    dark: { bg: '#16130e', surf: '#1f1c13', surf2: '#272318', line: 'rgba(190,160,90,.14)', ink: '#e4dcc8', dim: '#b3a78f', accent: '#c09848' }
  };

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function wrap(c, text, maxW, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word;
      if (c.measureText(test).width <= maxW) { cur = test; }
      else {
        if (cur) lines.push(cur);
        cur = word;
        if (lines.length === maxLines) break;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (lines.length === maxLines && words.length) {
      const joined = lines.join(' ');
      const full = words.join(' ');
      if (joined.length < full.length) {
        let last = lines[maxLines - 1];
        while (last.length > 1 && c.measureText(last + '…').width > maxW) last = last.slice(0, -1);
        lines[maxLines - 1] = last + '…';
      }
    }
    return lines;
  }

  function ellipsize(c, text, maxW) {
    let t = String(text || '');
    if (c.measureText(t).width <= maxW) return t;
    while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawFrame() {
    if (!ctx) return;
    const s = snap();
    const P = s.night ? PALETTE.dark : PALETTE.light;
    const W = CANVAS_W, H = CANVAS_H;
    const PAD = 34;

    ensureCover(s.cover);

    // Background
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);

    /* ── HEADER ── */
    const coverW = 62, coverH = 88, headY = PAD;
    ctx.save();
    roundRect(ctx, PAD, headY, coverW, coverH, 8);
    ctx.fillStyle = P.surf2;
    ctx.fill();
    ctx.clip();
    if (coverImg) {
      // object-fit: cover
      const ir = coverImg.width / coverImg.height;
      const br = coverW / coverH;
      let dw = coverW, dh = coverH, dx = PAD, dy = headY;
      if (ir > br) { dw = coverH * ir; dx = PAD - (dw - coverW) / 2; }
      else { dh = coverW / ir; dy = headY - (dh - coverH) / 2; }
      try { ctx.drawImage(coverImg, dx, dy, dw, dh); } catch (e) {}
    } else {
      ctx.fillStyle = P.dim;
      ctx.font = '28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('📖', PAD + coverW / 2, headY + coverH / 2);
    }
    ctx.restore();
    ctx.strokeStyle = P.line;
    ctx.lineWidth = 1;
    roundRect(ctx, PAD + .5, headY + .5, coverW - 1, coverH - 1, 8);
    ctx.stroke();

    const tx = PAD + coverW + 18;
    const liveW = 74;
    const metaW = W - tx - PAD - liveW;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = P.ink;
    ctx.font = '600 23px Lora, Georgia, serif';
    ctx.fillText(ellipsize(ctx, s.title, metaW), tx, headY + 22);

    ctx.fillStyle = P.dim;
    ctx.font = '15px "DM Sans", system-ui, sans-serif';
    const chLabel = s.chapterIdx >= 0
      ? `Bab ${s.chapterIdx + 1}/${s.chapterTotal} · ${s.chapterTitle}`
      : 'Belum ada bab dipilih';
    ctx.fillText(ellipsize(ctx, chLabel, metaW), tx, headY + 46);

    // Status pill
    ctx.font = '500 14px "DM Sans", system-ui, sans-serif';
    const label = s.playing ? 'Membaca' : 'Jeda';
    const lw = ctx.measureText(label).width;
    const pillW = lw + 30, pillX = W - PAD - pillW, pillY = headY + 2;
    roundRect(ctx, pillX, pillY, pillW, 24, 12);
    ctx.fillStyle = s.playing ? P.accent : P.surf2;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pillX + 11, pillY + 12, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = s.playing ? P.bg : P.dim;
    ctx.fill();
    ctx.fillStyle = s.playing ? P.bg : P.dim;
    ctx.fillText(label, pillX + 21, pillY + 17);

    // Divider
    ctx.fillStyle = P.line;
    ctx.fillRect(PAD, headY + coverH + 22, W - PAD * 2, 1);

    /* ── TELEPROMPTER ── */
    let y = headY + coverH + 62;
    const textW = W - PAD * 2 - 18;

    ctx.fillStyle = P.dim;
    ctx.font = 'italic 16px Lora, Georgia, serif';
    if (s.prevText) ctx.fillText(ellipsize(ctx, s.prevText, textW), PAD + 18, y);
    y += 32;

    // Bar aksen kalimat aktif
    ctx.font = '500 25px Lora, Georgia, serif';
    const nowLines = wrap(ctx, s.currText, textW, 4);
    const blockH = nowLines.length * 36;
    ctx.fillStyle = s.playing ? P.accent : P.surf2;
    roundRect(ctx, PAD, y - 26, 4, blockH, 2);
    ctx.fill();

    ctx.fillStyle = P.ink;
    nowLines.forEach((ln, i) => ctx.fillText(ln, PAD + 18, y + i * 36));
    y += blockH + 8;

    ctx.fillStyle = P.dim;
    ctx.font = 'italic 16px Lora, Georgia, serif';
    if (s.nextText) ctx.fillText(ellipsize(ctx, s.nextText, textW), PAD + 18, y);

    /* ── FOOTER ── */
    const fh = 56;
    ctx.fillStyle = P.surf;
    ctx.fillRect(0, H - fh, W, fh);
    ctx.fillStyle = P.line;
    ctx.fillRect(0, H - fh, W, 1);

    const trackY = H - fh + 14, trackW = W - PAD * 2 - 90;
    ctx.fillStyle = P.surf2;
    roundRect(ctx, PAD, trackY, trackW, 5, 2.5);
    ctx.fill();
    ctx.fillStyle = P.accent;
    roundRect(ctx, PAD, trackY, Math.max(3, trackW * s.pct / 100), 5, 2.5);
    ctx.fill();

    ctx.fillStyle = P.dim;
    ctx.font = '14px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(s.sentTotal ? `${s.sentIdx + 1}/${s.sentTotal}` : '—', W - PAD, trackY + 10);

    ctx.textAlign = 'left';
    ctx.font = '13px "DM Sans", system-ui, sans-serif';
    ctx.fillStyle = P.dim;
    ctx.fillText('Kontrol via tombol media sistem', PAD, H - 12);
    ctx.textAlign = 'left';
  }

  // Pakai setTimeout, BUKAN requestAnimationFrame — rAF dibekukan browser
  // saat tab disembunyikan, padahal justru itu momen PiP dipakai.
  function loop() {
    drawFrame();
    rafId = setTimeout(loop, 200); // ~5fps, cukup halus & hemat CPU
  }

  async function openVideo() {
    if (!canvasEl) {
      canvasEl = document.createElement('canvas');
      canvasEl.width = CANVAS_W;
      canvasEl.height = CANVAS_H;
      canvasEl.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(canvasEl);
      ctx = canvasEl.getContext('2d');
    }
    drawFrame();

    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.setAttribute('playsinline', '');
      videoEl.autoplay = true;
      videoEl.autoPictureInPicture = true;
      videoEl.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(videoEl);
      videoEl.addEventListener('leavepictureinpicture', () => { teardown(); });
      videoEl.addEventListener('webkitpresentationmodechanged', () => {
        if (videoEl && videoEl.webkitPresentationMode !== 'picture-in-picture') teardown();
      });
    }

    if (!videoEl.srcObject) {
      let stream;
      try {
        stream = canvasEl.captureStream(6);
      } catch (e) {
        throw new Error('Browser ini gak bisa capture canvas — PiP gak tersedia.');
      }
      videoEl.srcObject = stream;
    }

    await videoEl.play().catch(() => {});

    if (typeof videoEl.requestPictureInPicture === 'function') {
      await videoEl.requestPictureInPicture();
    } else if (typeof videoEl.webkitSetPresentationMode === 'function') {
      videoEl.webkitSetPresentationMode('picture-in-picture');
    } else {
      throw new Error('PiP gak didukung di browser ini.');
    }

    mode = 'video';
    active = true;
    if (rafId) clearTimeout(rafId);
    loop();
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════ */

  function teardown() {
    active = false;
    mode = null;
    if (rafId) { clearTimeout(rafId); rafId = null; }
    pipWin = null;
    refs = {};
    updateButton();
  }

  async function open() {
    if (active || opening) return;
    opening = true;
    try {
      if (hasDocPiP) await openDoc();
      else await openVideo();
      updateButton();
    } catch (e) {
      if (e && e.name === 'NotAllowedError') {
        toast('PiP butuh klik langsung — coba tekan tombolnya lagi.');
      } else if (e && e.name !== 'AbortError') {
        toast((e && e.message) || 'Gagal membuka PiP.');
      }
      teardown();
    } finally {
      opening = false;
    }
  }

  function close() {
    try {
      if (mode === 'doc' && pipWin) pipWin.close();
      if (mode === 'video' && videoEl) {
        if (document.pictureInPictureElement === videoEl && document.exitPictureInPicture) {
          document.exitPictureInPicture();
        } else if (typeof videoEl.webkitSetPresentationMode === 'function') {
          videoEl.webkitSetPresentationMode('inline');
        }
      }
    } catch (e) {}
    teardown();
  }

  function toggle() { active ? close() : open(); }

  function sync() {
    if (!active) return;
    if (mode === 'doc') syncDoc(snap());
    else if (mode === 'video') drawFrame();
  }

  function toast(msg) {
    try { if (typeof window.showToast === 'function') return window.showToast(msg); } catch (e) {}
    console.warn('[PiP]', msg);
  }

  /* ── TOMBOL DI APP ────────────────────────────────────────── */
  function updateButton() {
    document.querySelectorAll('.btn-pip').forEach((b) => {
      b.classList.toggle('pip-active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.title = active ? 'Tutup mini window' : 'Buka mini window (Picture-in-Picture)';
    });
  }

  function mountButtons() {
    document.querySelectorAll('.btn-pip').forEach((b) => {
      if (b.dataset.pipBound) return;
      b.dataset.pipBound = '1';
      if (!supported) { b.style.display = 'none'; return; }
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
    });
    updateButton();
  }

  /* ── AUTO-PIP SAAT TAB DISEMBUNYIKAN ──────────────────────── */
  function autoEnabled() {
    const v = localStorage.getItem(LS_AUTO);
    return v === null ? true : v === '1';   // default: nyala
  }

  document.addEventListener('visibilitychange', () => {
    if (!supported || !autoEnabled()) return;
    const s = snap();
    if (document.hidden) {
      if (s.playing && !active) open().catch(() => {});
    } else if (active && mode === 'doc') {
      // Balik ke tab → window PiP nggak perlu lagi
      close();
    }
  });

  // Chrome kasih "gesture" resmi lewat action ini saat app di background
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', () => { open(); });
    } catch (e) {}
  }

  /* ── EXPOSE ───────────────────────────────────────────────── */
  window.PiPPlayer = {
    open, close, toggle, sync,
    get active() { return active; },
    get mode() { return mode; },
    supported,
    setAuto(v) { localStorage.setItem(LS_AUTO, v ? '1' : '0'); },
    autoEnabled
  };
  window.togglePiP = toggle;
  window.syncPiP = sync;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButtons);
  } else {
    mountButtons();
  }
})();
