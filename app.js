// ── SUPABASE ──
const SUPA_URL = 'https://bnjbqdjognowfqqgxkpu.supabase.co';
const SUPA_KEY = 'sb_publishable_No8ZHPTXSW1XgqzjVJphMg_oYT2-H9H';
const supa = window.supabase?.createClient
  ? window.supabase.createClient(SUPA_URL, SUPA_KEY)
  : null;

// JSZip hanya dibutuhkan saat pengguna membuka EPUB, jadi jangan membebani initial load.
let jsZipLoadPromise = null;
function ensureJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jsZipLoadPromise) {
    jsZipLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      script.async = true;
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => {
        jsZipLoadPromise = null;
        reject(new Error('JSZip gagal dimuat'));
      };
      document.head.appendChild(script);
    });
  }
  return jsZipLoadPromise;
}

// ── STATE ──
let apiKey = localStorage.getItem('buku_suara_gcloud_key') || '';
// Claude API key — diload dari localStorage, bukan hardcoded
let claudeApiKey = localStorage.getItem('buku_suara_claude_key') || '';
const LS_CLAUDE_KEY = 'buku_suara_claude_key';
// Ganti dengan Worker URL lo setelah deploy (contoh: https://claude-proxy.NAMALO.workers.dev)
let CLAUDE_PROXY_URL = 'https://restless-bar-9a2d.andrreansyahbahrum.workers.dev';

function toggleClaudeVis() {
  const inp = document.getElementById('claude-key-input');
  if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
}
function saveClaudeKey() {
  const key = (document.getElementById('claude-key-input')?.value || '').trim();
  const proxy = (document.getElementById('claude-proxy-input')?.value || '').trim();
  const st = document.getElementById('claude-status');
  if (!key || !key.startsWith('sk-ant-')) {
    if (st) { st.textContent = '❌ Format key tidak valid (harus sk-ant-...)'; st.style.color = 'var(--red)'; }
    return;
  }
  if (!proxy || !proxy.startsWith('https://')) {
    if (st) { st.textContent = '❌ Worker URL harus diisi (https://...)'; st.style.color = 'var(--red)'; }
    return;
  }
  claudeApiKey = key;
  CLAUDE_PROXY_URL = proxy;
  localStorage.setItem(LS_CLAUDE_KEY, key);
  localStorage.setItem('buku_suara_claude_proxy', proxy);
  if (st) { st.textContent = '✓ Claude API key & Worker URL tersimpan'; st.style.color = 'var(--green)'; }
  showToast('Claude key tersimpan!');
}
function loadClaudeKey() {
  const savedKey = localStorage.getItem(LS_CLAUDE_KEY);
  const savedProxy = localStorage.getItem('buku_suara_claude_proxy');
  if (savedKey) {
    claudeApiKey = savedKey;
    const inp = document.getElementById('claude-key-input');
    if (inp) inp.value = savedKey;
  }
  if (savedProxy) {
    CLAUDE_PROXY_URL = savedProxy;
    const inp = document.getElementById('claude-proxy-input');
    if (inp) inp.value = savedProxy;
  }
  if (savedKey && savedProxy) {
    const st = document.getElementById('claude-status');
    if (st) { st.textContent = '✓ Claude API key & Worker aktif'; st.style.color = 'var(--green)'; }
  }
}
let selectedVoice = 'id-ID-Wavenet-A';
let selectedGender = 'FEMALE';
let selectedLangCode = 'id-ID';
let speechRate = 1.0;
let pitchVal = 0;

// ── MULTI-VOICE NARASI (karakter) ──
// Pool voice id-ID yang tersedia di UI — dipakai buat auto-assign karakter
const VOICE_POOL_ID = ['id-ID-Wavenet-A', 'id-ID-Wavenet-B', 'id-ID-Wavenet-C', 'id-ID-Wavenet-D'];
const GENDER_BY_VOICE = { 'id-ID-Wavenet-A': 'FEMALE', 'id-ID-Wavenet-B': 'MALE', 'id-ID-Wavenet-C': 'MALE', 'id-ID-Wavenet-D': 'FEMALE' };
let characterVoices = {};       // { "Nama Karakter": { voice, gender, pitchOffset } } — per buku
let charVoicesEnabled = true;   // toggle multi-voice on/off
const speakerDetectBusy = new Set(); // chIdx yang lagi diproses (anti double-call)
function currentBookKey() { return window._currentBookMeta?.id || 'local'; }

// ── FULL OFFLINE MODE: IndexedDB (epub buku + audio per-bab) ──
function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('audiobooks_offline', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books');         // key: bookId → { meta, epub: ArrayBuffer, savedAt }
      if (!db.objectStoreNames.contains('chapterAudio')) db.createObjectStore('chapterAudio'); // key: `${bookId}_${chIdx}` → { segments: ArrayBuffer[], savedAt }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
async function odbGet(store, key) {
  const db = await openOfflineDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}
async function odbPut(store, key, val) {
  const db = await openOfflineDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function odbDelete(store, key) {
  const db = await openOfflineDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function odbGetAllEntries(store) {
  const db = await openOfflineDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const keysReq = os.getAllKeys();
    const valsReq = os.getAll();
    tx.oncomplete = () => res(keysReq.result.map((k, i) => ({ key: k, value: valsReq.result[i] })));
    tx.onerror = () => rej(tx.error);
  });
}
// Cache key konsisten buat audioCache in-memory — dipakai fetchAudio() & prefetchNext()
function audioCacheKey(chIdx, sIdx) {
  const ch = chapters[chIdx]; const meta = ch?.segMeta?.[sIdx];
  const { voice, pitchOffset, speaker } = resolveSegmentVoice(meta);
  return `${chIdx}-${sIdx}|${speaker || ''}|${voice}-${speechRate}-${pitchVal + pitchOffset}`;
}
// Sync downloadedChapters Set dari IndexedDB — dipanggil tiap buku dibuka biar badge ✓ akurat walau abis reload
async function refreshDownloadedChaptersState() {
  downloadedChapters.clear();
  try {
    const entries = await odbGetAllEntries('chapterAudio');
    const prefix = `${currentBookKey()}_`;
    entries.forEach(({ key }) => {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        const idx = parseInt(key.slice(prefix.length), 10);
        if (!isNaN(idx)) downloadedChapters.add(idx);
      }
    });
  } catch(e) {}
}

let chapters = [];
let currentChapter = -1;
let currentSentence = 0;
let isMuted = false;
function toggleMute() {
  isMuted = !isMuted;
  const btn = document.getElementById('btn-mute');
  document.getElementById('icon-vol').style.display  = isMuted ? 'none'  : '';
  document.getElementById('icon-mute').style.display = isMuted ? ''      : 'none';
  btn.classList.toggle('muted', isMuted);
  if (currentAudio) currentAudio.muted = isMuted;
  pipSync();
}
let isPlaying = false;
let currentAudio = null;
const audioCache = {};
const downloadedChapters = new Set();
let dlCancelled = false;
let bookTitle = '';
let wakeLock = null;
let voiceBarOpen = false;
let textBarOpen = false;
let isNight = false;
// Reader text style
let readerFontPx = 18;
let readerLineHeight = 1.95;
let readerJustify = false;

/* ── BRIDGE UNTUK PICTURE-IN-PICTURE (pip.js) ─────────────────
   Variabel di atas dideklarasikan pakai `let` → gak nempel ke window.
   Bridge ini bikin pip.js bisa baca state playback tanpa eval.        */
window.abGetState = function () {
  return {
    bookTitle,
    chapters,
    currentChapter,
    currentSentence,
    isPlaying,
    isMuted,
    isNight
  };
};

// Dipanggil dari titik-titik perubahan state. No-op kalau PiP gak aktif.
function pipSync() {
  try { if (window.PiPPlayer) window.PiPPlayer.sync(); } catch (e) {}
}
const FS_MIN = 14, FS_MAX = 30;

// ── NIGHT MODE ──
function toggleNight() {
  isNight = !isNight;
  document.body.classList.toggle('night', isNight);
  localStorage.setItem('reader_night', isNight ? '1' : '0');
  document.querySelectorAll('button[onclick="toggleNight()"]').forEach(button => {
    button.setAttribute('aria-label', isNight ? 'Aktifkan mode terang' : 'Aktifkan mode malam');
    button.setAttribute('aria-pressed', isNight ? 'true' : 'false');
  });
  pipSync();
}

// ── EXPAND TEXT ──
function toggleExpand() {
  document.body.classList.toggle('text-expanded');
}

// ── VOICE BAR ──
function toggleVoiceBar() {
  voiceBarOpen = !voiceBarOpen;
  document.getElementById('voice-bar').classList.toggle('open', voiceBarOpen);
  if (voiceBarOpen && textBarOpen) { textBarOpen = false; document.getElementById('text-bar').classList.remove('open'); }
}

// ── TEXT BAR (ukuran teks, spasi baris, perataan) ──
function toggleTextBar() {
  textBarOpen = !textBarOpen;
  document.getElementById('text-bar').classList.toggle('open', textBarOpen);
  if (textBarOpen && voiceBarOpen) { voiceBarOpen = false; document.getElementById('voice-bar').classList.remove('open'); }
}
function applyReaderStyle() {
  const root = document.documentElement.style;
  root.setProperty('--reader-fs', readerFontPx + 'px');
  root.setProperty('--reader-lh', String(readerLineHeight));
  const panel = document.getElementById('reading-text');
  if (panel) panel.classList.toggle('justify', readerJustify);
}
function changeFont(delta) {
  readerFontPx = Math.min(FS_MAX, Math.max(FS_MIN, readerFontPx + delta));
  applyReaderStyle(); saveReaderStyle();
}
function setLineHeight(el) {
  readerLineHeight = parseFloat(el.dataset.lh);
  document.querySelectorAll('#lh-group .chip').forEach(c => c.classList.toggle('active', c === el));
  applyReaderStyle(); saveReaderStyle();
}
function setAlign(el) {
  readerJustify = el.dataset.justify === '1';
  document.querySelectorAll('#align-group .chip').forEach(c => c.classList.toggle('active', c === el));
  applyReaderStyle(); saveReaderStyle();
}
function saveReaderStyle() {
  localStorage.setItem('ab_reader_fs', readerFontPx);
  localStorage.setItem('ab_reader_lh', readerLineHeight);
  localStorage.setItem('ab_reader_justify', readerJustify ? '1' : '0');
}
function loadReaderStyle() {
  const fs = parseInt(localStorage.getItem('ab_reader_fs'), 10);
  const lh = parseFloat(localStorage.getItem('ab_reader_lh'));
  const jt = localStorage.getItem('ab_reader_justify');
  if (!isNaN(fs)) readerFontPx = Math.min(FS_MAX, Math.max(FS_MIN, fs));
  if (!isNaN(lh)) readerLineHeight = lh;
  if (jt !== null) readerJustify = jt === '1';
  // Sync UI active states
  document.querySelectorAll('#lh-group .chip').forEach(c => c.classList.toggle('active', parseFloat(c.dataset.lh) === readerLineHeight));
  document.querySelectorAll('#align-group .chip').forEach(c => c.classList.toggle('active', (c.dataset.justify === '1') === readerJustify));
  applyReaderStyle();
}

// ── SHEET ──
let sheetReturnFocus = null;
function openSheet() {
  const overlay = document.getElementById('sheet-overlay');
  const sheet = document.getElementById('bottom-sheet');
  sheetReturnFocus = document.activeElement;
  overlay.classList.add('open');
  sheet.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  sheet.setAttribute('aria-hidden', 'false');
  sheet.querySelector('.sheet-close')?.focus();
}
function closeSheet() {
  const overlay = document.getElementById('sheet-overlay');
  const sheet = document.getElementById('bottom-sheet');
  overlay.classList.remove('open');
  sheet.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  sheet.setAttribute('aria-hidden', 'true');
  if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus();
  sheetReturnFocus = null;
}

// ── WAKE LOCK ──
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch(e) {}
  }
}
async function releaseWakeLock() {
  if (wakeLock) { try { await wakeLock.release(); } catch(e) {} wakeLock = null; }
}

// ── SILENT AUDIO KEEPALIVE ──
// Loop audio senyap 1 detik → kasih sinyal ke Android/iOS "tab ini masih active audio"
// Ini yang cegah Chrome Android suspend tab saat Flip dilipet
let _silentAudio = null;
function startSilentKeepAlive() {
  if (_silentAudio) return;
  // 1 detik MP3 senyap (base64) — ukurannya ~1KB
  const SILENT_MP3 = 'data:audio/mpeg;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzACBQcm9kdWNlcgBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
  _silentAudio = new Audio(SILENT_MP3);
  _silentAudio.loop = true;
  _silentAudio.volume = 0.001; // hampir 0 tapi gak persis 0 — beberapa browser skip kalau persis 0
  _silentAudio.setAttribute('playsinline', '');
  _silentAudio.play().catch(() => {});
}
function stopSilentKeepAlive() {
  if (_silentAudio) {
    try { _silentAudio.pause(); } catch(e) {}
    _silentAudio = null;
  }
}

// ── AUDIO INTERRUPT HANDLER ──
// Handle saat app lain (Instagram video, YouTube, telepon) ambil audio focus
// Saat mereka selesai → audio books auto-resume
let _interruptedByOtherApp = false;
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    try { if (_audioCtx && _audioCtx.state === 'suspended') await _audioCtx.resume(); } catch(e) {}
    if (isPlaying) {
      await requestWakeLock();
      if (_silentAudio && _silentAudio.paused) _silentAudio.play().catch(()=>{});
      if (!currentAudio || currentAudio.ended) {
        // Mati di background → restart dari posisi terakhir
        playSentence(currentSentence, playbackSession);
      } else if (currentAudio.paused) {
        try { await currentAudio.play(); } catch(e) {}
      }
    }
  } else {
    if (isPlaying) startSilentKeepAlive();
  }
});

// MediaSession "audiofocuschange" — saat app lain interrupt audio (telepon, IG video)
// Chrome Android support ini via MediaSession
if ('mediaSession' in navigator) {
  // Detect audio being taken by another app via pause + visibilityState hidden
  // Auto-resume saat balik foreground sudah dihandle di visibilitychange di atas
}

// Fallback: monitor currentAudio pause di background
// Jika pause bukan karena user → flag sebagai interrupted → resume saat visible
function _setupInterruptRecovery(el, session) {
  let _wasPlayingBeforeInterrupt = false;
  el.addEventListener('pause', () => {
    if (session !== playbackSession || el !== currentAudio || el.ended) return;
    if (!isPlaying) return; // user yang pause, bukan interrupt
    _wasPlayingBeforeInterrupt = true;
    // Auto-resume cepat (handle kasus notif/IG reel yang sebentar)
    setTimeout(() => {
      if (session === playbackSession && isPlaying && el === currentAudio && el.paused && !el.ended && _wasPlayingBeforeInterrupt) {
        el.play().catch(() => {
          // Kalau masih blocked (IG video lagi jalan) → retry lebih lama
          setTimeout(() => {
            if (session === playbackSession && isPlaying && el === currentAudio && el.paused && !el.ended) {
              el.play().catch(()=>{});
            }
          }, 2000);
        });
      }
    }, 800);
  });
  el.addEventListener('play', () => { _wasPlayingBeforeInterrupt = false; });
}

// ── SAVE ON EXIT ──
// Force-save posisi saat tab/browser mau ditutup atau Flip dilipet agresif
window.addEventListener('pagehide', () => {
  if (currentChapter >= 0) {
    const meta = window._currentBookMeta;
    const bmKey = `bm_auto_${meta?.id || 'local'}`;
    localStorage.setItem(bmKey, JSON.stringify({
      chapter: currentChapter, sentence: currentSentence, ts: Date.now()
    }));
    // Simpan apakah sedang playing saat keluar — untuk logika auto-resume
    localStorage.setItem('ab_was_playing', isPlaying ? '1' : '0');
    localStorage.setItem('ab_exit_ts', Date.now().toString());
  }
});
window.addEventListener('beforeunload', () => {
  if (currentChapter >= 0) {
    const meta = window._currentBookMeta;
    const bmKey = `bm_auto_${meta?.id || 'local'}`;
    localStorage.setItem(bmKey, JSON.stringify({
      chapter: currentChapter, sentence: currentSentence, ts: Date.now()
    }));
    localStorage.setItem('ab_was_playing', isPlaying ? '1' : '0');
    localStorage.setItem('ab_exit_ts', Date.now().toString());
  }
});

// ── MEDIA SESSION ──
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  // Artwork dari logo app — iOS butuh ini buat tampil di lock screen
  const artwork = [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
  ];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: chapters[currentChapter]?.title || bookTitle || 'Audio Book',
    artist: bookTitle || 'Audio Books',
    album: 'Bahrum Creative Tools',
    artwork
  });
  navigator.mediaSession.setActionHandler('play', () => { if (!isPlaying) togglePlay(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (isPlaying) togglePlay(); });
  navigator.mediaSession.setActionHandler('stop', () => { stopAudio(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => rewindSentence());
  navigator.mediaSession.setActionHandler('nexttrack', () => forwardSentence());
  navigator.mediaSession.setActionHandler('seekbackward', (details) => {
    // Double tap headset back = rewind sentence
    rewindSentence();
  });
  navigator.mediaSession.setActionHandler('seekforward', (details) => {
    // Double tap headset forward = next sentence
    forwardSentence();
  });
}
function updateMediaSessionState(playing) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  // Update title tiap kalimat ganti supaya lock screen tetap sync
  if (navigator.mediaSession.metadata) {
    navigator.mediaSession.metadata.title = chapters[currentChapter]?.title || bookTitle || 'Audio Book';
  }
}

// ── API ──
const LS_KEY = 'buku_suara_gcloud_key';
function toggleApiVis() {
  const inp = document.getElementById('api-key-input');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}
function autoFillKey() {
  const saved = localStorage.getItem(LS_KEY);
  if (saved) {
    document.getElementById('api-key-input').value = saved;
    document.getElementById('btn-clear-key').style.display = 'inline';
    setApiStatus('Key tersimpan ditemukan — klik Sambungkan', 'loading');
    // Auto-connect silently
    setTimeout(() => connectApi(), 300);
  }
  if (localStorage.getItem('reader_night') === '1') { isNight = true; document.body.classList.add('night'); }
}
async function connectApi() {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) { setApiStatus('Masukkan API key dulu', 'err'); return; }
  setApiStatus('Menghubungkan...', 'loading');
  document.getElementById('btn-connect').disabled = true;
  try {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${key}`);
    if (!res.ok) { const err = await res.json().catch(()=>({error:{message:'Key tidak valid'}})); throw new Error(err.error?.message || 'Key tidak valid'); }
    apiKey = key;
    localStorage.setItem(LS_KEY, key);
    document.getElementById('btn-clear-key').style.display = 'inline';
    setApiStatus('✓ Terhubung · Google WaveNet siap', 'ok');
    document.getElementById('upload-zone').style.display = 'block';
    showApiConnected();
    showToast('Google TTS terhubung!');
  } catch(e) {
    setApiStatus('❌ ' + e.message, 'err');
    document.getElementById('btn-connect').disabled = false;
  }
}
function clearSavedKey() {
  localStorage.removeItem(LS_KEY); apiKey = '';
  document.getElementById('api-key-input').value = '';
  document.getElementById('btn-clear-key').style.display = 'none';
  document.getElementById('btn-connect').disabled = false;
  document.getElementById('upload-zone').style.display = 'none';
  setApiStatus('Key dihapus', 'loading');
  showToast('Key berhasil dihapus');
}
function showApiConnected() {
  document.getElementById('api-panel').classList.add('connected');
  document.getElementById('api-connected-badge').classList.add('show');
  document.getElementById('upload-zone').style.display = 'none'; // handled by library now
  // Handle pending actions after connect
  if (window._pendingEpub) {
    const f = window._pendingEpub; window._pendingEpub = null;
    document.getElementById('setup-screen').style.display = 'none';
    showLibrary().then(() => uploadEpubToSupabase(f));
  } else if (window._pendingBookId) {
    const id = window._pendingBookId; window._pendingBookId = null;
    document.getElementById('setup-screen').style.display = 'none';
    showLibrary().then(() => openBook(id));
  } else {
    // Just go to library
    document.getElementById('setup-screen').style.display = 'none';
    showLibrary();
  }
}
function resetApiConnection() {
  document.getElementById('api-panel').classList.remove('connected');
  document.getElementById('api-connected-badge').classList.remove('show');
  apiKey = '';
  document.getElementById('upload-zone').style.display = 'none';
  setApiStatus('', '');
}

// ── SERVICE WORKER REGISTRATION ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      console.log('SW registered:', reg.scope);
      // Listen for messages from SW (download progress)
      navigator.serviceWorker.addEventListener('message', handleSWMessage);
    } catch(e) {
      console.warn('SW registration failed:', e);
    }
  });
}

function setProgress(target, percent) {
  const element = typeof target === 'string' ? document.getElementById(target) : target;
  if (!element) return;
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
  element.style.setProperty('--progress', normalized);
}

function handleSWMessage(event) {
  const { type, chapterIdx, current, total, chunks, chapterTitle, bookTitle: bTitle, error } = event.data || {};
  if (type === 'DL_PROGRESS') {
    const pct = Math.round((current / total) * 100);
    setProgress('dl-progress-fill', pct);
    document.getElementById('dl-info').textContent = `Segmen ${current} / ${total}`;
    // Show toast if page was in background
    if (document.hidden) showToast(`Download ${pct}% — Bab ${chapterIdx + 1}`);
  }
  if (type === 'DL_COMPLETE') {
    finalizeSWDownload(chapterIdx, chunks, chapterTitle, bTitle || bookTitle);
  }
  if (type === 'DL_CANCELLED') {
    setDownloadModal(false);
    const btn = document.getElementById('btn-dl-' + chapterIdx);
    if (btn) { btn.className = 'ch-dl-btn'; btn.textContent = '⬇ MP3'; }
    showToast('Download dibatalkan');
  }
  if (type === 'DL_ERROR') {
    setDownloadModal(false);
    const btn = document.getElementById('btn-dl-' + chapterIdx);
    if (btn) { btn.className = 'ch-dl-btn'; btn.textContent = '⬇ MP3'; }
    showToast('Error: ' + error);
  }
  if (type === 'DL_STARTED') {
    setDownloadModal(true);
    setProgress('dl-progress-fill', Math.round((event.data.resumedFrom / total) * 100));
    document.getElementById('dl-info').textContent = `Melanjutkan dari segmen ${event.data.resumedFrom + 1}...`;
  }
}

async function finalizeSWDownload(chapterIdx, base64Chunks, chapterTitle, bTitle) {
  setDownloadModal(false);
  // Merge base64 chunks → single MP3 blob
  const byteArrays = base64Chunks.map(b64 => {
    const binary = atob(b64); const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  });
  const totalLen = byteArrays.reduce((a, b) => a + b.byteLength, 0);
  const merged = new Uint8Array(totalLen); let offset = 0;
  for (const arr of byteArrays) { merged.set(arr, offset); offset += arr.byteLength; }
  const blob = new Blob([merged], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = `${bTitle} - Bab ${String(chapterIdx + 1).padStart(2, '0')} - ${chapterTitle}`.replace(/[/\?%*:|"<>]/g, '-');
  a.href = url; a.download = safeName + '.mp3';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  // Simpen per-segmen ke IndexedDB — ini yang bikin bab ini bisa didengerin FULL OFFLINE
  // (bukan cuma jadi file MP3 lepas di folder Downloads)
  try {
    await odbPut('chapterAudio', `${currentBookKey()}_${chapterIdx}`, {
      segments: byteArrays.map(b => b.buffer), savedAt: Date.now()
    });
  } catch(e) { console.warn('Gagal simpan audio offline:', e); }

  downloadedChapters.add(chapterIdx);
  const btn = document.getElementById('btn-dl-' + chapterIdx);
  if (btn) { btn.className = 'ch-dl-btn done'; btn.textContent = '✓'; }
  showToast(`Bab ${chapterIdx + 1} selesai — bisa didengerin offline!`);
}
function setApiStatus(msg, cls) {
  const el = document.getElementById('api-status'); el.textContent = msg; el.className = 'field-status ' + cls;
}
function updateOfflineBadge() {
  const badge = document.getElementById('offline-badge');
  if (badge) badge.style.display = navigator.onLine ? 'none' : 'inline-block';
  if (!navigator.onLine) showToast('📴 Offline — bab yang udah didownload tetep bisa dibaca & didengerin');
}
window.addEventListener('DOMContentLoaded', initApp);

// ── UPLOAD ──
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f?.name.endsWith('.epub')) loadEpub(f); else showToast('File harus .epub');
});
fileInput.addEventListener('change', e => { if (e.target.files[0]) loadEpub(e.target.files[0]); });

// ── EPUB LOADER ──
async function loadEpub(file) {
  setStatus('Memuat EPUB...', '');
  loadCharacterVoices(); renderCharacterPanel();
  refreshDownloadedChaptersState();
  try {
    const ab = await file.arrayBuffer();
    const JSZipLib = await ensureJSZip();
    const zip = await JSZipLib.loadAsync(ab);
    const containerXml = await zip.file('META-INF/container.xml').async('text');
    const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
    const rootfilePath = containerDoc.querySelector('rootfile').getAttribute('full-path');
    const rootDir = rootfilePath.includes('/') ? rootfilePath.split('/').slice(0,-1).join('/') + '/' : '';
    const opfText = await zip.file(rootfilePath).async('text');
    const opfDoc = new DOMParser().parseFromString(opfText, 'application/xml');
    bookTitle = opfDoc.querySelector('title')?.textContent?.trim() || file.name.replace('.epub','');
    const spineItems = [...opfDoc.querySelectorAll('spine itemref')].map(el => el.getAttribute('idref'));
    const manifestMap = {};
    [...opfDoc.querySelectorAll('manifest item')].forEach(el => { manifestMap[el.getAttribute('id')] = { href: el.getAttribute('href'), type: el.getAttribute('media-type') }; });
    chapters = [];
    for (const idref of spineItems) {
      const item = manifestMap[idref];
      if (!item || !item.type?.includes('html')) continue;
      const href = rootDir + item.href;
      const zFile = zip.file(href) || zip.file(item.href);
      if (!zFile) continue;
      const html = await zFile.async('text');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      ['nav','script','style'].forEach(t => doc.querySelectorAll(t).forEach(el=>el.remove()));
      // Block-aware extraction: pertahankan struktur paragraf & heading
      const { sentences, segMeta, title } = extractChapterStructure(doc.body, chapters.length + 1);
      if (sentences.join('').length < 60) continue;
      chapters.push({ title, sentences, segMeta });
    }
    if (!chapters.length) { setStatus('Tidak ada bab yang bisa dibaca.', 'err'); return; }
    document.getElementById('book-title-top').textContent = bookTitle;
    renderSheetList();
    // Switch screens
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('reader-screen').style.display = 'flex';
    setStatus('Siap diputar');
    showToast(`"${bookTitle}" berhasil dimuat!`);
    return true; // signal success
  } catch(e) {
    console.error(e);
    setStatus('Gagal memuat: ' + e.message, 'err');
  }
}

function splitSentences(text) {
  const raw = text.match(/[^.!?؟\n]+[.!?؟\n]+/g) || [text];
  const result = []; let buf = '';
  for (const s of raw) {
    if ((buf+s).length > 400 && buf.length > 0) { result.push(buf.trim()); buf = s; }
    else buf += s;
  }
  if (buf.trim()) result.push(buf.trim());
  return result.filter(s => s.length > 3);
}

// ── BLOCK-AWARE EXTRACTION ──
// Pecah satu block teks (paragraf/heading) jadi segmen TTS, tanpa lewat batas paragraf.
const BLOCK_SEL = 'h1,h2,h3,h4,h5,h6,p,blockquote,li';
function blockToSegments(text, isHeading) {
  if (isHeading) return [text];                       // heading = 1 segmen utuh
  const raw = text.match(/[^.!?؟]+[.!?؟]+(\s|$)/g) || [text];
  const out = []; let buf = '';
  for (const s of raw) {
    if ((buf + s).length > 400 && buf) { out.push(buf.trim()); buf = s; }
    else buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(s => s.length > 1);
}

// Ekstrak satu chapter jadi { sentences[], segMeta[], title } dgn struktur paragraf+heading utuh.
// segMeta[i] = { type:'heading'|'para', paraStart:bool, paraEnd:bool } paralel dgn sentences[i].
function extractChapterStructure(body, fallbackNum) {
  const sentences = [], segMeta = [];
  let title = '';
  if (body) {
    const all = [...body.querySelectorAll(BLOCK_SEL)];
    // leaf block = block yg gak punya block lain di dalamnya (unit teks terkecil, urutan dokumen)
    const leaves = all.filter(el => !el.querySelector(BLOCK_SEL));
    for (const el of leaves) {
      const isHeading = /^h[1-6]$/.test(el.tagName.toLowerCase());
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (isHeading && !title) title = text.substring(0, 80);
      const segs = blockToSegments(text, isHeading);
      segs.forEach((seg, j) => {
        sentences.push(seg);
        segMeta.push({ type: isHeading ? 'heading' : 'para', paraStart: j === 0, paraEnd: j === segs.length - 1 });
      });
    }
  }
  // FALLBACK: EPUB tanpa block jelas → cara lama (flat), tiap segmen = paragraf sendiri
  if (!sentences.length && body) {
    const rawText = (body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim();
    splitSentences(rawText).forEach(seg => {
      sentences.push(seg);
      segMeta.push({ type: 'para', paraStart: true, paraEnd: true });
    });
  }
  if (!title) title = `Bab ${fallbackNum}`;
  return { sentences, segMeta, title };
}

// ── MULTI-VOICE NARASI: character voice persistence ──
function loadCharacterVoices() {
  try {
    const raw = localStorage.getItem(`cv_${currentBookKey()}`);
    characterVoices = raw ? JSON.parse(raw) : {};
  } catch { characterVoices = {}; }
}
function saveCharacterVoices() {
  localStorage.setItem(`cv_${currentBookKey()}`, JSON.stringify(characterVoices));
}

// Assign voice ke karakter baru — round-robin dari VOICE_POOL_ID, hindarin voice narator,
// kalau karakter lebih banyak dari pool, ulang pool dengan pitch offset biar tetep beda kuping.
function assignVoiceForCharacter(name) {
  if (characterVoices[name]) return characterVoices[name];
  const used = Object.values(characterVoices).map(v => v.voice);
  const pool = VOICE_POOL_ID.filter(v => v !== selectedVoice);
  const candidates = pool.length ? pool : VOICE_POOL_ID;
  // cari voice di pool yang paling jarang dipakai
  let best = candidates[0], bestCount = Infinity;
  for (const v of candidates) {
    const c = used.filter(u => u === v).length;
    if (c < bestCount) { best = v; bestCount = c; }
  }
  const pitchOffset = bestCount === 0 ? 0 : (bestCount % 2 === 1 ? 2.5 : -2.5) * Math.ceil(bestCount / 2);
  const assigned = { voice: best, gender: GENDER_BY_VOICE[best] || 'FEMALE', pitchOffset };
  characterVoices[name] = assigned;
  saveCharacterVoices();
  return assigned;
}

// ── MULTI-VOICE NARASI: speaker detection via Claude (reuse proxy "Ask Claude") ──
async function detectSpeakers(chIdx) {
  if (!charVoicesEnabled) return;
  if (selectedLangCode !== 'id-ID') return; // voice pool karakter cuma ada buat id-ID
  if (!claudeApiKey || !CLAUDE_PROXY_URL) return; // diem-diem aja, fallback ke narator semua
  const ch = chapters[chIdx]; if (!ch || !ch.sentences.length) return;
  const cacheKey = `sp_${currentBookKey()}_${chIdx}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const map = JSON.parse(cached); // { [i]: "Nama" }
      Object.entries(map).forEach(([i, name]) => {
        if (ch.segMeta[i]) { ch.segMeta[i].speaker = name; assignVoiceForCharacter(name); }
      });
      renderCharacterPanel();
    } catch {}
    return;
  }
  if (speakerDetectBusy.has(chIdx)) return;
  speakerDetectBusy.add(chIdx);
  try {
    const numbered = ch.sentences.map((s, i) => `${i}: ${s}`).join('\n');
    const prompt = `Ini teks sebuah bab novel, tiap baris diberi nomor. Tandai baris mana yang merupakan KALIMAT DIALOG LANGSUNG (ucapan tokoh, biasanya dalam tanda kutip) dan siapa nama tokoh yang mengucapkannya. Baris narasi biasa TIDAK perlu dimasukkan.\n\nBalas HANYA dengan JSON array, tanpa teks lain, format: [{"i":NOMOR,"speaker":"Nama Tokoh"}]. Kalau nama tokoh tidak jelas dari konteks, pakai deskripsi singkat (mis. "Lelaki tua"). Maksimal 400 baris pertama akan dianalisis.\n\nTeks:\n${numbered.slice(0, 12000)}`;
    const resp = await fetch(CLAUDE_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': claudeApiKey },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!resp.ok) throw new Error('API ' + resp.status);
    const data = await resp.json();
    let txt = (data.content || []).map(b => b.text || '').join('');
    txt = txt.trim().replace(/^```json\s*|^```\s*|```$/g, '');
    const tags = JSON.parse(txt);
    const map = {};
    tags.forEach(t => {
      if (t && ch.segMeta[t.i] && t.speaker) {
        ch.segMeta[t.i].speaker = t.speaker;
        map[t.i] = t.speaker;
        assignVoiceForCharacter(t.speaker);
      }
    });
    localStorage.setItem(cacheKey, JSON.stringify(map));
    renderCharacterPanel();
  } catch (e) {
    console.warn('detectSpeakers gagal, fallback semua narator:', e.message);
  } finally {
    speakerDetectBusy.delete(chIdx);
  }
}

// Render panel "Karakter" di voice-bar — daftar tokoh kedetek + selector voice per tokoh
function renderCharacterPanel() {
  const row = document.getElementById('character-voices-row');
  const list = document.getElementById('character-voice-list');
  if (!row || !list) return;
  const names = Object.keys(characterVoices);
  if (!names.length) { row.style.display = 'none'; return; }
  row.style.display = '';
  const escAttr = s => escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  list.innerHTML = names.map(name => {
    const cv = characterVoices[name];
    const opts = VOICE_POOL_ID.map(v => `<option value="${v}" ${v === cv.voice ? 'selected' : ''}>${v.replace('id-ID-','')} ${GENDER_BY_VOICE[v]==='FEMALE'?'♀':'♂'}</option>`).join('');
    return `<div class="char-voice-item"><span class="char-voice-name">${escHtml(name)}</span><select data-char="${escAttr(name)}" onchange="reassignCharacterVoice(this.dataset.char, this.value)">${opts}</select></div>`;
  }).join('');
}
function reassignCharacterVoice(name, voice) {
  characterVoices[name] = { voice, gender: GENDER_BY_VOICE[voice] || 'FEMALE', pitchOffset: characterVoices[name]?.pitchOffset || 0 };
  saveCharacterVoices();
  Object.keys(audioCache).forEach(k => { if (k.includes(`|${name}|`)) { URL.revokeObjectURL(audioCache[k]); delete audioCache[k]; } });
  if (isPlaying) { stopAudio(); startPlaying(); }
}
function toggleCharVoices() {
  charVoicesEnabled = !charVoicesEnabled;
  localStorage.setItem('ab_charvoices', charVoicesEnabled ? '1' : '0');
  const btn = document.getElementById('char-voices-toggle');
  if (btn) btn.classList.toggle('active', charVoicesEnabled);
  showToast(charVoicesEnabled ? 'Multi-voice karakter: ON' : 'Multi-voice karakter: OFF');
  Object.keys(audioCache).forEach(k => { URL.revokeObjectURL(audioCache[k]); delete audioCache[k]; });
  if (isPlaying) { stopAudio(); startPlaying(); }
}

// ── CHAPTER SHEET LIST ──
function renderSheetList() {
  const list = document.getElementById('sheet-list');
  list.innerHTML = '';
  chapters.forEach((ch, i) => {
    const el = document.createElement('div');
    el.className = 'ch-item'; el.id = `ch-item-${i}`;
    const isDone = downloadedChapters.has(i);
    el.innerHTML = `
      <div class="ch-num-badge">${String(i+1).padStart(2,'0')}</div>
      <div class="ch-item-info" onclick="chapterClick(${i})">
        <div class="ch-item-title">${escHtml(ch.title)}</div>
        <div class="ch-item-count">${ch.sentences.length} segmen</div>
      </div>
      <button class="ch-dl-btn ${isDone?'done':''}" id="btn-dl-${i}" onclick="downloadChapter(${i},event)">${isDone?'✓':'⬇ MP3'}</button>
    `;
    list.appendChild(el);
  });
}

function chapterClick(i) {
  closeSheet();
  stopAudio(); loadChapter(i); startPlaying();
}

function setActiveChapter(idx) {
  document.querySelectorAll('.ch-item').forEach((el, i) => el.classList.toggle('active', i === idx));
  document.getElementById(`ch-item-${idx}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function loadChapter(idx) {
  if (idx < 0 || idx >= chapters.length) return;
  currentChapter = idx; currentSentence = 0;
  setActiveChapter(idx);
  document.getElementById('chapter-tag-top').textContent = `Bab ${idx+1} / ${chapters.length}`;
  saveProgress();
  document.getElementById('ch-label-btn').textContent = `Bab ${idx+1}`;
  renderTextPanel(); updateProgress();
  detectSpeakers(idx); // async, gak nge-block — hasil nyusul & auto-apply pas ready
}

// ── DOWNLOAD ──
async function downloadChapter(chIdx, e) {
  e.stopPropagation();
  // Klik lagi pas udah done → tawarin hapus offline data (bukan re-download)
  if (downloadedChapters.has(chIdx)) {
    if (confirm(`Hapus audio offline Bab ${chIdx+1}? File MP3 yang udah kedownload ke Downloads gak kehapus, cuma cache offline di app-nya aja.`)) {
      await odbDelete('chapterAudio', `${currentBookKey()}_${chIdx}`).catch(()=>{});
      downloadedChapters.delete(chIdx);
      const btn = document.getElementById(`btn-dl-${chIdx}`);
      if (btn) { btn.className = 'ch-dl-btn'; btn.textContent = '⬇ MP3'; }
      showToast(`Cache offline Bab ${chIdx+1} dihapus`);
    }
    return;
  }
  if (!apiKey) { showToast('Sambungkan API key dulu'); return; }
  const ch = chapters[chIdx]; if (!ch) return;
  const btn = document.getElementById(`btn-dl-${chIdx}`);
  btn.className = 'ch-dl-btn loading'; btn.textContent = '...';
  document.getElementById('dl-chapter-name').textContent = `Bab ${chIdx+1}: ${ch.title}`;
  setProgress('dl-progress-fill', 0);
  document.getElementById('dl-info').textContent = 'Memulai...';

  // Resolve input SSML + voice per segmen sebelum download (biar narasi hasil download
  // juga kebagian suara karakter + prosody koma/tanya/seru, bukan cuma pas playback live)
  const segInputs = ch.sentences.map((s, i) => buildInputSSML(s, ch.segMeta?.[i] || { type: 'para', paraStart: true, paraEnd: true }));
  const segVoices = ch.sentences.map((s, i) => resolveSegmentVoice(ch.segMeta?.[i]));

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'START_DOWNLOAD',
      payload: { chapterIdx: chIdx, segInputs, segVoices, apiKey, speed: speechRate, pitch: pitchVal, bookTitle, chapterTitle: ch.title }
    });
    showToast('Download dimulai — bisa pindah tab!');
  } else {
    setDownloadModal(true);
    const mp3Chunks = []; const total = ch.sentences.length;
    for (let i = 0; i < total; i++) {
      setProgress('dl-progress-fill', Math.round((i / total) * 100));
      document.getElementById('dl-info').textContent = `Segmen ${i+1} / ${total}`;
      try { mp3Chunks.push(await fetchAudioRaw(segInputs[i], segVoices[i].voice, segVoices[i].gender, segVoices[i].pitchOffset)); }
      catch(err) { setDownloadModal(false); btn.className = 'ch-dl-btn'; btn.textContent = '⬇ MP3'; showToast('Gagal: ' + err.message); return; }
    }
    setDownloadModal(false);
    const totalLen = mp3Chunks.reduce((a,b) => a + b.byteLength, 0);
    const merged = new Uint8Array(totalLen); let offset = 0;
    for (const chunk of mp3Chunks) { merged.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
    const blob = new Blob([merged], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = `${bookTitle} - Bab ${String(chIdx+1).padStart(2,'0')} - ${ch.title}`.replace(/[/\\?%*:|"<>]/g,'-');
    a.href = url; a.download = `${safeName}.mp3`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    // Simpen per-segmen ke IndexedDB juga — biar offline playback jalan di browser tanpa SW
    try {
      await odbPut('chapterAudio', `${currentBookKey()}_${chIdx}`, {
        segments: mp3Chunks, savedAt: Date.now()
      });
    } catch(err) { console.warn('Gagal simpan audio offline:', err); }

    downloadedChapters.add(chIdx);
    btn.className = 'ch-dl-btn done'; btn.textContent = '✓';
    showToast(`Bab ${chIdx+1} selesai — bisa didengerin offline!`);
  }
}
function cancelDownload() {
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    const chIdx = parseInt(document.getElementById('dl-chapter-name').dataset.idx || 0);
    navigator.serviceWorker.controller.postMessage({ type: 'CANCEL_DOWNLOAD', payload: { chapterIdx: chIdx } });
  }
  dlCancelled = true;
  setDownloadModal(false);
}

// ── TTS ──
// Builder SSML: intonasi sesuai posisi kalimat dalam struktur paragraf/heading
function buildInputSSML(text, meta) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Jeda pendek di koma/titik-koma — napas natural di tengah kalimat panjang
  const withCommaBreaks = s => esc(s).replace(/([,;])(\s)/g, '$1<break time="150ms"/>$2');
  const isQuestion = /\?\s*$/.test(text.trim());
  const isExclaim = /!\s*$/.test(text.trim());
  const hasComma = /[,;]/.test(text);

  if (meta.type === 'heading') {
    // Judul bab: emphasis + jeda panjang setelah dibaca (terasa seperti judul diumumkan)
    return { ssml: `<speak><emphasis level="moderate">${esc(text)}</emphasis><break time="900ms"/></speak>` };
  }

  // Bungkus prosody kalau kalimat tanya/seru — intonasi lebih hidup
  let bodyOpen = '', bodyClose = '';
  if (isQuestion) { bodyOpen = '<prosody pitch="+3st">'; bodyClose = '</prosody>'; }
  else if (isExclaim) { bodyOpen = '<prosody rate="106%" volume="+2dB">'; bodyClose = '</prosody>'; }

  const needsSSML = isQuestion || isExclaim || hasComma || meta.paraEnd;
  if (!needsSSML) return { text }; // kalimat plain di tengah paragraf: hemat quota, gak perlu SSML

  const inner = hasComma ? withCommaBreaks(text) : esc(text);
  const tail = meta.paraEnd ? '<break time="450ms"/>' : ''; // jeda napas antar-paragraf
  return { ssml: `<speak>${bodyOpen}${inner}${bodyClose}${tail}</speak>` };
}
async function fetchAudioRaw(textOrInput, voiceOverride, genderOverride, pitchOffset) {
  // backward-compat: string → {text}, object → as-is ({text} atau {ssml})
  const ttsInput = typeof textOrInput === 'string' ? { text: textOrInput } : textOrInput;
  const voice = voiceOverride || selectedVoice;
  const gender = genderOverride || selectedGender;
  const effectivePitch = Math.max(-20, Math.min(20, pitchVal + (pitchOffset || 0)));
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: ttsInput, voice: { languageCode: selectedLangCode, name: voice, ssmlGender: gender }, audioConfig: { audioEncoding: 'MP3', speakingRate: speechRate, pitch: effectivePitch, effectsProfileId: ['headphone-class-device'] } })
  });
  if (!res.ok) {
    const err = await res.json().catch(()=>({error:{message:'TTS error'}}));
    const msg = err.error?.message || 'TTS error';
    // Fallback: kalau voice gak ada, balik ke default voice otomatis (cuma buat voice narator utama)
    const defaultFallback = selectedLangCode === 'en-US' ? 'en-US-Wavenet-C' : 'id-ID-Wavenet-A';
    if (/does not exist|misspelled|not found/i.test(msg) && voice === selectedVoice && selectedVoice !== defaultFallback) {
      const badVoice = selectedVoice;
      selectedVoice = defaultFallback; selectedGender = 'FEMALE';
      document.querySelectorAll('.chip[data-voice]').forEach(c => c.classList.toggle('active', c.dataset.voice === defaultFallback));
      saveSettings();
      const shortName = badVoice.replace(`${selectedLangCode}-`,'');
      showToast(`Suara ${shortName} gak tersedia — pakai default`);
      // retry sekali dengan voice valid
      const res2 = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: ttsInput, voice: { languageCode: selectedLangCode, name: selectedVoice, ssmlGender: selectedGender }, audioConfig: { audioEncoding: 'MP3', speakingRate: speechRate, pitch: effectivePitch, effectsProfileId: ['headphone-class-device'] } })
      });
      if (!res2.ok) { const e2 = await res2.json().catch(()=>({error:{message:'TTS error'}})); throw new Error(e2.error?.message || 'TTS error'); }
      const d2 = await res2.json();
      const b2 = atob(d2.audioContent); const by2 = new Uint8Array(b2.length);
      for (let i = 0; i < b2.length; i++) by2[i] = b2.charCodeAt(i);
      return by2.buffer;
    }
    throw new Error(msg);
  }
  const data = await res.json();
  const binary = atob(data.audioContent); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Resolve voice/gender/pitchOffset efektif buat satu segmen (narator vs karakter)
function resolveSegmentVoice(meta) {
  if (charVoicesEnabled && selectedLangCode === 'id-ID' && meta?.speaker && characterVoices[meta.speaker]) {
    const cv = characterVoices[meta.speaker];
    return { voice: cv.voice, gender: cv.gender, pitchOffset: cv.pitchOffset || 0, speaker: meta.speaker };
  }
  return { voice: selectedVoice, gender: selectedGender, pitchOffset: 0, speaker: null };
}
async function fetchAudio(chIdx, sIdx) {
  const ch = chapters[chIdx];
  const text = ch?.sentences[sIdx]; if (!text) return null;
  const meta = ch.segMeta?.[sIdx];
  const { voice, gender, pitchOffset, speaker } = resolveSegmentVoice(meta);
  const cacheKey = `${chIdx}-${sIdx}|${speaker || ''}|${voice}-${speechRate}-${pitchVal + pitchOffset}`;
  if (audioCache[cacheKey]) return audioCache[cacheKey];

  // Offline-first: kalau bab ini udah didownload, pakai audio lokal — gak perlu internet sama sekali
  try {
    const offline = await odbGet('chapterAudio', `${currentBookKey()}_${chIdx}`);
    if (offline?.segments?.[sIdx]) {
      const blob = new Blob([offline.segments[sIdx]], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      audioCache[cacheKey] = url;
      return url;
    }
  } catch(e) { /* IndexedDB gak ada / gagal — lanjut coba network */ }

  if (!navigator.onLine) {
    throw new Error('Lagi offline & bab ini belum di-download. Download dulu pas ada sinyal ya.');
  }

  // Playback pakai SSML kalau ada metadata (intonasi paragraf + heading + koma/tanya/seru)
  const ttsInput = meta ? buildInputSSML(text, meta) : { text };
  let raw;
  try {
    raw = await fetchAudioRaw(ttsInput, voice, gender, pitchOffset);
  } catch(e) {
    // Fallback: kalau SSML gagal (mis. voice gak support), coba plain text
    if (ttsInput.ssml) { raw = await fetchAudioRaw({ text }, voice, gender, pitchOffset); }
    else throw e;
  }
  const blob = new Blob([raw], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  audioCache[cacheKey] = url; return url;
}

// ── PLAYBACK ENGINE — Background-safe, gapless, iOS+Android ──
let playbackSession = 0;
let _audioCtx = null;

// Lazy-init AudioContext dari user gesture — required by iOS
function getAudioContext() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(()=>{});
  return _audioCtx;
}

// Decode blob URL ke AudioBuffer (untuk prefetch & gapless)
const decodedCache = {}; // cacheKey -> AudioBuffer

async function decodeAudioUrl(url, cacheKey) {
  if (decodedCache[cacheKey]) return decodedCache[cacheKey];
  const ctx = getAudioContext();
  const res = await fetch(url);
  const ab = await res.arrayBuffer();
  const buf = await ctx.decodeAudioData(ab);
  decodedCache[cacheKey] = buf;
  return buf;
}

function configureAudioEl(el) {
  el.setAttribute('playsinline', '');
  el.setAttribute('x-webkit-airplay', 'allow');
  el.preload = 'auto';
  return el;
}

function killCurrentAudio() {
  playbackSession++;
  if (currentAudio) {
    const old = currentAudio;
    old.onended = null; old.onerror = null; old.onpause = null;
    try { old.pause(); } catch(e) {}
    try { old.removeAttribute('src'); old.load(); } catch(e) {}
    // Jangan remove dari DOM — recycle element yang sama
  } else {
    // Buat sekali, pakai terus
    currentAudio = configureAudioEl(document.createElement('audio'));
    currentAudio.muted = isMuted;
    document.body.appendChild(currentAudio);
  }
}

async function playFrom(idx) {
  if (currentChapter < 0) return;
  // Resume AudioContext dari user gesture
  try { getAudioContext(); } catch(e) {}
  killCurrentAudio();
  currentSentence = idx;
  renderTextPanel(idx); updateProgress();
  const session = playbackSession;
  isPlaying = true;
  setPlayState('loading');
  setupMediaSession(); updateMediaSessionState(true);
  requestWakeLock();
  startSilentKeepAlive();
  await playSentence(idx, session);
}

// Alias supaya kode lama yang manggil startPlaying tetap jalan
function startPlaying() { return playFrom(currentSentence); }

async function playSentence(idx, session) {
  if (session === undefined) session = playbackSession;
  if (session !== playbackSession || !isPlaying) return;

  const ch = chapters[currentChapter];
  if (!ch || idx >= ch.sentences.length) {
    if (currentChapter < chapters.length - 1) {
      loadChapter(currentChapter + 1);
      await playSentence(0, session);
    } else {
      isPlaying = false; setPlayState('idle'); setStatus('Selesai dibaca 🎉');
      renderTextPanel(-1); updateMediaSessionState(false); releaseWakeLock();
      stopSilentKeepAlive();
    }
    return;
  }

  currentSentence = idx; updateProgress();
  autoBookmark(currentChapter, idx);
  if (idx === 0 || !document.getElementById(`s-${idx}`)) {
    renderTextPanel(idx);
  } else {
    updateActiveSentence(idx);
  }
  const bmKey = `bm_auto_${window._currentBookMeta?.id || 'local'}`;
  localStorage.setItem(bmKey, JSON.stringify({ chapter: currentChapter, sentence: idx, ts: Date.now() }));
  // Simpan juga sebagai last session — buat auto-resume saat app reload
  if (window._currentBookMeta?.id) {
    localStorage.setItem('ab_last_session', JSON.stringify({
      bookId: window._currentBookMeta.id,
      chapter: currentChapter,
      sentence: idx,
      ts: Date.now()
    }));
  }
  if (idx % 3 === 0) saveProgress();
  setStatus('', 'fetching'); setPlayState('loading');

  // Fetch URL untuk kalimat ini
  let url;
  try { url = await fetchAudio(currentChapter, idx); }
  catch(e) {
    if (session !== playbackSession) return;
    isPlaying = false; setPlayState('idle'); setStatus(e.message, 'err'); showToast(e.message); return;
  }

  if (session !== playbackSession || !isPlaying) return;

  // Pre-fetch 3 kalimat ke depan (background, non-blocking)
  prefetchNext(currentChapter, idx + 1);
  prefetchNext(currentChapter, idx + 2);
  prefetchNext(currentChapter, idx + 3);

  // Pakai audio element yang SAMA — cukup ganti src
  // Ini yang penting: Chrome gak anggap audio "selesai" kalau element-nya persist
  const el = currentAudio;
  el.src = url;
  el.load();

  el.onended = () => {
    if (session === playbackSession && isPlaying && el === currentAudio) {
      playSentence(idx + 1, session);
    }
  };
  el.onerror = () => {
    if (session === playbackSession && isPlaying && el === currentAudio) {
      setStatus('Error audio', 'err'); isPlaying = false; setPlayState('idle');
    }
  };

  // Auto-resume kalau di-pause OS (Flip fold, interrupt dari app lain)
  el.onpause = null; // reset dulu biar gak double
  _setupInterruptRecovery(el, session);

  try { await el.play(); }
  catch(e) {
    // Autoplay blocked — tunggu visibilitychange untuk resume
    return;
  }

  if (el !== currentAudio || session !== playbackSession || !isPlaying) {
    try { el.pause(); } catch(e) {}
    return;
  }
  setPlayState('play'); setStatus('', 'speaking'); updateMediaSessionState(true);
}

function prefetchNext(chIdx, sIdx) {
  const ch = chapters[chIdx]; if (!ch || sIdx >= ch.sentences.length) return;
  const key = audioCacheKey(chIdx, sIdx);
  if (!audioCache[key]) fetchAudio(chIdx, sIdx).catch(()=>{});
}

function togglePlay() {
  if (currentChapter < 0) { showToast('Pilih bab dulu'); return; }
  if (isPlaying) {
    isPlaying = false;
    try { currentAudio && currentAudio.pause(); } catch(e) {}
    setPlayState('idle'); setStatus('Dijeda');
    updateMediaSessionState(false); releaseWakeLock();
    saveProgress();
  } else {
    if (currentAudio && currentAudio.src && currentAudio.currentTime > 0 && !currentAudio.ended) {
      isPlaying = true;
      const session = playbackSession;
      const el = currentAudio;
      el.onended = () => { if (session === playbackSession && isPlaying && el === currentAudio) playSentence(currentSentence + 1, session); };
      el.play().catch(()=>{});
      setPlayState('play'); setStatus('', 'speaking'); updateMediaSessionState(true); requestWakeLock();
    } else {
      playFrom(currentSentence);
    }
  }
}

function stopAudio() {
  isPlaying = false;
  killCurrentAudio();
  stopSilentKeepAlive();
  setPlayState('idle'); updateMediaSessionState(false); releaseWakeLock();
}

function forwardSentence() {
  const max = (chapters[currentChapter]?.sentences.length || 1) - 1;
  playFrom(Math.min(currentSentence + 1, max));
}
function rewindSentence() {
  playFrom(Math.max(currentSentence - 1, 0));
}
function prevChapter() { if (currentChapter > 0) { stopAudio(); loadChapter(currentChapter - 1); playFrom(0); } }
function nextChapter() { if (currentChapter < chapters.length - 1) { stopAudio(); loadChapter(currentChapter + 1); playFrom(0); } }

// ── RENDER ──
// Full render: dipanggil saat ganti bab atau pertama load
function renderTextPanel(activeIdx = currentSentence) {
  const panel = document.getElementById('reading-text');
  if (currentChapter < 0 || !chapters[currentChapter]) {
    panel.innerHTML = '<div class="reading-empty">Pilih bab untuk mulai membaca &amp; mendengarkan</div>'; return;
  }
  const ch = chapters[currentChapter];
  const sents = ch.sentences;
  const meta = ch.segMeta;
  const spanFor = (s, i) => {
    let cls = 'sentence-wrap';
    if (i < activeIdx) cls += ' past';
    if (i === activeIdx) cls += ' active';
    return `<span class="${cls}" id="s-${i}" data-idx="${i}">${escHtml(s)} </span>`;
  };
  if (!meta || meta.length !== sents.length) {
    panel.innerHTML = sents.map(spanFor).join('');
  } else {
    let html = '', openPara = false;
    sents.forEach((s, i) => {
      const m = meta[i];
      if (m.type === 'heading') {
        if (openPara) { html += '</p>'; openPara = false; }
        html += `<h2 class="reader-head">${spanFor(s, i)}</h2>`;
      } else {
        if (openPara && m.paraStart) { html += '</p>'; openPara = false; }
        if (!openPara) { html += '<p class="reader-para">'; openPara = true; }
        html += spanFor(s, i);
        if (m.paraEnd) { html += '</p>'; openPara = false; }
      }
    });
    if (openPara) html += '</p>';
    panel.innerHTML = html;
  }
  scrollToSentence(activeIdx);
  // Restore bookmark highlight setelah DOM direbuild
  restoreBookmarkHighlight();
}

// Restore bookmark highlight dari localStorage setelah render
function restoreBookmarkHighlight() {
  const meta = window._currentBookMeta;
  const bmKey = `bm_${meta?.id || 'local'}`;
  try {
    const bm = JSON.parse(localStorage.getItem(bmKey) || 'null');
    if (bm && bm.chapter === currentChapter && bm.sentence >= 0) {
      const el = document.getElementById(`s-${bm.sentence}`);
      if (el) el.classList.add('bookmarked');
    }
  } catch(e) {}
}
// Dipanggil setiap kalimat saat playback berjalan
function updateActiveSentence(idx) {
  const prev = document.querySelector('.sentence-wrap.active');
  if (prev) {
    prev.classList.remove('active');
    prev.classList.add('past');
  }
  const el = document.getElementById(`s-${idx}`);
  if (el) el.classList.add('active');
  scrollToSentence(idx);
  // Pastiin bookmark highlight gak hilang saat update active
  restoreBookmarkHighlight();
  pipSync();
}

// Scroll container ke kalimat aktif — manual, reliable di Android WebView kecil
function scrollToSentence(idx) {
  if (idx < 0) return;
  setTimeout(() => {
    const el = document.getElementById(`s-${idx}`);
    const container = document.getElementById('reading-area');
    if (!el || !container) return;
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const offset = elRect.top - containerRect.top + container.scrollTop;
    const center = offset - (container.clientHeight / 2) + (elRect.height / 2);
    container.scrollTo({ top: Math.max(0, center), behavior: 'smooth' });
  }, 80);
}

function updateProgress() {
  if (currentChapter < 0) return;
  const total = chapters[currentChapter]?.sentences.length || 1;
  const pct = Math.round((currentSentence / total) * 100);
  setProgress('progress-fill', pct);
  document.getElementById('progress-label').textContent = `${currentSentence+1}/${total}`;
  pipSync();
}

function setPlayState(state) {
  const btn = document.getElementById('btn-play');
  const ip = document.getElementById('icon-play');
  const ipu = document.getElementById('icon-pause');
  btn.classList.remove('loading-state');
  if (state==='play') { ip.style.display='none'; ipu.style.display='block'; }
  else if (state==='loading') { ip.style.display='none'; ipu.style.display='none'; btn.classList.add('loading-state'); }
  else { ip.style.display='block'; ipu.style.display='none'; }
  pipSync();
}

function setStatus(msg, cls='') {
  const el = document.getElementById('status-line'); el.className = 'status-line';
  if (cls==='speaking') el.innerHTML = `<span class="dot speaking"></span>Sedang membaca...`;
  else if (cls==='fetching') el.innerHTML = `<span class="dot fetching"></span>Mengambil audio...`;
  else el.textContent = msg || '';
}

function saveSettings() {
  localStorage.setItem('ab_voice', selectedVoice);
  localStorage.setItem('ab_gender', selectedGender);
  localStorage.setItem('ab_lang', selectedLangCode);
  localStorage.setItem('ab_speed', speechRate);
  localStorage.setItem('ab_pitch', pitchVal);
}
function loadSettings() {
  const cvOn = localStorage.getItem('ab_charvoices');
  if (cvOn !== null) charVoicesEnabled = cvOn === '1';
  document.getElementById('char-voices-toggle')?.classList.toggle('active', charVoicesEnabled);
  const v = localStorage.getItem('ab_voice');
  const g = localStorage.getItem('ab_gender');
  const l = localStorage.getItem('ab_lang');
  const s = localStorage.getItem('ab_speed');
  const p = localStorage.getItem('ab_pitch');
  // Restore language first
  if (l) {
    selectedLangCode = l;
    const isEN = l === 'en-US';
    document.querySelectorAll('.chip[data-lang]').forEach(c => c.classList.toggle('active', c.dataset.lang === l));
    document.getElementById('voice-chips-id').style.display = isEN ? 'none' : '';
    document.getElementById('voice-chips-en').style.display = isEN ? '' : 'none';
  }
  if (v) { selectedVoice = v; selectedGender = g || 'FEMALE'; }
  if (s) { speechRate = parseFloat(s); document.getElementById('speed-slider').value = speechRate; document.getElementById('speed-val').textContent = speechRate.toFixed(2).replace(/\.?0+$/,'') + '×'; }
  if (p) { pitchVal = parseFloat(p); document.getElementById('pitch-slider').value = pitchVal; document.getElementById('pitch-val').textContent = (pitchVal>=0?'+':'') + pitchVal; }
  // Set active voice chip
  if (v) {
    document.querySelectorAll('.chip[data-voice]').forEach(c => {
      c.classList.toggle('active', c.dataset.voice === v);
    });
  }
}
function selectLang(el) {
  selectedLangCode = el.dataset.lang;
  document.querySelectorAll('.chip[data-lang]').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  const isEN = selectedLangCode === 'en-US';
  document.getElementById('voice-chips-id').style.display = isEN ? 'none' : '';
  document.getElementById('voice-chips-en').style.display = isEN ? '' : 'none';
  // Set default voice for new language
  const defaultVoice = isEN ? 'en-US-Wavenet-C' : 'id-ID-Wavenet-A';
  const defaultGender = isEN ? 'FEMALE' : 'FEMALE';
  selectedVoice = defaultVoice; selectedGender = defaultGender;
  document.querySelectorAll('.chip[data-voice]').forEach(c => c.classList.toggle('active', c.dataset.voice === defaultVoice));
  Object.keys(audioCache).forEach(k => { URL.revokeObjectURL(audioCache[k]); delete audioCache[k]; });
  saveSettings();
  if (isPlaying) { stopAudio(); startPlaying(); }
}
function selectVoice(el) {
  selectedVoice = el.dataset.voice; selectedGender = el.dataset.gender;
  document.querySelectorAll('.chip[data-voice]').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  Object.keys(audioCache).forEach(k => { URL.revokeObjectURL(audioCache[k]); delete audioCache[k]; });
  saveSettings();
  if (isPlaying) { stopAudio(); startPlaying(); }
}
function updateSpeed(val) { speechRate = parseFloat(val); document.getElementById('speed-val').textContent = speechRate.toFixed(2).replace(/\.?0+$/,'') + '×'; saveSettings(); }
function updatePitch(val) { pitchVal = parseFloat(val); document.getElementById('pitch-val').textContent = (pitchVal>=0?'+':'') + pitchVal; saveSettings(); }

function showToast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.remove('show'), 3500);
}
function setDownloadModal(open) {
  const modal = document.getElementById('dl-modal');
  modal.classList.toggle('show', open);
  modal.setAttribute('aria-hidden', open ? 'false' : 'true');
}
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── NATIVE TEXT SELECTION → BUBBLE POPUP ──
let lastSelText = '', lastSelRect = null;
let selTimer = null;

function checkSel() {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const sel = window.getSelection();
    const text = (sel?.toString() || '').trim();
    const ra = document.getElementById('reading-area');
    if (!text || text.length < 2 || !ra?.contains(sel?.anchorNode)) { hideSelBubble(); return; }
    lastSelText = text;
    lastSelRect = sel.getRangeAt(0).getBoundingClientRect();
    posSelBubble(lastSelRect);
  }, 500); // 500ms — biar native Android toolbar keburu muncul dulu, bubble lo muncul di bawahnya
}

function posSelBubble(rect) {
  const bub = document.getElementById('sel-bubble');
  const bW = 210;
  let x = rect.left + rect.width / 2 - bW / 2;
  let y = rect.bottom + 12;
  x = Math.max(8, Math.min(x, window.innerWidth - bW - 8));
  if (y + 50 > window.innerHeight - 100) y = rect.top - 54;
  // Tail ikut posisi seleksi
  const tailLeft = Math.min(Math.max(rect.left + rect.width / 2 - x, 16), bW - 24);
  bub.style.left = x + 'px'; bub.style.top = y + 'px';
  bub.style.setProperty('--tail-left', tailLeft + 'px');
  bub.classList.add('show');
}

function hideSelBubble() {
  document.getElementById('sel-bubble')?.classList.remove('show');
}

function closeDefBubble() {
  document.getElementById('def-bubble')?.classList.remove('show');
}

// Alias untuk onclick di HTML
const selBookmark = () => doBookmark();
const selCariArti = () => doCariArti();
async function doBookmark() {
  hideSelBubble();

  // Tentukan sentence index SEBELUM clear selection
  let bmSentIdx = currentSentence;
  if (lastSelText && chapters[currentChapter]) {
    const sents = chapters[currentChapter].sentences;
    const found = sents.findIndex(s => s.includes(lastSelText.trim().slice(0, 30)));
    if (found >= 0) bmSentIdx = found;
  }

  // Baru clear selection
  window.getSelection()?.removeAllRanges();

  // Hapus highlight bookmark lama
  document.querySelectorAll('.sentence-wrap.bookmarked')
    .forEach(el => el.classList.remove('bookmarked'));

  // Highlight kalimat yang di-bookmark
  const bmSpan = document.getElementById(`s-${bmSentIdx}`);
  if (bmSpan) bmSpan.classList.add('bookmarked');

  // Simpan ke Supabase
  const meta = window._currentBookMeta;
  let saved = false;
  if (supa && meta?.id && currentChapter >= 0) {
    try {
      const { error } = await supa.from('books').update({
        current_chapter: currentChapter,
        current_sentence: bmSentIdx,
        progress_pct: Math.round((currentChapter / Math.max(chapters.length - 1, 1)) * 100)
      }).eq('id', meta.id);
      if (!error) saved = true;
    } catch(e) {}
  }

  // Simpan ke localStorage (fallback + selalu)
  const bmKey = `bm_${meta?.id || 'local'}`;
  localStorage.setItem(bmKey, JSON.stringify({
    chapter: currentChapter, sentence: bmSentIdx,
    text: lastSelText.slice(0, 60), ts: Date.now()
  }));

  // Toast notif
  const toast = document.getElementById('bm-toast');
  const preview = lastSelText.length > 28 ? lastSelText.slice(0, 28) + '…' : lastSelText;
  toast.innerHTML = '🔖 Ditandai: "' + preview + '"';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2600);
}

// Auto-bookmark tiap kalimat audio diputar
function autoBookmark(chIdx, sIdx) {
  localStorage.setItem(`bm_auto_${window._currentBookMeta?.id || 'local'}`,
    JSON.stringify({ chapter: chIdx, sentence: sIdx, ts: Date.now() }));
}

// ── CARI ARTI VIA CLAUDE API (streaming) ──
async function doCariArti() {
  hideSelBubble();
  const word = lastSelText.trim();
  window.getSelection()?.removeAllRanges();
  if (!word) return;
  // Posisi def-bubble di bawah seleksi
  const rect = lastSelRect || { left: 20, right: 200, bottom: 200, top: 160, width: 180 };
  const bW = 300;
  let x = rect.left + rect.width / 2 - bW / 2;
  let y = rect.bottom + 14;
  x = Math.max(8, Math.min(x, window.innerWidth - bW - 8));
  if (y + 200 > window.innerHeight - 100) y = Math.max(64, rect.top - 220);
  const def = document.getElementById('def-bubble');
  def.style.left = x + 'px'; def.style.top = y + 'px';
  document.getElementById('def-bword').textContent = word;
  document.getElementById('def-bbody').innerHTML = '<div class="def-loading">Claude sedang mencari arti...</div>';
  def.classList.add('show');
  await askClaude(word);
}

async function askClaude(word) {
  const body = document.getElementById('def-bbody');
  if (!claudeApiKey || !CLAUDE_PROXY_URL) {
    if (body) body.innerHTML = '<div class="def-bload" style="color:var(--red)">Claude API belum diset.<br><small>Tambahkan API key & Worker URL di halaman utama</small></div>';
    return;
  }
  try {
    const resp = await fetch(CLAUDE_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        stream: true,
        messages: [{ role: 'user', content:
          `Jelaskan arti dari kata atau frasa "${word}" dalam Bahasa Indonesia. ` +
          `Konteks: teks bacaan buku. ` +
          `Format: langsung tulis artinya saja, singkat (max 3 kalimat), ` +
          `tanpa pembuka seperti "Kata ini berarti...". ` +
          `Kalau frasa atau nama tempat/orang, jelaskan konteksnya juga.`
        }]
      })
    });
    if (!resp.ok) throw new Error('API ' + resp.status);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let txt = '';
    body.innerHTML = '<div class="def-stream" id="def-stream"></div>';
    const out = document.getElementById('def-stream');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') break;
        try {
          const j = JSON.parse(d);
          const delta = j.delta?.text || '';
          if (delta) { txt += delta; out.textContent = txt; }
        } catch {}
      }
    }
    if (!txt) body.innerHTML = '<div class="def-bload">Tidak ada hasil.</div>';
  } catch (e) {
    body.innerHTML = `<div class="def-bload" style="color:var(--red)">Gagal: ${e.message}</div>`;
  }
}

// Alias buat onclick HTML
// (selBookmark & selCariArti sudah didefinisikan di atas)

// ── LIBRARY ──

// ── LIBRARY ──
let ctxBookId = null;
let libraryBooks = [];

async function initApp() {
  // Load night mode pref
  if (localStorage.getItem('reader_night') === '1') { isNight = true; document.body.classList.add('night'); }
  loadSettings();
  loadReaderStyle();
  if (apiKey) {
    document.getElementById('api-key-input').value = apiKey;
    document.getElementById('btn-clear-key').style.display = 'inline';
    showApiConnected();
  }
  document.querySelectorAll('button[title]:not([aria-label])').forEach(button => {
    button.setAttribute('aria-label', button.getAttribute('title'));
  });
  document.getElementById('book-grid')?.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const placeholder = document.createElement('div');
    placeholder.className = 'book-cover-placeholder';
    placeholder.innerHTML = `<div class="book-icon" aria-hidden="true">📖</div><div class="book-initials">${escHtml(image.alt || 'Sampul tidak tersedia')}</div>`;
    image.replaceWith(placeholder);
  }, true);
  document.addEventListener('keydown', handleGlobalKeyboard);
  // Offline indicator
  updateOfflineBadge();
  window.addEventListener('online', updateOfflineBadge);
  window.addEventListener('offline', updateOfflineBadge);
  // Init native text selection bubble (Tandai + Cari Arti)
  document.addEventListener('mouseup', checkSel);
  document.addEventListener('touchend', checkSel);
  document.addEventListener('selectionchange', () => {
    if (!window.getSelection()?.toString()?.trim()) hideSelBubble();
  });
  document.addEventListener('mousedown', e => {
    if (!document.getElementById('sel-bubble')?.contains(e.target)) hideSelBubble();
    if (!document.getElementById('def-bubble')?.contains(e.target) &&
        !document.getElementById('sel-bubble')?.contains(e.target)) closeDefBubble();
  });

  // Auto-load Claude key dari localStorage + pre-fill form
  const savedClaude = localStorage.getItem('buku_suara_claude_key');
  const savedProxy = localStorage.getItem('buku_suara_claude_proxy') || 'https://restless-bar-9a2d.andrreansyahbahrum.workers.dev';
  if (savedClaude) {
    claudeApiKey = savedClaude;
    const inp = document.getElementById('claude-key-input');
    if (inp) inp.value = savedClaude;
  }
  // Worker URL selalu pre-fill
  CLAUDE_PROXY_URL = savedProxy;
  const proxyInp = document.getElementById('claude-proxy-input');
  if (proxyInp) proxyInp.value = savedProxy;
  const st = document.getElementById('claude-status');
  if (st && savedClaude) { st.textContent = '✓ Claude API key aktif'; st.style.color = 'var(--green)'; }

  // Always show library first — tapi cek dulu apakah ada session aktif yang mesti di-resume
  await tryResumeLastSession();
}

// ── AUTO-RESUME LAST SESSION ──
// Saat app reload (tab di-discard, buka dari home screen), langsung buka buku + posisi terakhir
async function tryResumeLastSession() {
  try {
    const raw = localStorage.getItem('ab_last_session');
    if (!raw) { showLibrary(); return; }
    const session = JSON.parse(raw);
    if (!session.bookId) { showLibrary(); return; }

    // Cek apakah waktu keluar sudah lebih dari 5 menit
    const exitTs = parseInt(localStorage.getItem('ab_exit_ts') || '0');
    const wasPlaying = localStorage.getItem('ab_was_playing') === '1';
    const msSinceExit = Date.now() - exitTs;
    const FIVE_MIN = 5 * 60 * 1000;

    // Auto-resume hanya kalau: sedang playing saat keluar DAN belum 5 menit
    // Kalau sudah stop atau sudah lama → langsung dashboard
    if (!wasPlaying || msSinceExit > FIVE_MIN) {
      showLibrary(); return;
    }

    // Juga skip kalau session-nya udah lebih dari 24 jam
    if (Date.now() - session.ts > 86400000) { showLibrary(); return; }

    // Load library dulu buat dapet metadata buku — fallback ke cache lokal kalau offline
    let books;
    try {
      const { data } = await supa.from('books').select('*').eq('id', session.bookId).single();
      books = data;
    } catch(e) { books = null; }
    let ab;
    if (books) {
      libraryBooks = [books];
      try { ab = await fetchEpubOffline(session.bookId, books.epub_url, books); }
      catch(e) { showLibrary(); return; }
    } else {
      // Supabase gak bisa diakses (offline) — coba pure dari cache lokal
      const cached = await odbGet('books', session.bookId).catch(() => null);
      if (!cached) { showLibrary(); return; }
      books = cached.meta; ab = cached.epub;
      libraryBooks = [books];
      showToast('📴 Offline — buku dimuat dari cache lokal');
    }
    const file = new File([ab], books.title + '.epub', { type: 'application/epub+zip' });
    window._currentBookMeta = books;

    const ok = await loadEpub(file);
    if (!ok) { showLibrary(); return; }

    const ch = session.chapter || 0;
    const sent = session.sentence || 0;
    loadChapter(ch);
    currentSentence = sent;
    renderTextPanel(sent);
    updateProgress();
    setTimeout(() => {
      const el = document.getElementById(`s-${sent}`);
      const container = document.getElementById('reading-area');
      if (el && container) {
        container.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - container.clientHeight / 2), behavior: 'smooth' });
      }
    }, 400);

    // Auto-play hanya kalau tadi sedang playing saat keluar
    if (wasPlaying) {
      try {
        await playFrom(sent);
        showToast(`📖 Lanjut bab ${ch + 1}, kal. ${sent + 1}`);
      } catch(e) {
        showTapToContinue(ch, sent);
      }
    } else {
      // Tadi pause — buka reader tapi tidak auto-play
      document.getElementById('library-screen').style.display = 'none';
      document.getElementById('library-screen').classList.remove('has-mini');
      document.getElementById('mini-player').classList.remove('show');
      document.getElementById('reader-screen').style.display = 'flex';
      showToast(`📖 Lanjut dari bab ${ch + 1}, kal. ${sent + 1}`);
    }
  } catch(e) {
    showLibrary();
  }
}

function showTapToContinue(ch, sent) {
  // Overlay ringan di atas reader — tap sekali langsung play
  const overlay = document.createElement('div');
  overlay.id = 'tap-resume-overlay';
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;`;
  overlay.innerHTML = `<div style="background:var(--bg);border-radius:20px;padding:32px 28px;text-align:center;max-width:280px;">
    <div style="font-size:2rem;margin-bottom:12px;">▶</div>
    <div style="font-weight:600;margin-bottom:8px;color:var(--text)">Lanjut dengerin?</div>
    <div style="font-size:13px;color:var(--text-soft);margin-bottom:20px;">Tap untuk lanjut dari kalimat terakhir</div>
    <button onclick="document.getElementById('tap-resume-overlay').remove();playFrom(${sent});" style="background:var(--accent);color:#fff;border:none;border-radius:12px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer;width:100%;">Lanjut</button>
  </div>`;
  document.body.appendChild(overlay);
}

function showSetup() {
  document.getElementById('library-screen').style.display = 'none';
  document.getElementById('setup-screen').style.display = 'flex';
}

async function showLibrary() {
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('reader-screen').style.display = 'none';
  document.getElementById('library-screen').style.display = 'flex';
  document.getElementById('library-screen').style.flexDirection = 'column';
  updateMiniPlayer();
  await loadBooks();
}

function updateMiniPlayer() {
  const mini = document.getElementById('mini-player');
  const libScreen = document.getElementById('library-screen');
  // Mini player muncul kalau ada buku aktif (playing ATAU paused dalam sesi ini)
  // Tidak muncul kalau app baru dibuka setelah > 5 menit tutup
  if (currentChapter >= 0 && chapters.length > 0) {
    // Ada buku yang sedang dibuka — tampilkan mini player
    const ch = chapters[currentChapter];
    document.getElementById('mini-title').textContent = bookTitle || '—';
    document.getElementById('mini-sub').textContent = `Bab ${currentChapter + 1} · Kal. ${currentSentence + 1}/${ch?.sentences?.length || 0}`;
    // Cover
    const coverEl = document.getElementById('mini-cover');
    const meta = window._currentBookMeta;
    if (meta?.cover_url) {
      coverEl.innerHTML = `<img src="${meta.cover_url}" alt="">`;
    } else {
      coverEl.textContent = '📖';
    }
    // Play/pause state
    const playBtn = document.getElementById('mini-btn-play');
    if (isPlaying) {
      playBtn.classList.remove('paused');
    } else {
      playBtn.classList.add('paused');
    }
    mini.classList.add('show');
    libScreen.classList.add('has-mini');
  } else {
    mini.classList.remove('show');
    libScreen.classList.remove('has-mini');
  }
}

function returnToReader() {
  if (currentChapter < 0) return;
  document.getElementById('library-screen').style.display = 'none';
  document.getElementById('library-screen').classList.remove('has-mini');
  document.getElementById('mini-player').classList.remove('show');
  document.getElementById('reader-screen').style.display = 'flex';
}

function miniTogglePlay() {
  togglePlay();
  // Update mini play/pause icon
  setTimeout(() => {
    const playBtn = document.getElementById('mini-btn-play');
    if (isPlaying) { playBtn.classList.remove('paused'); }
    else { playBtn.classList.add('paused'); }
    const sub = document.getElementById('mini-sub');
    if (sub) sub.textContent = isPlaying ? `Bab ${currentChapter + 1} · Kal. ${currentSentence + 1}/${chapters[currentChapter]?.sentences?.length || 0}` : 'Dijeda';
  }, 100);
}

function miniStop() {
  stopAudio();
  try { if (window.PiPPlayer && window.PiPPlayer.active) window.PiPPlayer.close(); } catch(e) {}
  chapters = []; currentChapter = -1; currentSentence = 0;
  downloadedChapters.clear();
  window._currentBookMeta = null;
  document.body.classList.remove('text-expanded');
  document.getElementById('mini-player').classList.remove('show');
  document.getElementById('library-screen').classList.remove('has-mini');
}

async function loadBooks() {
  const grid = document.getElementById('book-grid');
  const empty = document.getElementById('lib-empty');

  // Show skeletons
  grid.setAttribute('aria-busy', 'true');
  document.getElementById('library-count').textContent = 'Memuat koleksi…';
  empty.style.display = 'none';
  grid.innerHTML = Array(5).fill('').map(() => `
    <div class="book-card">
      <div class="book-cover skeleton" style="aspect-ratio:2/3;"></div>
      <div class="book-info">
        <div class="skeleton" style="height:12px;border-radius:4px;margin-bottom:6px;"></div>
        <div class="skeleton" style="height:10px;border-radius:4px;width:60%;"></div>
      </div>
    </div>`).join('');

  try {
    if (!supa) throw new Error('Layanan perpustakaan gagal dimuat');
    const { data, error } = await supa.from('books').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    libraryBooks = data || [];
    renderBookGrid(libraryBooks);
  } catch(e) {
    // Offline fallback — pakai buku yang pernah dibuka & ke-cache lokal
    try {
      const cachedEntries = await odbGetAllEntries('books');
      if (cachedEntries.length) {
        libraryBooks = cachedEntries.map(entry => entry.value.meta).filter(Boolean);
        renderBookGrid(libraryBooks);
        showToast('📴 Offline — nampilin buku yang pernah dibuka');
        return;
      }
    } catch(e2) {}
    grid.innerHTML = '';
    grid.setAttribute('aria-busy', 'false');
    showLibraryEmptyState('error');
    showToast('Gagal load perpustakaan: ' + e.message);
  }
}

function showLibraryEmptyState(mode = 'empty') {
  const empty = document.getElementById('lib-empty');
  const icon = document.getElementById('lib-empty-icon');
  const title = document.getElementById('lib-empty-title');
  const sub = document.getElementById('lib-empty-sub');
  const action = document.getElementById('lib-empty-action');
  const count = document.getElementById('library-count');

  if (mode === 'error') {
    icon.textContent = '↻';
    title.textContent = 'Koleksi belum bisa dimuat';
    sub.textContent = 'Periksa koneksi, lalu coba muat ulang perpustakaan.';
    action.textContent = 'Coba lagi';
    action.onclick = loadBooks;
    count.textContent = 'Gagal memuat';
  } else {
    icon.textContent = '📚';
    title.textContent = 'Perpustakaan masih kosong';
    sub.textContent = 'Upload EPUB pertama untuk mulai membaca dan mendengarkan.';
    action.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Upload EPUB`;
    action.onclick = () => document.getElementById('lib-file-input').click();
    count.textContent = '0 buku';
  }
  empty.style.display = 'flex';
}

function renderBookGrid(books) {
  const grid = document.getElementById('book-grid');
  const empty = document.getElementById('lib-empty');
  grid.setAttribute('aria-busy', 'false');
  document.getElementById('library-count').textContent = `${books.length} buku`;
  if (!books.length) { grid.innerHTML = ''; showLibraryEmptyState(); return; }
  empty.style.display = 'none';
  grid.innerHTML = books.map(b => {
    const pct = b.progress_pct || 0;
    const coverHtml = b.cover_url
      ? `<img src="${b.cover_url}" alt="${escHtml(b.title)}" loading="lazy">`
      : `<div class="book-cover-placeholder"><div class="book-icon">📖</div><div class="book-initials">${escHtml(b.title)}</div></div>`;
    return `
      <article class="book-card">
        <button type="button" class="book-card-open" onclick="openBook('${b.id}')" aria-label="Buka buku ${escHtml(b.title)}">
          <div class="book-cover">
            ${coverHtml}
          </div>
          <div class="book-progress-bar" aria-hidden="true"><div class="book-progress-fill" style="--progress:${Math.max(0, Math.min(100, pct)) / 100}"></div></div>
          <div class="book-info">
            <div class="book-title">${escHtml(b.title)}</div>
            <div class="book-meta">${b.chapter_count || 0} bab · ${pct}% dibaca</div>
          </div>
        </button>
        <button type="button" class="book-card-menu" onclick="openCtx(event,'${b.id}')" title="Opsi untuk ${escHtml(b.title)}" aria-label="Opsi untuk ${escHtml(b.title)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/>
          </svg>
        </button>
      </article>`;
  }).join('');
}

// Upload EPUB to Supabase
document.getElementById('lib-file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  await uploadEpubToSupabase(file);
});

async function uploadEpubToSupabase(file) {
  if (!supa) {
    showToast('Layanan upload belum tersedia. Muat ulang aplikasi.');
    return;
  }
  if (!apiKey) {
    // Show setup to get API key first
    document.getElementById('library-screen').style.display = 'none';
    document.getElementById('setup-screen').style.display = 'flex';
    // After connect, remember pending file
    window._pendingEpub = file;
    showToast('Sambungkan API key dulu');
    return;
  }

  const progBar = document.getElementById('upload-progress-bar');
  const progFill = document.getElementById('upload-prog-fill');
  const progLabel = document.getElementById('upload-prog-label');
  progBar.classList.add('show');
  setProgress(progFill, 10);
  progLabel.textContent = 'Membaca EPUB...';

  try {
    // Parse EPUB first to get metadata
    const ab = await file.arrayBuffer();
    const JSZipLib = await ensureJSZip();
    const zip = await JSZipLib.loadAsync(ab);
    const containerXml = await zip.file('META-INF/container.xml').async('text');
    const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
    const rootfilePath = containerDoc.querySelector('rootfile').getAttribute('full-path');
    const rootDir = rootfilePath.includes('/') ? rootfilePath.split('/').slice(0,-1).join('/') + '/' : '';
    const opfText = await zip.file(rootfilePath).async('text');
    const opfDoc = new DOMParser().parseFromString(opfText, 'application/xml');
    const title = opfDoc.querySelector('title')?.textContent?.trim() || file.name.replace('.epub','');

    // Count chapters
    const spineItems = [...opfDoc.querySelectorAll('spine itemref')].map(el => el.getAttribute('idref'));
    const manifestMap = {};
    [...opfDoc.querySelectorAll('manifest item')].forEach(el => { manifestMap[el.getAttribute('id')] = { href: el.getAttribute('href'), type: el.getAttribute('media-type') }; });
    let chCount = 0;
    for (const id of spineItems) { const it = manifestMap[id]; if (it?.type?.includes('html')) chCount++; }

    // Try get cover image
    setProgress(progFill, 30); progLabel.textContent = 'Mengupload file...';
    let coverUrl = null;
    const coverId = opfDoc.querySelector('meta[name="cover"]')?.getAttribute('content');
    if (coverId && manifestMap[coverId]) {
      const coverPath = rootDir + manifestMap[coverId].href;
      const coverFile = zip.file(coverPath) || zip.file(manifestMap[coverId].href);
      if (coverFile) {
        const coverBytes = await coverFile.async('arraybuffer');
        const ext = manifestMap[coverId].href.split('.').pop().toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
        const coverBlob = new Blob([coverBytes], { type: mime });
        const coverName = `covers/${Date.now()}_cover.${ext}`;
        const { data: cvData } = await supa.storage.from('epub-files').upload(coverName, coverBlob, { contentType: mime });
        if (cvData) {
          const { data: pubData } = supa.storage.from('epub-files').getPublicUrl(coverName);
          coverUrl = pubData?.publicUrl || null;
        }
      }
    }

    // Upload EPUB file
    setProgress(progFill, 60); progLabel.textContent = 'Menyimpan ke perpustakaan...';
    const epubName = `epubs/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    const { data: epubData, error: epubErr } = await supa.storage.from('epub-files').upload(epubName, file, { contentType: 'application/epub+zip' });
    if (epubErr) throw epubErr;
    const { data: epubPub } = supa.storage.from('epub-files').getPublicUrl(epubName);

    // Save metadata to DB
    setProgress(progFill, 85); progLabel.textContent = 'Menyimpan metadata...';
    const { data: bookData, error: dbErr } = await supa.from('books').insert({
      title, cover_url: coverUrl, epub_url: epubPub.publicUrl,
      chapter_count: chCount, progress_pct: 0, current_chapter: 0
    }).select().single();
    if (dbErr) throw dbErr;

    setProgress(progFill, 100); progLabel.textContent = 'Selesai!';
    setTimeout(() => { progBar.classList.remove('show'); setProgress(progFill, 0); }, 1500);
    showToast(`"${title}" berhasil diupload!`);
    await loadBooks();

  } catch(e) {
    progBar.classList.remove('show');
    showToast('Upload gagal: ' + e.message);
    console.error(e);
  }
}

// Fetch epub dari network + cache ke IndexedDB; kalau network gagal (offline), fallback ke cache lokal.
// Throw kalau dua-duanya gak ada (belum pernah dibuka online sama sekali).
async function fetchEpubOffline(bookId, epubUrl, bookMeta) {
  try {
    const res = await fetch(epubUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ab = await res.arrayBuffer();
    odbPut('books', bookId, { meta: bookMeta, epub: ab, savedAt: Date.now() }).catch(()=>{});
    return ab;
  } catch (netErr) {
    const cached = await odbGet('books', bookId).catch(() => null);
    if (cached?.epub) { showToast('📴 Offline — buku dimuat dari cache lokal'); return cached.epub; }
    throw new Error('Gak ada internet & buku ini belum pernah di-cache offline');
  }
}

async function openBook(bookId) {
  const book = libraryBooks.find(b => b.id === bookId);
  if (!book) return;

  if (!book.epub_url) { showToast('File EPUB tidak ditemukan'); return; }

  // Check API key
  if (!apiKey) {
    window._pendingBookId = bookId;
    document.getElementById('library-screen').style.display = 'none';
    document.getElementById('setup-screen').style.display = 'flex';
    showToast('Sambungkan API key dulu');
    return;
  }

  // Stop audio kalau ada buku lain yang sedang jalan
  if (isPlaying || currentChapter >= 0) {
    stopAudio();
    chapters = []; currentChapter = -1; currentSentence = 0;
    downloadedChapters.clear();
    window._currentBookMeta = null;
    document.getElementById('mini-player').classList.remove('show');
    document.getElementById('library-screen').classList.remove('has-mini');
  }
  showToast('Memuat buku...');
  try {
    const ab = await fetchEpubOffline(bookId, book.epub_url, book);
    const file = new File([ab], book.title + '.epub', { type: 'application/epub+zip' });
    document.getElementById('library-screen').style.display = 'none';
    document.getElementById('library-screen').classList.remove('has-mini');
    document.getElementById('mini-player').classList.remove('show');
    await loadEpubFromLibrary(file, book);
  } catch(e) {
    showToast('Gagal memuat: ' + e.message);
  }
}

async function loadEpubFromLibrary(file, bookMeta) {
  window._currentBookMeta = bookMeta;
  loadCharacterVoices(); renderCharacterPanel();
  refreshDownloadedChaptersState();

  // Prioritas resume: bm_auto (tiap kalimat) → Supabase → bm_ manual → dari awal
  let resumeCh = 0, resumeSent = 0;

  // 1. Cek bm_auto dulu — ini yang paling fresh (update tiap kalimat)
  try {
    const autoKey = `bm_auto_${bookMeta.id}`;
    const autoRaw = localStorage.getItem(autoKey);
    if (autoRaw) {
      const auto = JSON.parse(autoRaw);
      if (auto.chapter >= 0 && auto.sentence >= 0) {
        resumeCh = auto.chapter;
        resumeSent = auto.sentence;
      }
    }
  } catch(e) {}

  // 2. Kalau bm_auto kosong, fallback ke Supabase
  if (resumeCh === 0 && resumeSent === 0) {
    try {
      const { data } = await supa.from('books').select('current_chapter, current_sentence').eq('id', bookMeta.id).single();
      if (data && (data.current_chapter > 0 || data.current_sentence > 0)) {
        resumeCh = data.current_chapter || 0;
        resumeSent = data.current_sentence || 0;
      } else {
        const lsBm = localStorage.getItem(`bm_${bookMeta.id}`);
        if (lsBm) { const bm = JSON.parse(lsBm); resumeCh = bm.chapter || 0; resumeSent = bm.sentence || 0; }
      }
    } catch(e) {
      resumeCh = bookMeta.current_chapter || 0;
      resumeSent = bookMeta.current_sentence || 0;
      try {
        const lsBm = localStorage.getItem(`bm_${bookMeta.id}`);
        if (lsBm) { const bm = JSON.parse(lsBm); resumeCh = bm.chapter || 0; resumeSent = bm.sentence || 0; }
      } catch(e2) {}
    }
  }

  const ok = await loadEpub(file);
  if (!ok) return;

  // Restore chapter & sentence after epub fully parsed
  if (resumeCh > 0 || resumeSent > 0) {
    loadChapter(resumeCh);
    currentSentence = resumeSent;
    renderTextPanel(resumeSent);
    updateProgress();
    setTimeout(() => {
      const el = document.getElementById(`s-${resumeSent}`);
      const container = document.getElementById('reading-area');
      if (el) el.classList.add('bookmarked');
      if (el && container) {
        const er = el.getBoundingClientRect(), rr = container.getBoundingClientRect();
        container.scrollTo({ top: Math.max(0, er.top - rr.top + container.scrollTop - container.clientHeight / 2), behavior: 'smooth' });
      }
    }, 400);
    showToast(`📖 Lanjut bab ${resumeCh + 1}, kal. ${resumeSent + 1}`);
  } else {
    loadChapter(0);
  }
}

// Save reading progress to Supabase
async function saveProgress() {
  const meta = window._currentBookMeta;
  if (!supa || !meta || currentChapter < 0) return;
  const pct = Math.round((currentChapter / Math.max(chapters.length - 1, 1)) * 100);
  await supa.from('books').update({
    current_chapter: currentChapter,
    current_sentence: currentSentence,
    progress_pct: pct
  }).eq('id', meta.id);
}

// Context menu
function openCtx(e, bookId) {
  e.stopPropagation();
  ctxBookId = bookId;
  const menu = document.getElementById('ctx-menu');
  menu.classList.add('show');
  menu.setAttribute('aria-hidden', 'false');
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 170) + 'px';
  menu.querySelector('[role="menuitem"]')?.focus();
}
function ctxOpen() { closeCtx(); openBook(ctxBookId); }
async function ctxDelete() {
  closeCtx();
  const book = libraryBooks.find(b => b.id === ctxBookId);
  if (!book) return;
  if (!supa) { showToast('Layanan perpustakaan belum tersedia.'); return; }
  if (!confirm(`Hapus "${book.title}" dari perpustakaan?`)) return;
  try {
    await supa.from('books').delete().eq('id', book.id);
    showToast('Buku dihapus');
    await loadBooks();
  } catch(e) { showToast('Gagal hapus: ' + e.message); }
}
function closeCtx() {
  const menu = document.getElementById('ctx-menu');
  menu.classList.remove('show');
  menu.setAttribute('aria-hidden', 'true');
}
document.addEventListener('click', closeCtx);

function handleGlobalKeyboard(event) {
  if (event.key === 'Escape') {
    if (document.getElementById('bottom-sheet').classList.contains('open')) closeSheet();
    if (document.getElementById('ctx-menu').classList.contains('show')) closeCtx();
    closeDefBubble();
    hideSelBubble();
    return;
  }

  const menu = document.getElementById('ctx-menu');
  if (!menu.classList.contains('show') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  const current = Math.max(0, items.indexOf(document.activeElement));
  let next = current;
  if (event.key === 'ArrowDown') next = (current + 1) % items.length;
  if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = items.length - 1;
  event.preventDefault();
  items[next]?.focus();
}

function resetBook() {
  // Kalau audio sedang jalan → ke dashboard tapi audio tetap jalan (mini player)
  // Kalau audio stop → reset penuh
  document.getElementById('reader-screen').style.display = 'none';
  document.body.classList.remove('text-expanded');
  showLibrary();
}
