const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('electron-store');
const store = new Store();
const { Readable } = require('stream');

const express = require('express');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const ffmpegPath = require('ffmpeg-static');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('log-level', '3');

const serverApp = express();
serverApp.use(express.json());

/* ---------------- Playlist parsing ---------------- */
function parseM3U(text) {
  // === VERSIONE ROBUSTA: supporta sia EXTINF→URL che URL→EXTINF ===
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;
  let lastGroupFromExtGrp = '';
  let pendingUrl = ''; // URL visto prima del relativo EXTINF

  for (const raw of lines) {
    const line = (raw || '').trim();
    if (!line) continue;

    if (line.startsWith('#EXTGRP')) {
      const grp = line.split(':').slice(1).join(':').trim();
      if (grp) lastGroupFromExtGrp = grp;
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      const namePart  = line.split(',').slice(1).join(',').trim();
      const logoMatch  = line.match(/tvg-logo="([^"]*)"/i)  || line.match(/tvg-logo=([^ ,]+)/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i) || line.match(/group-title=([^,]+)/i);

      const meta = {
        name: namePart || 'Senza nome',
        tvg_logo: logoMatch ? (logoMatch[1] || '').trim() : '',
        group: (groupMatch ? (groupMatch[1] || '').trim() : '') || lastGroupFromExtGrp || 'Senza categoria'
      };

      if (pendingUrl) {
        // Caso URL → EXTINF: completa subito il canale
        channels.push({ ...meta, url: pendingUrl });
        pendingUrl = '';
        current = null;
      } else {
        // Caso standard EXTINF → URL: attendi l'URL
        current = meta;
      }
      continue;
    }

    if (line.startsWith('#')) continue;

    // URL
    const url = line;

    if (current) {
      // Caso standard EXTINF → URL
      channels.push({
        name: current.name || 'Senza nome',
        tvg_logo: current.tvg_logo || '',
        group: current.group || lastGroupFromExtGrp || 'Senza categoria',
        url
      });
      current = null;
      continue;
    }

    // Caso URL orfano: memorizza in attesa dell'EXTINF che segue
    if (!pendingUrl) {
      pendingUrl = url;
    } else {
      // URL consecutivi senza EXTINF: emetti il precedente come "Senza nome"
      channels.push({
        name: 'Senza nome',
        tvg_logo: '',
        group: lastGroupFromExtGrp || 'Senza categoria',
        url: pendingUrl
      });
      pendingUrl = url;
    }
  }

  // Fine file con URL pendente: emetti comunque
  if (pendingUrl) {
    channels.push({
      name: 'Senza nome',
      tvg_logo: '',
      group: lastGroupFromExtGrp || 'Senza categoria',
      url: pendingUrl
    });
  }

  return channels;
}



/* ---------------- Playlist endpoint con cache e fast path ---------------- */
const playlistCache = new Map(); // key=url -> { ts, channels }

function setCacheIfBetter(url, channels) {
  try {
    const nextLen = Array.isArray(channels) ? channels.length : 0;
    const prev = playlistCache.get(url);
    const prevLen = prev && Array.isArray(prev.channels) ? prev.channels.length : 0;

    // ✅ aggiorna solo se è la prima volta o se abbiamo almeno lo stesso numero di canali
    if (!prev || nextLen >= prevLen) {
      playlistCache.set(url, { ts: Date.now(), channels });
    } else {
      // tieni la versione più lunga già in cache
      // (non fare nulla)
    }
  } catch {}
}


serverApp.get('/api/playlist', async (req, res) => {
  const { url, debug } = req.query;
  const reqLimit = Number(req.query.limit ?? 0);
  const MAX_LIMIT = 200000;
  const limitTotal = (reqLimit > 0) ? Math.min(reqLimit, MAX_LIMIT) : Infinity;
  const early = Math.max(0, Number(req.query.early || 0));
  if (!url) return res.status(400).json({ error: 'url mancante' });

  // 🧠 cache 60s
  const cached = playlistCache.get(url);
  if (cached && (Date.now() - cached.ts) < 60_000) {
    return res.json({ channels: cached.channels.slice(0, limitTotal), cached: true });
  }

  const UAS = [
    'VLC/3.0.18 LibVLC/3.0.18',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117 Safari/537.36',
    'IPTV/1.0'
  ];

  // === FUNZIONE DI PARSING ROBUSTA: supporta EXTINF→URL e URL→EXTINF ===
  function pushChannel(list, cur, rawLine) {
    const line = (rawLine || '').trim();
    if (!line) return;

    if (line.startsWith('#EXTGRP')) {
      const grp = line.split(':').slice(1).join(':').trim();
      if (grp) cur.lastGroup = grp;
      return;
    }

    if (line.startsWith('#EXTINF')) {
      const namePart   = line.split(',').slice(1).join(',').trim();
      const logoMatch  = line.match(/tvg-logo="([^"]*)"/i)  || line.match(/tvg-logo=([^ ,]+)/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i) || line.match(/group-title=([^,]+)/i);

      const currentMeta = {
        name: namePart || 'Senza nome',
        tvg_logo: logoMatch ? (logoMatch[1] || '').trim() : '',
        group: (groupMatch ? (groupMatch[1] || '').trim() : '') || cur.lastGroup || 'Senza categoria'
      };

      // ❗Se avevamo già visto un URL orfano, completa subito
      if (cur.pendingUrl) {
        list.push({
          name: currentMeta.name,
          tvg_logo: currentMeta.tvg_logo,
          group: currentMeta.group,
          url: cur.pendingUrl
        });
        cur.pendingUrl = '';
        cur.current = null;
        return;
      }

      // Altrimenti attendi l'URL (caso standard)
      cur.current = currentMeta;
      return;
    }

    if (line.startsWith('#')) return;

    // URL
    const url = line;

    if (cur.current) {
      // Caso standard EXTINF → URL
      list.push({
        name: cur.current.name,
        tvg_logo: cur.current.tvg_logo,
        group: cur.current.group || cur.lastGroup || 'Senza categoria',
        url
      });
      cur.current = null;
      return;
    }

    // ❗URL → (EXTINF dopo): memorizza e aspetta il prossimo EXTINF
    if (!cur.pendingUrl) {
      cur.pendingUrl = url;
      return;
    }

    // URL consecutivi senza EXTINF: emetti quello precedente come "Senza nome"
    list.push({
      name: 'Senza nome',
      tvg_logo: '',
      group: cur.lastGroup || 'Senza categoria',
      url: cur.pendingUrl
    });
    cur.pendingUrl = url; // il nuovo resta pendente
  }

  // === TENTA CON PIÙ USER-AGENT ===
  for (const ua of UAS) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 120_000);

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': ua, 'Accept': '*/*', 'Connection': 'keep-alive' },
        signal: ac.signal
      });
      clearTimeout(to);

      if (!resp.ok) {
        if (debug === '1') {
          const txt = await resp.text().catch(() => '');
          return res.status(resp.status).json({ error: `upstream ${resp.status}`, ua, body: txt.slice(0, 2000) });
        }
        continue;
      }

      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/vnd.apple.mpegurl') || url.toLowerCase().endsWith('.m3u8')) {
        const body = await resp.text().catch(() => '');
        if (body.startsWith('#EXTM3U') && body.includes('#EXT-X-TARGETDURATION')) {
          const out = [{ name: 'Stream', tvg_logo: '', url }];
          setCacheIfBetter(url, out);
          return res.json({ channels: out });
        }
      }

      // ✅ STREAMING PARSING
      // ✅ STREAMING PARSING CORRETTO (niente generatore, nessuna riga persa)
if (resp.body) {
  const channels = [];
  const cur = { current: null, lastGroup: '', pendingUrl: '' };

  const reader = Readable.fromWeb(resp.body, { encoding: 'utf8' });
  let rest = '';
  let sentPartial = false;

  for await (const chunk of reader) {
    rest += chunk;
    let idx;
    // Consuma TUTTE le righe presenti nel buffer
    while ((idx = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, idx).replace(/\r$/, '');
      rest = rest.slice(idx + 1);
      pushChannel(channels, cur, line);

      // === EARLY RESPONSE opzionale (solo se richiesto da query ?early=) ===
      if (!sentPartial && early > 0 && channels.length >= early) {
        res.json({ channels: channels.slice(0, limitTotal), partial: true });
        sentPartial = true;
        // Continua il parsing in background per popolare la cache completa
      }
    }
  }

  // Ultima riga senza newline a fine stream
  if (rest) pushChannel(channels, cur, rest);

  // 🔚 flush di eventuale URL pendente
  if (cur.pendingUrl) {
    channels.push({
      name: 'Senza nome',
      tvg_logo: '',
      group: cur.lastGroup || 'Senza categoria',
      url: cur.pendingUrl
    });
    cur.pendingUrl = '';
  }

  // Se abbiamo mandato una risposta parziale, qui aggiorniamo solo la cache
  if (sentPartial) {
    console.log(`[playlist] Parsing completo (post-parziale): ${channels.length} canali`);
    setCacheIfBetter(url, channels);
    return; // la risposta "parziale" è già stata inviata
  }

  setCacheIfBetter(url, channels);
  return res.json({ channels: channels.slice(0, limitTotal) });
}


      // === Fallback (non streamabile) ===
      const body = await resp.text();
      const all = [];
      const cur = { current: null, lastGroup: '', pendingUrl: '' };
      for (const line of body.split(/\r?\n/)) pushChannel(all, cur, line);

      // 🔚 flush di eventuale URL pendente
      if (cur.pendingUrl) {
        all.push({
          name: 'Senza nome',
          tvg_logo: '',
          group: cur.lastGroup || 'Senza categoria',
          url: cur.pendingUrl
        });
        cur.pendingUrl = '';
      }

      setCacheIfBetter(url, all);
      return res.json({ channels: all.slice(0, limitTotal) });

    } catch (err) {
      clearTimeout(to);
      continue;
    }
  }

  return res.status(504).json({ error: 'timeout/nessuna risposta valida dal server' });
});


/* ---------------- Proxy grezzo ---------------- */
serverApp.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url mancante');
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20000);
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', 'Accept': '*/*', 'Origin': 'http://svet-tv.top', 'Referer': 'http://svet-tv.top' },
      signal: ac.signal
    });
    clearTimeout(t);

    if (!upstream.ok) return res.status(upstream.status).end('Upstream error');
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => { if (!res.headersSent) res.status(502).end('Upstream error'); });
    nodeStream.pipe(res);
  } catch (e) {
    res.status(504).end(e.name === 'AbortError' ? 'timeout' : 'fetch error');
  }
});

/* ---------------- HLS proxy ---------------- */
const HLS_ROOT = path.join(os.tmpdir(), 'iptv-hls');
fs.mkdirSync(HLS_ROOT, { recursive: true });
serverApp.use('/hls', express.static(HLS_ROOT));

serverApp.get('/api/hlsProxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url mancante' });

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20000);
    const resp = await fetch(url, { headers: { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', 'Accept': '*/*', 'Origin': 'http://svet-tv.top', 'Referer': 'http://svet-tv.top' }, signal: ac.signal });
    clearTimeout(t);

    if (!resp.ok) return res.status(resp.status).json({ error: `upstream ${resp.status}` });

    const base = new URL(url);
    const text = await resp.text();
    const out = text.split(/\r?\n/).map(line => {
      if (!line || line.startsWith('#')) return line;
      try { return `/proxy?url=${encodeURIComponent(new URL(line, base).href)}`; }
      catch { return line; }
    }).join('\n');

    const id = Math.random().toString(36).slice(2);
    const dir = path.join(HLS_ROOT, `px_${id}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'proxied.m3u8'), out, 'utf8');
    setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 5 * 60 * 1000);

    res.json({ m3u8Url: `/hls/px_${id}/proxied.m3u8` });
  } catch (e) {
    return res.status(504).json({ error: e && e.name === 'AbortError' ? 'timeout (20s)' : (e && e.message) || 'fetch error' });
  }
});

/* ---------------- Serve HLS live (manifest + segmenti) ---------------- */
serverApp.get('/hls-live/:id/out.m3u8', (req, res) => {
  const sessionId = req.params.id;
  const dir = path.join(HLS_ROOT, sessionId);
  const finalPl = path.join(dir, 'out.m3u8');
  const tmpPl = path.join(dir, 'out.m3u8.tmp');

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let toRead = null;
  if (fs.existsSync(finalPl)) toRead = finalPl;
  else if (fs.existsSync(tmpPl)) toRead = tmpPl;

  if (!toRead) {
    const empty = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';
    return res.status(200).end(empty);
  }

  try {
    const text = fs.readFileSync(toRead, 'utf8');
    const hasSegments = /#EXTINF:\d+/.test(text) && /out\d+\.ts/i.test(text);
    if (!hasSegments) {
      const empty = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';
      return res.status(200).end(empty);
    }
    const lines = text.split('\n');
    const fixed = lines.map(line => line.match(/^out\d+\.ts$/) ? `/hls-live/${sessionId}/${line}` : line).join('\n');
    return res.status(200).end(fixed);
  } catch {
    const empty = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';
    return res.status(200).end(empty);
  }
});

serverApp.get('/hls-live/:id/:seg', (req, res) => {
  const dir = path.join(HLS_ROOT, req.params.id);
  const file = path.join(dir, req.params.seg);
  if (!fs.existsSync(file)) return res.status(404).end('not found');

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (file.endsWith('.ts')) res.setHeader('Content-Type', 'video/mp2t');
  else if (file.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  fs.createReadStream(file).pipe(res);
});

/* ---------------- Helpers RAI1: fallback URL e probe ---------------- */
function buildAltUrls(original) {
  try {
    const u = new URL(original);
    const parts = u.pathname.split('/').filter(Boolean); // es: ["live","USER","PASS","12345.ts"] oppure ["series","USER","PASS","98765.mkv"]
    const host = `${u.protocol}//${u.host}`;

    // Helper
    const join = (...xs) => xs.filter(Boolean).map(x => String(x).replace(/^\/+|\/+$/g,'')).join('/');

    // Rileva shape Xtream
    const first = (parts[0] || '').toLowerCase();

    // ------------- CASE: SERIES -------------
    // Formati classici: /series/USER/PASS/<id>.mkv  (VOD)
    if (first === 'series' && parts.length >= 4) {
      const user = parts[1], pass = parts[2];
      const tail = parts.slice(3).join('/'); // può includere sottopercorsi o direttamente <id>.<ext>
      // per i VOD di solito l'URL originale è già corretto: niente fallbacks "live"
      const candidates = [ original ];
      // Se manca estensione, prova .mkv e .mp4 come best-effort
      if (!/\.\w+($|\?)/.test(tail)) {
        candidates.push(`${host}/series/${join(user, pass, tail + '.mkv')}`);
        candidates.push(`${host}/series/${join(user, pass, tail + '.mp4')}`);
      }
      return candidates;
    }

    // ------------- CASE: MOVIE -------------
    // Formati classici: /movie/USER/PASS/<id>.mp4  (VOD)
    if (first === 'movie' && parts.length >= 4) {
      const user = parts[1], pass = parts[2];
      const tail = parts.slice(3).join('/');
      const candidates = [ original ];
      if (!/\.\w+($|\?)/.test(tail)) {
        candidates.push(`${host}/movie/${join(user, pass, tail + '.mp4')}`);
        candidates.push(`${host}/movie/${join(user, pass, tail + '.mkv')}`);
      }
      return candidates;
    }

    // ------------- CASE: LIVE -------------
    // Formati tipici live:
    //   /USER/PASS/ID             (MPEG-TS senza estensione)
    //   /USER/PASS/ID.ts
    //   /live/USER/PASS/ID.ts
    //   /live/USER/PASS/ID.m3u8
    if (parts.length >= 3 && first !== 'movie' && first !== 'series') {
      const user = parts[0], pass = parts[1];
      const id   = parts.slice(2).join('/').replace(/^\//,''); // potrebbe essere "12345" o "12345.ts"
      return [
        `${host}/${join(user, pass, id)}`,                // TS "nudo"
        `${host}/${join(user, pass, id + '.ts')}`,        // TS con estensione
        `${host}/live/${join(user, pass, id + '.ts')}`,   // TS sotto /live
        `${host}/live/${join(user, pass, id + '.m3u8')}`, // HLS sotto /live
        `${host}/hls/${join(user, pass, id + '.m3u8')}`   // qualche panel usa /hls/
      ];
    }

    // Fallback generico: non Xtream, restituisci l’originale
    return [ original ];
  } catch {
    return [ original ];
  }
}

async function pickReachableUrl(candidates, timeoutMs = 6000) {
  for (const url of candidates) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
          'Accept': '*/*',
          'Origin': 'http://svet-tv.top',
          'Referer': 'http://svet-tv.top',
          'Connection': 'keep-alive'
        },
        signal: ac.signal
      });
      clearTimeout(to);
      if (r.ok) return url;
    } catch {
      clearTimeout(to);
    }
  }
  return null;
}

// Probe con headers completi
async function probeStream(url) {
  return new Promise((resolve) => {
    const args = [
      '-user_agent', 'VLC/3.0.18 LibVLC/3.0.18',
      '-headers', 'Accept: */*\r\nConnection: keep-alive\r\nOrigin: http://svet-tv.top\r\nReferer: http://svet-tv.top',
      '-analyzeduration', '1500000',
      '-probesize', '2000000',
      '-i', url,
      '-t', '0.3',
      '-f', 'null',
      '-'
    ];
    const probe = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    probe.stderr.on('data', d => { stderr += d.toString(); });
    probe.on('close', () => {
      const isInterlaced = /yuv420p\(top first\)|yuv420p\(bottom first\)|tff|bff/i.test(stderr);
      resolve(isInterlaced);
    });
    setTimeout(() => { try { probe.kill(); } catch {} resolve(false); }, 3000);
  });
}

/* ---------------- Remux con fallback anti-403 ---------------- */
const sessions = new Map();

function makeSessionDir() {
  const id = Math.random().toString(36).slice(2);
  const dir = path.join(HLS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

function spawnFfmpegRemux(id, dir, url, isInterlaced, forceTranscodeVideo = false) {
  const baseArgs = [
    '-user_agent', 'VLC/3.0.18 LibVLC/3.0.18',
    '-headers', 'Accept: */*\r\nConnection: keep-alive\r\nOrigin: http://svet-tv.top\r\nReferer: http://svet-tv.top',
    '-rw_timeout', '30000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '4',
    '-analyzeduration', '6000000',
    '-probesize', '8000000',
    '-ignore_unknown',
    '-fflags', '+igndts+genpts+discardcorrupt+nobuffer',
    '-flags', 'low_delay',
    '-i', url,
    '-sn', '-dn',
    '-map', '0:v:0',
    '-map', '0:a:0?'
  ];

  // ⬇️ regole: se interlacciato **o** codec non supportato → transcodifica H.264
  const mustTranscodeVideo = isInterlaced || forceTranscodeVideo;
  const videoArgs = mustTranscodeVideo
    ? ['-vf', 'yadif=1:-1:0', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-g', '50', '-keyint_min', '25', '-sc_threshold', '0']
    : ['-c:v', 'copy'];

  // audio: sempre AAC stereo per compatibilità
  const audioArgs = ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k'];

  const outputArgs = [
    '-copyts', '-start_at_zero',
    '-avoid_negative_ts', 'make_zero',
    '-max_muxing_queue_size', '4096',
    '-mpegts_flags', '+initial_discontinuity',
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+split_by_time+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-start_number', '0',
    '-hls_allow_cache', '0',
    path.join(dir, 'out.m3u8')
  ];

  const args = [...baseArgs, ...audioArgs, ...videoArgs, ...outputArgs];
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line.includes('403') || /Forbidden/i.test(line)) {
      console.error(`[FFMPEG ${id}] 403 detected`);
    }
  });

  return proc;
}

serverApp.get('/api/remuxHls', async (req, res) => {
  const { url, vodHint } = req.query;
  if (!url) return res.status(400).json({ error: 'url mancante' });
  if (!ffmpegPath) return res.status(500).json({ error: 'ffmpeg non trovato' });

  const { id, dir } = makeSessionDir();

  try {
    fs.writeFileSync(
      path.join(dir, 'out.m3u8.tmp'),
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n',
      'utf8'
    );
  } catch {}

  // candidati “di base” (usa la tua buildAltUrls aggiornata)
  let candidates = buildAltUrls(url);

  // Rileva VOD da URL oppure da hint
  const looksVodByUrl =
    /\/(series|movie)\//i.test(url) ||
    /\.(mp4|mkv|avi|mov|m4v|wmv|mpg|mpeg)(\?|$)/i.test(url);
  const vodType = (vodHint === 'series' || vodHint === 'movie') ? vodHint : '';

  // Se l’URL sembra live ma abbiamo un hint VOD, prova a costruire endpoint VOD Xtream
  if (!looksVodByUrl && vodType) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean); // tipico live: /USER/PASS/ID(.ts)
      if (parts.length >= 3) {
        const user = parts[0], pass = parts[1];
        const idPart = parts.slice(2).join('/').replace(/\.ts$/i, '');
        const base = `${u.protocol}//${u.host}`;
        const vodCandidates = (vodType === 'series')
          ? [
              `${base}/series/${user}/${pass}/${idPart}.mkv`,
              `${base}/series/${user}/${pass}/${idPart}.mp4`,
            ]
          : [
              `${base}/movie/${user}/${pass}/${idPart}.mp4`,
              `${base}/movie/${user}/${pass}/${idPart}.mkv`,
            ];
        // Metti i candidati VOD PRIMA dei candidati live
        candidates = [...vodCandidates, ...candidates];
      }
    } catch {}
  }

  // Decide se trattare come VOD (niente fallback “live”) o LIVE (con fallback)
  const isVod = looksVodByUrl || !!vodType;

  // 1) pick
  let picked;
  if (isVod) {
    // per i VOD prova i candidati in ordine (di solito il primo funziona)
    picked = candidates[0];
  } else {
    picked = (await pickReachableUrl(candidates, 6000)) || candidates[0];
  }

  // 2) probe interlacciato
  console.log(`[REMUX ${id}] Probing interlace...`);
const isInterlaced = await probeStream(picked);
console.log(`[REMUX ${id}] Interlaced: ${isInterlaced ? 'YES' : 'NO'}`);

// 2b) probe codec: se non è H.264 o AAC, forziamo la transcodifica video
console.log(`[REMUX ${id}] Probing codecs...`);
const { video: vCodec, audio: aCodec } = await probeCodecs(picked);
const needVideoTranscode = !/^(h264|avc1)$/.test((vCodec || '').toLowerCase());
const needAudioTranscode  = !/^(aac|mp4a)$/.test((aCodec || '').toLowerCase());
console.log(`[REMUX ${id}] Codecs: video=${vCodec || 'unknown'} audio=${aCodec || 'unknown'}; xcodeV=${needVideoTranscode} xcodeA=${needAudioTranscode}`);

// 3) ffmpeg (forza transcodifica video se necessario oppure se interlacciato)
// NB: l'audio lo ricodifichiamo sempre in AAC nella funzione
let proc = spawnFfmpegRemux(id, dir, picked, isInterlaced, needVideoTranscode);

  let usedIndex = candidates.indexOf(picked);
  if (usedIndex < 0) usedIndex = 0;

  const restartOn403 = () => {
    if (isVod) {
      console.error(`[REMUX ${id}] VOD error: nessun fallback valido per VOD, mi fermo.`);
      return;
    }
    try { proc.kill('SIGTERM'); } catch {}
    for (let i = usedIndex + 1; i < candidates.length; i++) {
      const next = candidates[i];
      console.log(`[REMUX ${id}] Trying fallback URL: ${next}`);
      proc = spawnFfmpegRemux(id, dir, next, isInterlaced);
      usedIndex = i;
      wireExitHandler();
      sessions.set(id, { proc, dir, url: next });
      return;
    }
    console.error(`[REMUX ${id}] No more fallbacks available.`);
  };

  const wireExitHandler = () => {
    proc.on('exit', (code) => {
      console.log(`[FFMPEG ${id}] Exited with code ${code}`);
      if (code === 1 && usedIndex < candidates.length - 1) return restartOn403();
      sessions.delete(id);
      setTimeout(() => { fs.rm(dir, { recursive: true, force: true }, () => {}); }, 10000);
    });
  };

  wireExitHandler();
  sessions.set(id, { proc, dir, url: picked });

  return res.json({ m3u8Url: `/hls-live/${id}/out.m3u8`, sessionId: id });
});

async function probeCodecs(url) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-user_agent', 'VLC/3.0.18 LibVLC/3.0.18',
      '-headers', 'Accept: */*\r\nConnection: keep-alive\r\nOrigin: http://svet-tv.top\r\nReferer: http://svet-tv.top',
      '-analyzeduration', '4000000',
      '-probesize', '6000000',
      '-i', url,
      '-t', '0.3',
      '-f', 'null',
      '-'
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', () => {
      // estrae righe tipo: "Stream #0:0: Video: hevc ..."  "Stream #0:1: Audio: eac3 ..."
      const vMatch = stderr.match(/Stream #\d+:\d+.*Video:\s*([a-zA-Z0-9_]+)/);
      const aMatch = stderr.match(/Stream #\d+:\d+.*Audio:\s*([a-zA-Z0-9_]+)/);
      const v = vMatch ? vMatch[1].toLowerCase() : '';
      const a = aMatch ? aMatch[1].toLowerCase() : '';
      resolve({ video: v, audio: a });
    });
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ video:'', audio:'' }); }, 3500);
  });
}

serverApp.post('/api/remuxHls/stop', (req, res) => {
  const { sessionId } = req.body || {};
  const s = sessions.get(sessionId);
  if (s) {
    try { s.proc.kill('SIGTERM'); } catch {}
    sessions.delete(sessionId);
    fs.rm(s.dir, { recursive: true, force: true }, () => {});
  }
  res.json({ ok: true });
});

/* ---------------- Electron shell ---------------- */
let server;
const PROXY_PORT = 4137;
function startEmbeddedServer() {
  server = http.createServer(serverApp);
  server.listen(PROXY_PORT, () => console.log('Embedded proxy on http://localhost:'+PROXY_PORT));
}

let win;
function createWindow () {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

app.whenReady().then(() => {
  startEmbeddedServer();
  createWindow();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('settings:get', async () => {
  return store.get('settings', { playlistUrl: '', adminUrl: '' });
});
ipcMain.handle('settings:set', async (event, settings) => {
  store.set('settings', settings || {});
  return true;
});

/* ---------------- Reset cache/server memory ---------------- */
serverApp.post('/api/resetCache', async (req, res) => {
  try {
    // 1️⃣ Svuota la cache delle playlist
    if (typeof playlistCache?.clear === 'function') {
      playlistCache.clear();
    }

    // 2️⃣ Ferma eventuali sessioni ffmpeg attive
    let stopped = 0;
    for (const [id, s] of Array.from(sessions.entries())) {
      try {
        s.proc.kill('SIGTERM');
        stopped++;
      } catch {}
      sessions.delete(id);
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
    }

    // 3️⃣ Cancella tutti i file temporanei HLS
    try {
      const items = fs.readdirSync(HLS_ROOT, { withFileTypes: true });
      for (const it of items) {
        try {
          fs.rmSync(path.join(HLS_ROOT, it.name), { recursive: true, force: true });
        } catch {}
      }
    } catch {}

    // 4️⃣ Risposta finale
    res.json({ ok: true, stopped });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Errore interno durante il reset' });
  }
});
