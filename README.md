# Audio-books
Dengerin Buku Bercerita

## Picture-in-Picture (mini floating window)

Tombol PiP ada di **top bar reader** dan di **mini player** halaman perpustakaan.
Window-nya floating di atas app lain — jadi bisa terus ngikutin bacaan sambil kerja.

**Isi window:** satu bab penuh yang bisa di-scroll dan dibaca beneran. Kalimat yang
lagi dibacain audio ke-highlight dan auto-scroll ke tengah. Klik kalimat mana aja buat
lompat ke situ. Ada pengatur ukuran teks (A- / A+), progress bar, dan kontrol
mute / bab / kalimat / play-pause.

### Dua mode, auto-pilih sesuai browser

| Mode | Browser | Kontrol |
|---|---|---|
| **Document PiP** | Chrome & Edge desktop 116+ | Tombol di dalam window bisa diklik langsung + shortcut keyboard |
| **Canvas → Video PiP** | Safari macOS/iPadOS, Firefox | Tampilan sama, kontrol lewat tombol media OS (Media Session) |

Kalau browser gak support dua-duanya, tombol PiP disembunyikan otomatis.

### Shortcut (mode Document PiP)

`Space` play/pause · `←` `→` kalimat sebelumnya/berikutnya · `M` mute · `+` `-` ukuran teks

### Scroll manual

Scroll sendiri buat baca maju/mundur — auto-scroll berhenti 6 detik biar gak berebut.
Tombol mata di footer buat balik ngikutin kalimat yang lagi dibaca.

### Auto-PiP

Default **nyala**: kalau audio lagi jalan terus lo pindah tab, window PiP muncul sendiri;
balik ke tab, window nutup. Matiin lewat console:

```js
PiPPlayer.setAuto(false)
```

### API

```js
PiPPlayer.open()      // buka
PiPPlayer.close()     // tutup
PiPPlayer.toggle()    // toggle
PiPPlayer.sync()      // refresh isi window (dipanggil otomatis dari app.js)
PiPPlayer.active      // boolean
PiPPlayer.mode        // 'doc' | 'video' | null
PiPPlayer.supported   // boolean
PiPPlayer.setFontSize(20)   // 13-28px
PiPPlayer.fontSize    // number
```

Ukuran window dan ukuran teks disimpan di `localStorage` — atur sekali, kepake terus.
