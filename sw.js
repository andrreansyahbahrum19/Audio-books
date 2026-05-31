// Audio Books — Service Worker
// Handles background download queue via IndexedDB

const CACHE_NAME = 'audiobooks-v2';
const STATIC_ASSETS = [
  '/Audio-books/',
  '/Audio-books/index.html',
  '/Audio-books/manifest.json',
];

// ── SSML BUILDER (identik dengan main thread) ──
// Intonasi per posisi: heading = emphasis+jeda, para-end = jeda napas, tengah = plain
function buildInputSSML(text, meta) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!meta) return { text };                    // fallback kalau metadata gak ada
  if (meta.type === 'heading') {
    return { ssml: `<speak><emphasis level="moderate">${esc(text)}</emphasis><break time="900ms"/></speak>` };
  }
  if (meta.paraEnd) {
    return { ssml: `<speak>${esc(text)}<break time="450ms"/></speak>` };
  }
  return { text };
}

// ── INSTALL: cache static assets ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── ACTIVATE: clean old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH: serve from cache, fallback to network ──
self.addEventListener('fetch', event => {
  // Don't intercept Google TTS API calls
  if (event.request.url.includes('texttospeech.googleapis.com')) return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ── BACKGROUND DOWNLOAD QUEUE ──
// Messages from main thread
self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};

  if (type === 'START_DOWNLOAD') {
    // payload: { chapterIdx, sentences, segMeta, apiKey, voice, gender, speed, pitch, bookTitle, chapterTitle }
    await processDownloadQueue(event.source, payload);
  }

  if (type === 'CANCEL_DOWNLOAD') {
    // Signal handled via IndexedDB flag
    await setFlag('dl_cancel_' + payload.chapterIdx, true);
  }
});

// Open IndexedDB for progress tracking
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('audiobooks_dl', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress');
      if (!db.objectStoreNames.contains('flags')) db.createObjectStore('flags');
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
function dbPut(db, store, key, val) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(val, key);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

async function setFlag(key, val) {
  const db = await openDB();
  await dbPut(db, 'flags', key, val);
}

async function notifyClients(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(msg));
}

async function processDownloadQueue(source, payload) {
  const { chapterIdx, sentences, segMeta, apiKey, voice, gender, speed, pitch, bookTitle, chapterTitle } = payload;
  const db = await openDB();
  const cancelKey = 'dl_cancel_' + chapterIdx;
  await dbPut(db, 'flags', cancelKey, false);

  const chunks = [];
  const total = sentences.length;

  // Check if we have partial progress
  let startFrom = 0;
  const savedProgress = await dbGet(db, 'progress', `dl_progress_${chapterIdx}`);
  if (savedProgress && savedProgress.chunks) {
    startFrom = savedProgress.chunks.length;
    savedProgress.chunks.forEach(c => chunks.push(c));
  }

  await notifyClients({ type: 'DL_STARTED', chapterIdx, total, resumedFrom: startFrom });

  for (let i = startFrom; i < total; i++) {
    // Check cancel flag
    const cancelled = await dbGet(db, 'flags', cancelKey);
    if (cancelled) {
      await notifyClients({ type: 'DL_CANCELLED', chapterIdx });
      return;
    }

    try {
      let ttsInput = buildInputSSML(sentences[i], segMeta?.[i]);
      let res = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: ttsInput,
            voice: { languageCode: 'id-ID', name: voice, ssmlGender: gender },
            audioConfig: { audioEncoding: 'MP3', speakingRate: speed, pitch, effectsProfileId: ['headphone-class-device'] }
          })
        }
      );
      // Fallback: kalau SSML invalid, retry dengan plain text
      if (!res.ok && ttsInput.ssml) {
        ttsInput = { text: sentences[i] };
        res = await fetch(
          `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: ttsInput,
              voice: { languageCode: 'id-ID', name: voice, ssmlGender: gender },
              audioConfig: { audioEncoding: 'MP3', speakingRate: speed, pitch, effectsProfileId: ['headphone-class-device'] }
            })
          }
        );
      }

      if (!res.ok) throw new Error('TTS API error ' + res.status);
      const data = await res.json();
      chunks.push(data.audioContent); // base64

      // Save partial progress
      await dbPut(db, 'progress', `dl_progress_${chapterIdx}`, { chunks: [...chunks] });

      await notifyClients({ type: 'DL_PROGRESS', chapterIdx, current: i + 1, total });

    } catch (err) {
      await notifyClients({ type: 'DL_ERROR', chapterIdx, error: err.message, at: i });
      return;
    }
  }

  // Merge all base64 chunks into one blob URL via client
  await notifyClients({
    type: 'DL_COMPLETE',
    chapterIdx,
    chapterTitle,
    bookTitle,
    chunks // array of base64 strings
  });

  // Clear progress
  await dbPut(db, 'progress', `dl_progress_${chapterIdx}`, null);
}
