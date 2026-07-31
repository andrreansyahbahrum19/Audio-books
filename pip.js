/* ═══════════════════════════════════════════════════════════════
   AUDIO BOOKS — PICTURE-IN-PICTURE MINI READER
   ───────────────────────────────────────────────────────────────
   Window floating berisi SATU BAB PENUH yang bisa di-scroll dan
   dibaca beneran — kalimat yang lagi dibacain audio ke-highlight
   dan auto-scroll ke tengah. Bukan teleprompter 3 baris.

   MODE A · Document Picture-in-Picture  (Chrome / Edge desktop 116+)
     DOM asli → teks bisa di-scroll & diklik buat lompat kalimat,
     ada pengatur ukuran font, tombol semua fungsional.

   MODE B · Canvas → Video PiP          (Safari macOS/iPadOS, Firefox)
     Halaman teks digambar ke canvas portrait lalu di-stream ke
     <video> yang masuk PiP native. Kontrol lewat Media Session OS.

   Dependensi global dari app.js:
     window.abGetState()  — state playback
     togglePlay() rewindSentence() forwardSentence() toggleMute()
     prevChapter() nextChapter() playFrom(i) showToast(msg)
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── KONFIG ───────────────────────────────────────────────── */
  const PIP_W = 460;
  const PIP_H = 640;      // default portrait — dioptimalkan buat baca
  const CANVAS_W = 660;
  const CANVAS_H = 900;   // portrait juga
  const FS_MIN = 13, FS_MAX = 28, FS_DEF = 17;
  const LS_AUTO = 'ab_pip_auto';
  const LS_FS = 'ab_pip_fs';

  /* ── STATE ────────────────────────────────────────────────── */
  let mode = null;          // 'doc' | 'video' | null
  let pipWin = null;
  let videoEl = null;
  let canvasEl = null;
  let ctx = null;
  let timerId = null;
  let coverImg = null;
  let coverSrcLoaded = null;
  let active = false;
  let opening = false;
  let refs = {};
  let renderedKey = '';     // penanda bab yang lagi ke-render (mode doc)
  let lastActiveIdx = -1;
  let userScrolling = 0;    // timestamp — jeda auto-scroll pas user scroll manual

  let fontSize = clampFs(Number(localStorage.getItem(LS_FS)) || FS_DEF);
  function clampFs(v) { return Math.min(FS_MAX, Math.max(FS_MIN, v || FS_DEF)); }

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

  /* ── BACA STATE APP ───────────────────────────────────────── */
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
      sents,
      playing: !!st.isPlaying,
      muted: !!st.isMuted,
      cover: (window._currentBookMeta && window._currentBookMeta.cover_url) || null,
      night: document.body.classList.contains('night'),
      pct: sents.length ? Math.min(100, Math.round(((si + 1) / sents.length) * 100)) : 0
    };
  }

  function call(fn, arg) {
    try { if (typeof window[fn] === 'function') return window[fn](arg); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── COVER (CORS-safe buat canvas) ────────────────────────── */
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

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#eaeae8; --surface:#f3f3f1; --surface2:#e0e0dd;
  --border:rgba(40,40,35,.13); --ink:#1c1c1a; --ink-dim:#454542; --ink-muted:#77776f;
  --accent:#5a5a52; --accent-light:rgba(90,90,82,.10); --accent-mid:rgba(90,90,82,.18);
  --fs:17px; --lh:1.72;
  color-scheme:light;
}
html.night{
  --bg:#16130e; --surface:#1f1c13; --surface2:#272318;
  --border:rgba(190,160,90,.10); --ink:#e4dcc8; --ink-dim:#9a8e78; --ink-muted:#b3a78f;
  --accent:#c09848; --accent-light:rgba(192,152,72,.11); --accent-mid:rgba(192,152,72,.22);
  color-scheme:dark;
}
html,body{height:100%;background:var(--bg)}
body{
  position:fixed; inset:0;
  font-family:'DM Sans',system-ui,-apple-system,sans-serif;
  background:var(--bg); color:var(--ink);
  display:flex; flex-direction:column; overflow:hidden;
  transition:background .3s ease,color .3s ease;
}

/* ══ HEADER ══ */
.pip-head{
  display:flex; align-items:center; gap:10px;
  padding:9px 12px; background:var(--surface);
  border-bottom:1px solid var(--border); flex-shrink:0;
}
.pip-cover{
  width:30px; height:42px; border-radius:4px; overflow:hidden; flex-shrink:0;
  background:var(--surface2); border:1px solid var(--border);
  display:flex; align-items:center; justify-content:center; font-size:15px;
}
.pip-cover img{width:100%;height:100%;object-fit:cover;display:block}
.pip-meta{min-width:0;flex:1}
.pip-title{
  font-family:'Lora',Georgia,serif; font-weight:600; font-size:13.5px;
  line-height:1.3; color:var(--ink);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.pip-chapter{
  font-size:11px; color:var(--ink-muted); margin-top:2px; letter-spacing:.01em;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.pip-badge{
  display:flex; align-items:center; gap:5px; flex-shrink:0;
  font-size:10.5px; letter-spacing:.04em; text-transform:uppercase;
  color:var(--ink-muted); padding:3px 8px 3px 6px;
  border-radius:20px; background:var(--surface2);
}
.pip-dot{width:6px;height:6px;border-radius:50%;background:var(--ink-muted);opacity:.5;flex-shrink:0}
body.is-playing .pip-badge{color:var(--accent);background:var(--accent-light)}
body.is-playing .pip-dot{background:var(--accent);opacity:1;animation:pulse 1.7s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.7)}}

/* ══ AREA BACA ══ */
.pip-read{
  flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain;
  padding:20px 22px 28px; background:var(--bg);
  scrollbar-width:thin; scrollbar-color:var(--border) transparent;
}
.pip-read::-webkit-scrollbar{width:8px}
.pip-read::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.pip-read::-webkit-scrollbar-track{background:transparent}
.pip-body{
  font-family:'Lora',Georgia,serif;
  font-size:var(--fs); line-height:var(--lh);
  color:var(--ink-muted); text-align:left; hyphens:auto;
}
.ps{
  cursor:pointer; border-radius:3px;
  transition:color .2s ease,background .2s ease;
  -webkit-box-decoration-break:clone; box-decoration-break:clone;
}
.ps:hover{background:var(--accent-light);color:var(--ink-dim)}
.ps.past{color:var(--ink-muted);opacity:.62}
.ps.active{
  color:var(--ink); font-weight:500;
  background:var(--accent-light); box-shadow:0 0 0 3px var(--accent-light);
  border-radius:3px;
}
body.is-playing .ps.active{background:var(--accent-mid);box-shadow:0 0 0 3px var(--accent-mid)}
.pip-end{
  margin-top:22px; padding-top:16px; border-top:1px solid var(--border);
  font-family:'DM Sans',sans-serif; font-size:11.5px; color:var(--ink-muted); text-align:center;
}
.pip-empty{
  height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:8px; color:var(--ink-muted); font-size:13px; text-align:center; padding:0 24px;
}
.pip-empty span{font-size:30px;opacity:.5}

/* ══ FOOTER ══ */
.pip-foot{flex-shrink:0;background:var(--surface);border-top:1px solid var(--border)}
.pip-track{height:3px;background:var(--surface2)}
.pip-fill{height:100%;width:0;background:var(--accent);transition:width .35s ease}
.pip-ctrls{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:8px 10px}
.pip-side{display:flex;align-items:center;gap:2px}
.pip-center{display:flex;align-items:center;gap:8px}
.pip-count{
  font-size:11px;color:var(--ink-muted);font-variant-numeric:tabular-nums;
  white-space:nowrap;padding-right:2px;
}
button{
  font-family:inherit;border:none;background:none;color:var(--ink-dim);cursor:pointer;
  display:flex;align-items:center;justify-content:center;border-radius:50%;
  transition:background .16s ease,color .16s ease,transform .1s ease;
}
button:hover{background:var(--accent-light);color:var(--ink)}
button:active{transform:scale(.88)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button svg{width:100%;height:100%;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.b-xs{width:24px;height:24px;padding:5px}
.b-sm{width:28px;height:28px;padding:6px}
.b-md{width:31px;height:31px;padding:7px}
.b-play{
  width:40px;height:40px;padding:11px;background:var(--accent);color:var(--bg);
  box-shadow:0 2px 7px rgba(0,0,0,.18);
}
.b-play:hover{background:var(--accent);color:var(--bg);filter:brightness(1.14)}
.b-play svg{fill:currentColor;stroke:none}
.b-fs{
  width:24px;height:24px;font-family:'Lora',Georgia,serif;font-weight:600;
  color:var(--ink-muted);border-radius:6px;
}
.b-fs.lg{font-size:15px}
.b-fs.sm{font-size:10.5px}
.b-on{color:var(--accent);background:var(--accent-light)}
.hide{display:none !important}

/* Window pendek → rapatin padding biar area baca menang */
@media (max-height:380px){
  .pip-head{padding:6px 10px}
  .pip-cover{width:24px;height:33px}
  .pip-read{padding:12px 16px 18px}
  .pip-ctrls{padding:5px 8px}
  .b-play{width:34px;height:34px;padding:9px}
}
@media (max-width:330px){
  .pip-badge,.pip-count{display:none}
  .pip-read{padding:14px 14px 20px}
}
`;

  const ICON = {
    vol: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
    mute: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
    chPrev: '<polyline points="15 18 9 12 15 6"/><line x1="6" y1="6" x2="6" y2="18"/>',
    chNext: '<polyline points="9 18 15 12 9 6"/><line x1="18" y1="6" x2="18" y2="18"/>',
    prev: '<polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>',
    next: '<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>',
    back: '<polyline points="15 3 21 3 21 9"/><line x1="21" y1="3" x2="14" y2="10"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'
  };
  const sv = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${d}</svg>`;

  const PIP_HTML = `
<div class="pip-head">
  <div class="pip-cover" id="p-cover">📖</div>
  <div class="pip-meta">
    <div class="pip-title" id="p-title">—</div>
    <div class="pip-chapter" id="p-chapter">—</div>
  </div>
  <div class="pip-badge"><span class="pip-dot"></span><span id="p-live">Jeda</span></div>
</div>

<div class="pip-read" id="p-read">
  <div class="pip-body" id="p-listen"></div>
</div>

<div class="pip-foot">
  <div class="pip-track"><div class="pip-fill" id="p-fill"></div></div>
  <div class="pip-ctrls">
    <div class="pip-side">
      <button class="b-sm" id="p-mute" title="Bisukan (M)" aria-label="Bisukan suara">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" id="p-ico-vol">${ICON.vol}</svg>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" id="p-ico-mute" class="hide">${ICON.mute}</svg>
      </button>
      <button class="b-fs sm" id="p-fsdown" title="Perkecil teks" aria-label="Perkecil teks">A</button>
      <button class="b-fs lg" id="p-fsup" title="Perbesar teks" aria-label="Perbesar teks">A</button>
    </div>

    <div class="pip-center">
      <button class="b-sm" id="p-chprev" title="Bab sebelumnya" aria-label="Bab sebelumnya">${sv(ICON.chPrev)}</button>
      <button class="b-md" id="p-prevs" title="Kalimat sebelumnya (←)" aria-label="Kalimat sebelumnya">${sv(ICON.prev)}</button>
      <button class="b-play" id="p-play" title="Putar / jeda (Space)" aria-label="Putar atau jeda">
        <svg viewBox="0 0 24 24" id="p-ico-play"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <svg viewBox="0 0 24 24" id="p-ico-pause" class="hide"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      </button>
      <button class="b-md" id="p-nexts" title="Kalimat berikutnya (→)" aria-label="Kalimat berikutnya">${sv(ICON.next)}</button>
      <button class="b-sm" id="p-chnext" title="Bab berikutnya" aria-label="Bab berikutnya">${sv(ICON.chNext)}</button>
    </div>

    <div class="pip-side">
      <span class="pip-count" id="p-count">—</span>
      <button class="b-xs" id="p-follow" title="Ikuti kalimat yang dibaca" aria-label="Ikuti kalimat yang dibaca">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/></svg>
      </button>
      <button class="b-sm" id="p-back" title="Kembali ke aplikasi" aria-label="Kembali ke aplikasi">${sv(ICON.back)}</button>
    </div>
  </div>
</div>
`;

  async function openDoc() {
    const w = Number(localStorage.getItem('ab_pip_w2')) || PIP_W;
    const h = Number(localStorage.getItem('ab_pip_h2')) || PIP_H;

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
      root: d.documentElement,
      body: d.body,
      cover: d.getElementById('p-cover'),
      title: d.getElementById('p-title'),
      chapter: d.getElementById('p-chapter'),
      live: d.getElementById('p-live'),
      read: d.getElementById('p-read'),
      listen: d.getElementById('p-listen'),
      fill: d.getElementById('p-fill'),
      count: d.getElementById('p-count'),
      icoPlay: d.getElementById('p-ico-play'),
      icoPause: d.getElementById('p-ico-pause'),
      icoVol: d.getElementById('p-ico-vol'),
      icoMute: d.getElementById('p-ico-mute'),
      btnMute: d.getElementById('p-mute'),
      btnFollow: d.getElementById('p-follow')
    };

    refs.root.style.setProperty('--fs', fontSize + 'px');
    renderedKey = '';
    lastActiveIdx = -1;

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
    on('p-fsup', () => setFont(fontSize + 1));
    on('p-fsdown', () => setFont(fontSize - 1));
    on('p-follow', () => { userScrolling = 0; scrollToActive(true); });
    on('p-back', () => { try { window.focus(); } catch (e) {} close(); });

    // Klik kalimat → lompat ke situ
    refs.listen.addEventListener('click', (e) => {
      const span = e.target.closest('.ps');
      if (!span) return;
      const i = Number(span.dataset.i);
      if (Number.isFinite(i)) { userScrolling = 0; call('playFrom', i); setTimeout(sync, 80); }
    });

    // User scroll manual → tunda auto-scroll 6 detik
    refs.read.addEventListener('wheel', () => { userScrolling = Date.now(); }, { passive: true });
    refs.read.addEventListener('touchmove', () => { userScrolling = Date.now(); }, { passive: true });

    d.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === ' ' || e.code === 'Space') { e.preventDefault(); call('togglePlay'); }
      else if (k === 'ArrowLeft') { e.preventDefault(); call('rewindSentence'); }
      else if (k === 'ArrowRight') { e.preventDefault(); call('forwardSentence'); }
      else if (k === 'm' || k === 'M') call('toggleMute');
      else if (k === '+' || k === '=') setFont(fontSize + 1);
      else if (k === '-' || k === '_') setFont(fontSize - 1);
      else return;
      setTimeout(sync, 60);
    });

    pipWin.addEventListener('resize', () => {
      try {
        localStorage.setItem('ab_pip_w2', String(pipWin.innerWidth));
        localStorage.setItem('ab_pip_h2', String(pipWin.innerHeight));
      } catch (e) {}
    });
    pipWin.addEventListener('pagehide', teardown);

    mode = 'doc';
    active = true;
    syncDoc(snap());
    setTimeout(() => scrollToActive(false), 120);
  }

  function setFont(v) {
    fontSize = clampFs(v);
    try { localStorage.setItem(LS_FS, String(fontSize)); } catch (e) {}
    if (refs.root) refs.root.style.setProperty('--fs', fontSize + 'px');
    scrollToActive(true);
  }

  function scrollToActive(smooth) {
    if (!refs.listen || !refs.read) return;
    const el = refs.listen.querySelector('.ps.active');
    if (!el) return;
    const cRect = refs.read.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const target = refs.read.scrollTop + (eRect.top - cRect.top) - (cRect.height / 2) + (eRect.height / 2);
    try {
      refs.read.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
    } catch (e) {
      refs.read.scrollTop = Math.max(0, target);
    }
  }

  function syncDoc(s) {
    if (!pipWin || !refs.title) return;

    refs.root.classList.toggle('night', s.night);
    refs.body.classList.toggle('is-playing', s.playing);

    if (refs.title.textContent !== s.title) refs.title.textContent = s.title;
    const chLabel = s.chapterIdx >= 0
      ? `Bab ${s.chapterIdx + 1}/${s.chapterTotal} · ${s.chapterTitle}`
      : 'Belum ada bab dipilih';
    if (refs.chapter.textContent !== chLabel) refs.chapter.textContent = chLabel;

    refs.live.textContent = s.playing ? 'Membaca' : 'Jeda';
    refs.fill.style.width = s.pct + '%';
    refs.count.textContent = s.sentTotal ? `${s.sentIdx + 1}/${s.sentTotal}` : '—';

    refs.icoPlay.classList.toggle('hide', s.playing);
    refs.icoPause.classList.toggle('hide', !s.playing);
    refs.icoVol.classList.toggle('hide', s.muted);
    refs.icoMute.classList.toggle('hide', !s.muted);
    refs.btnMute.classList.toggle('b-on', s.muted);
    refs.btnFollow.classList.toggle('b-on', !userScrolling);

    const wantCover = s.cover || '';
    if (refs.cover.dataset.src !== wantCover) {
      refs.cover.dataset.src = wantCover;
      refs.cover.innerHTML = wantCover ? `<img src="${esc(wantCover)}" alt="">` : '📖';
    }

    /* ── Isi bab: render ulang cuma kalau babnya ganti ── */
    const key = `${s.chapterIdx}:${s.sentTotal}:${s.chapterTitle}`;
    if (key !== renderedKey) {
      renderedKey = key;
      lastActiveIdx = -1;
      if (!s.sentTotal) {
        refs.listen.innerHTML =
          '<div class="pip-empty"><span>📖</span>Pilih bab di aplikasi buat mulai baca &amp; dengerin.</div>';
      } else {
        refs.listen.innerHTML =
          s.sents.map((t, i) => `<span class="ps" data-i="${i}">${esc(t)} </span>`).join('') +
          '<div class="pip-end">— akhir bab —</div>';
      }
    }

    /* ── Pindah highlight tanpa nge-render ulang ── */
    if (s.sentTotal && s.sentIdx !== lastActiveIdx) {
      const spans = refs.listen.children;
      const prev = refs.listen.querySelector('.ps.active');
      if (prev) { prev.classList.remove('active'); prev.classList.add('past'); }
      const el = spans[s.sentIdx];
      if (el && el.classList.contains('ps')) {
        el.classList.remove('past');
        el.classList.add('active');
      }
      // Kalimat setelah posisi aktif jangan ke-tandai 'past'
      for (let i = s.sentIdx + 1; i < spans.length; i++) {
        if (spans[i].classList && spans[i].classList.contains('past')) spans[i].classList.remove('past');
      }
      for (let i = 0; i < s.sentIdx; i++) {
        if (spans[i].classList && !spans[i].classList.contains('past')) spans[i].classList.add('past');
      }
      lastActiveIdx = s.sentIdx;

      // Auto-scroll, kecuali user baru aja scroll manual
      if (!userScrolling || Date.now() - userScrolling > 6000) {
        userScrolling = 0;
        scrollToActive(true);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     MODE B — CANVAS → VIDEO PIP (Safari / Firefox)
     ═══════════════════════════════════════════════════════════ */

  const PALETTE = {
    light: { bg: '#eaeae8', surf: '#f3f3f1', surf2: '#e0e0dd', line: 'rgba(40,40,35,.14)', ink: '#1c1c1a', dim: '#8b8b83', accent: '#5a5a52', hi: 'rgba(90,90,82,.15)' },
    dark: { bg: '#16130e', surf: '#1f1c13', surf2: '#272318', line: 'rgba(190,160,90,.14)', ink: '#e4dcc8', dim: '#8d8371', accent: '#c09848', hi: 'rgba(192,152,72,.20)' }
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

  function ellipsize(c, text, maxW) {
    let t = String(text || '');
    if (c.measureText(t).width <= maxW) return t;
    while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  // Susun kalimat jadi baris mengalir, tiap baris tau kalimat asalnya.
  function layoutLines(c, sents, maxW) {
    const out = [];
    let line = '', lineIdx = -1;
    const push = () => { if (line) { out.push({ text: line, i: lineIdx }); line = ''; } };

    for (let i = 0; i < sents.length; i++) {
      const words = String(sents[i] || '').split(/\s+/).filter(Boolean);
      if (lineIdx !== i && line) { push(); }
      lineIdx = i;
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (c.measureText(test).width <= maxW) line = test;
        else { push(); lineIdx = i; line = w; }
      }
      push();
    }
    return out;
  }

  function drawFrame() {
    if (!ctx) return;
    const s = snap();
    const P = s.night ? PALETTE.dark : PALETTE.light;
    const W = CANVAS_W, H = CANVAS_H, PAD = 34;

    ensureCover(s.cover);

    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);

    /* ── HEADER ── */
    const HH = 96;
    ctx.fillStyle = P.surf;
    ctx.fillRect(0, 0, W, HH);
    ctx.fillStyle = P.line;
    ctx.fillRect(0, HH - 1, W, 1);

    const cw = 44, chh = 62, cy = (HH - chh) / 2;
    ctx.save();
    roundRect(ctx, PAD, cy, cw, chh, 6);
    ctx.fillStyle = P.surf2;
    ctx.fill();
    ctx.clip();
    if (coverImg) {
      const ir = coverImg.width / coverImg.height, br = cw / chh;
      let dw = cw, dh = chh, dx = PAD, dy = cy;
      if (ir > br) { dw = chh * ir; dx = PAD - (dw - cw) / 2; }
      else { dh = cw / ir; dy = cy - (dh - chh) / 2; }
      try { ctx.drawImage(coverImg, dx, dy, dw, dh); } catch (e) {}
    } else {
      ctx.fillStyle = P.dim;
      ctx.font = '22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('📖', PAD + cw / 2, cy + chh / 2);
    }
    ctx.restore();

    const tx = PAD + cw + 16;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.font = '500 14px "DM Sans", system-ui, sans-serif';
    const label = s.playing ? 'MEMBACA' : 'JEDA';
    const lw = ctx.measureText(label).width;
    const pillW = lw + 32, pillX = W - PAD - pillW, pillY = cy + 8;
    roundRect(ctx, pillX, pillY, pillW, 26, 13);
    ctx.fillStyle = s.playing ? P.accent : P.surf2;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pillX + 13, pillY + 13, 4, 0, Math.PI * 2);
    ctx.fillStyle = s.playing ? P.bg : P.dim;
    ctx.fill();
    ctx.fillStyle = s.playing ? P.bg : P.dim;
    ctx.fillText(label, pillX + 24, pillY + 18);

    const metaW = W - tx - PAD - pillW - 16;
    ctx.fillStyle = P.ink;
    ctx.font = '600 21px Lora, Georgia, serif';
    ctx.fillText(ellipsize(ctx, s.title, metaW), tx, cy + 26);
    ctx.fillStyle = P.dim;
    ctx.font = '14px "DM Sans", system-ui, sans-serif';
    const chLabel = s.chapterIdx >= 0
      ? `Bab ${s.chapterIdx + 1}/${s.chapterTotal} · ${s.chapterTitle}`
      : 'Belum ada bab dipilih';
    ctx.fillText(ellipsize(ctx, chLabel, metaW), tx, cy + 49);

    /* ── AREA BACA ── */
    const FH = 62;                       // tinggi footer
    const top = HH + 26, bottom = H - FH - 20;
    const areaH = bottom - top;
    const textW = W - PAD * 2;
    const FS = 21, LHpx = Math.round(FS * 1.68);
    const maxLines = Math.max(1, Math.floor(areaH / LHpx));

    ctx.font = `${FS}px Lora, Georgia, serif`;
    const lines = layoutLines(ctx, s.sents, textW);

    if (!lines.length) {
      ctx.fillStyle = P.dim;
      ctx.font = '17px "DM Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Pilih bab di aplikasi buat mulai baca & dengerin.', W / 2, top + areaH / 2);
      ctx.textAlign = 'left';
    } else {
      // Geser jendela baris supaya kalimat aktif ada di tengah
      const firstActive = lines.findIndex(l => l.i === s.sentIdx);
      const lastActive = lines.map(l => l.i).lastIndexOf(s.sentIdx);
      const center = firstActive < 0 ? 0 : Math.round((firstActive + lastActive) / 2);
      let start = Math.max(0, Math.min(center - Math.floor(maxLines / 2), lines.length - maxLines));
      if (start < 0) start = 0;
      const shown = lines.slice(start, start + maxLines);

      // Blok highlight kalimat aktif
      let y = top + FS;
      const actIdxs = [];
      shown.forEach((l, k) => { if (l.i === s.sentIdx) actIdxs.push(k); });
      if (actIdxs.length) {
        const y0 = top + actIdxs[0] * LHpx;
        const hgt = actIdxs.length * LHpx + 6;
        ctx.fillStyle = s.playing ? P.hi : P.surf2;
        roundRect(ctx, PAD - 10, y0, textW + 20, hgt, 5);
        ctx.fill();
      }

      shown.forEach((l, k) => {
        const isActive = l.i === s.sentIdx;
        ctx.fillStyle = isActive ? P.ink : P.dim;
        ctx.font = `${isActive ? '500 ' : ''}${FS}px Lora, Georgia, serif`;
        ctx.fillText(l.text, PAD, y + k * LHpx);
      });

      // Petunjuk masih ada teks di atas / bawah
      ctx.fillStyle = P.dim;
      ctx.font = '12px "DM Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      if (start > 0) ctx.fillText('▲', W / 2, top - 8);
      if (start + maxLines < lines.length) ctx.fillText('▼', W / 2, bottom + 14);
      ctx.textAlign = 'left';
    }

    /* ── FOOTER ── */
    ctx.fillStyle = P.surf;
    ctx.fillRect(0, H - FH, W, FH);
    ctx.fillStyle = P.line;
    ctx.fillRect(0, H - FH, W, 1);

    const trackY = H - FH + 16, trackW = W - PAD * 2 - 96;
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
    ctx.font = '12px "DM Sans", system-ui, sans-serif';
    ctx.fillText('Kontrol lewat tombol media sistem', PAD, H - 14);
  }

  // setTimeout, BUKAN requestAnimationFrame — rAF dibekukan pas tab disembunyikan,
  // padahal justru itu momen PiP dipakai.
  function loop() {
    drawFrame();
    timerId = setTimeout(loop, 200);
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
      videoEl.addEventListener('leavepictureinpicture', teardown);
      videoEl.addEventListener('webkitpresentationmodechanged', () => {
        if (videoEl && videoEl.webkitPresentationMode !== 'picture-in-picture') teardown();
      });
    }

    if (!videoEl.srcObject) {
      let stream;
      try { stream = canvasEl.captureStream(6); }
      catch (e) { throw new Error('Browser ini gak bisa capture canvas — PiP gak tersedia.'); }
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
    if (timerId) clearTimeout(timerId);
    loop();
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════ */

  function teardown() {
    active = false;
    mode = null;
    if (timerId) { clearTimeout(timerId); timerId = null; }
    pipWin = null;
    refs = {};
    renderedKey = '';
    lastActiveIdx = -1;
    userScrolling = 0;
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
      if (e && e.name === 'NotAllowedError') toast('PiP butuh klik langsung — coba tekan tombolnya lagi.');
      else if (e && e.name !== 'AbortError') toast((e && e.message) || 'Gagal membuka PiP.');
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
    return v === null ? true : v === '1';
  }

  document.addEventListener('visibilitychange', () => {
    if (!supported || !autoEnabled()) return;
    const s = snap();
    if (document.hidden) {
      if (s.playing && !active) open().catch(() => {});
    } else if (active && mode === 'doc') {
      close();
    }
  });

  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.setActionHandler('enterpictureinpicture', () => { open(); }); } catch (e) {}
  }

  /* ── EXPOSE ───────────────────────────────────────────────── */
  window.PiPPlayer = {
    open, close, toggle, sync,
    get active() { return active; },
    get mode() { return mode; },
    supported,
    setAuto(v) { localStorage.setItem(LS_AUTO, v ? '1' : '0'); },
    autoEnabled,
    setFontSize: setFont,
    get fontSize() { return fontSize; }
  };
  window.togglePiP = toggle;
  window.syncPiP = sync;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButtons);
  } else {
    mountButtons();
  }
})();
