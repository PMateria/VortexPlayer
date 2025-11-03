# IPTV Player (Electron) con Remux ffmpeg → HLS

## Funzionalità
- Eseguibile desktop (Win/macOS/Linux) con UI integrata (Electron).
- Proxy incorporato + **remux**: flussi `mpegts` convertiti al volo in **HLS (.m3u8)** senza ricodifica (`-c copy`).
- Playlist M3U/M3U_PLUS: parsing e lista canali.
- Impostazioni persistenti (playlist predefinita, URL Admin opzionale).

## Requisiti
- Node.js LTS (>=18)
- Internet per `npm install`

## Avvio (sviluppo)
```bash
cd app
npm install
npm start
```
Si aprirà l'app: incolla la URL della tua playlist e avvia un canale. Se non è `.m3u8`, parte il remux.

## Build eseguibili
```bash
cd app
npm run build
```
Otterrai:
- Windows: installer NSIS (`dist/*.exe`)
- macOS: DMG (`dist/*.dmg`)
- Linux: AppImage (`dist/*.AppImage`)

## Parametri remux (in `main.js`)
- `-hls_time 4` → segmenti di 4s (puoi 2–6s).
- `-hls_list_size 6` → finestra di ~24s.
- Aumenta `-hls_list_size` per maggiore stabilità (più latenza).

## Pulizia temporanei
I segmenti sono in cartella temporanea di sistema (`/tmp` o `%TEMP%`). Alla chiusura del canale o dell’app vengono rimossi automaticamente.

## Note legali
Riproduci solo contenuti per cui hai i diritti.
