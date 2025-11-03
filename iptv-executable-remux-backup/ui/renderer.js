/* renderer.js — refined classification */
const playlistInput = document.getElementById('playlistUrl');
const btnLoad = document.getElementById('btnLoad');

const tabPlayer = document.getElementById('tabPlayer');
const tabSettings = document.getElementById('tabSettings');
const viewPlayer = document.getElementById('viewPlayer');
const viewSettings = document.getElementById('viewSettings');
const btnClearMemory = document.getElementById('btnClearMemory');

const channelsEl = document.getElementById('channels');
const filterCounter = document.getElementById('filterCounter');

const playerSection = document.getElementById('playerSection');
const currentChannel = document.getElementById('currentChannel');
const video = document.getElementById('video');

const settingPlaylist = document.getElementById('settingPlaylist');
const settingAdmin = document.getElementById('settingAdmin');
const saveSettings = document.getElementById('saveSettings');

const drawer = document.getElementById('drawer');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const openCatalog = document.getElementById('openCatalog');
const catList = document.getElementById('catList');
const catSearch = document.getElementById('catSearch');

const segLive   = document.getElementById('segLive');
const segFilm   = document.getElementById('segFilm');
const segSeries = document.getElementById('segSeries');

/* ====== STATO ====== */
let allChannels = [];         // piena playlist
let filteredChannels = [];    // vista filtrata (ricerca + categoria)
let categories = [];          // [{name,count}]
let activeCategory = 'Tutte';
let currentSessionId = null;
let hlsInstance = null;
let currentPlaylistAbort = null;  
let requestGen = 0;  
let activeSection = 'live'; // 'live' | 'film' | 'series'


/* ====== UTILS ====== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const normalize = (s='') => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const looksLikeUrl = (s='') => /:\/\//.test(s) || /\.(m3u8?|txt)$/i.test(s.trim());

/** Migliorata: evita che "EVENTI SERIE A" finisca nelle Serie TV **/
function kindOf(ch){
  const g = (ch.group || '').toLowerCase();
  const name = (ch.name || '').toLowerCase();
  const url = (ch.url || '').toLowerCase();

  // 0) Deduci dal path (Xtream)
  if (url.includes('/live/'))   return 'live';
  if (url.includes('/series/')) return 'series';
  if (url.includes('/movie/'))  return 'film';

  // 1) Parole chiave SPORT/Live che battono tutto: DAZN, eventi, calcio, serie A, ecc.
  const sportRe = /(dazn|sky\s*sport|sport|calcio|eventi|serie\s*a\b|uefa|champions|motogp|formula\s*1|(?:^|\s)f1(?:\s|$)|basket|tennis)/i;
  if (sportRe.test(g) || sportRe.test(name)) return 'live';

  // 2) Gruppi chiaramente "Serie TV" (espliciti). Evita "serie a" richiedendo "serie tv"
  const seriesGroupRe = /(serie\s*tv|tv\s*series|^serie\b(?!(\s*a\b))|^serie-tv|serietv|^serie tv b$)/i;
  if (seriesGroupRe.test(g)) return 'series';

  // 3) Gruppi cinematografici → Film
  const filmGroupRe = /(film|primevisioni|sottotitoli|sub|cinema|animazione|commedia|drammatico|horror|thriller|azione|fantasy|avventura)/i;
  if (filmGroupRe.test(g)) return 'film';

  // 4) Heuristics su nome/URL
  const isVodExt = /\.(mp4|mkv|avi|mov|m4v|wmv|mpg|mpeg)(?:[?#]|$)/i.test(url);
  const looksSeriesByPattern = /\bs\d{1,2}\s*e\d{1,3}\b/i.test(name) || /\bepisodio\b|\bstagione\b/i.test(name);
  if (isVodExt && looksSeriesByPattern) return 'series';
  if (isVodExt) return 'film';

  // 5) HLS diretto spesso è Live
  if (url.endsWith('.m3u8')) return 'live';

  // Fallback
  return 'live';
}

function setSection(sec){
  activeSection = sec; // 'live' | 'film' | 'series'

  // toggle UI pulsanti
  if (segLive)   segLive.classList.toggle('active',   sec==='live');
  if (segFilm)   segFilm.classList.toggle('active',   sec==='film');
  if (segSeries) segSeries.classList.toggle('active', sec==='series');

  // reset categoria e ricostruisci il drawer in base alla sezione
  activeCategory = 'Tutte';
  catSearch.value = '';
  buildCategories();

  // riapplica filtro corrente (testo nella searchbar)
  applyFilter(playlistInput.value);
}


if (segLive)   segLive.onclick   = () => setSection('live');
if (segFilm)   segFilm.onclick   = () => setSection('film');
if (segSeries) segSeries.onclick = () => setSection('series');



/* ====== TABS ====== */
function switchTab(which){
  if (which === 'settings'){
    tabSettings.classList.add('active'); tabPlayer.classList.remove('active');
    viewSettings.classList.remove('hidden'); viewPlayer.classList.add('hidden');
  }else{
    tabPlayer.classList.add('active'); tabSettings.classList.remove('active');
    viewPlayer.classList.remove('hidden'); viewSettings.classList.add('hidden');
  }
}
tabPlayer.onclick = () => switchTab('player');
tabSettings.onclick = () => switchTab('settings');

/* ====== DRAWER ====== */
function openDrawer(){ drawer.classList.add('open'); drawerBackdrop.classList.add('show'); }
function closeDrawer(){ drawer.classList.remove('open'); drawerBackdrop.classList.remove('show'); }
openCatalog.onclick = openDrawer;
drawerBackdrop.onclick = closeDrawer;
document.addEventListener('keydown',(e)=>{ if(e.key.toLowerCase()==='g') openDrawer(); if(e.key==='Escape') closeDrawer(); });

/* ====== CATEGORIE ====== */
function buildCategories(){
  const source = allChannels.filter(ch => kindOf(ch) === activeSection);

  const map = new Map();
  for (const ch of source){
    const g = ch.group || 'Senza categoria';
    map.set(g, (map.get(g) || 0) + 1);
  }

  categories = Array.from(map, ([name, count]) => ({ name, count }))
    .sort((a,b)=> a.name.localeCompare(b.name,'it'));

  // “Tutte” in cima con il conteggio totale della sezione
  categories.unshift({ name:'Tutte', count: source.length });

  renderCategoryList();
}

function renderCategoryList(){
  const q = normalize(catSearch.value);
  catList.innerHTML = '';
  for(const c of categories){
    if(q && !normalize(c.name).includes(q)) continue;
    const item = document.createElement('div');
    item.className = 'cat-item' + (c.name===activeCategory?' active':'');
    item.innerHTML = `<span>${c.name}</span><small>${c.count}</small>`;
    item.onclick = () => { activeCategory = c.name; closeDrawer(); applyFilter(playlistInput.value); };
    catList.appendChild(item);
  }
}
catSearch.addEventListener('input', renderCategoryList);

/* ====== RENDER GRID ====== */
function renderChannelsPaged(list){
  channelsEl.innerHTML = '';
  if(!list || !list.length){ channelsEl.innerHTML = '<p style="color:#8aa2b7">Nessun canale trovato.</p>'; return; }
  let i=0; const PAGE=60;
  const step = () => {
    const frag = document.createDocumentFragment();
    for(let c=0;c<PAGE && i<list.length;c++,i++){
      const ch = list[i];
      const card = document.createElement('div');
      card.className = 'card';
      const title = document.createElement('h3');
      title.textContent = ch.name || `Canale ${i+1}`;
      const meta = document.createElement('div');
      meta.className = 'meta';
      if(ch.tvg_logo){
        const img = document.createElement('img');
        img.loading='lazy'; img.decoding='async'; img.referrerPolicy='no-referrer';
        img.src = ch.tvg_logo; img.alt = '';
        meta.appendChild(img);
      }
      const chip = document.createElement('span');
      chip.className='chip';
      chip.textContent = ch.group || '—';
      chip.title = 'Categoria';
      meta.appendChild(chip);

      const btn = document.createElement('button');
      btn.textContent = 'Riproduci';
      btn.onclick = () => playChannel(ch);

      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(btn);
      frag.appendChild(card);
    }
    channelsEl.appendChild(frag);
    if(i<list.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function logSectionStats() {
  const counts = { live:0, film:0, series:0, other:0 };
  for (const ch of allChannels) {
    const k = kindOf(ch);
    if (k==='live') counts.live++;
    else if (k==='film') counts.film++;
    else if (k==='series') counts.series++;
    else counts.other++;
  }
  console.log('Totali playlist =>', counts, 'Totale:', allChannels.length);
}


/* ====== FILTRO (testo + categoria) ====== */
function applyFilter(query=''){
  const q = normalize(query);
  filteredChannels = allChannels.filter(ch => {
    // Sezione (Live/Film/Serie)
    const k = kindOf(ch);
    if (k !== activeSection) return false;

    // Categoria (drawer)
    const inCat = (activeCategory==='Tutte') || ((ch.group||'Senza categoria')===activeCategory);
    if (!inCat) return false;

    // Ricerca testuale
    if (!q || looksLikeUrl(query)) return true; // se è URL o vuoto, ignora search
    const s1 = normalize(ch.name||'');
    const s2 = normalize(ch.url||'');
    return s1.includes(q) || s2.includes(q);
  });

  renderChannelsPaged(filteredChannels);
  filterCounter.textContent = allChannels.length
    ? `Mostrati ${filteredChannels.length} / ${allChannels.length} elementi (${activeSection.toUpperCase()})`
    : '';
    logSectionStats();

}


/* ====== CARICAMENTO PLAYLIST ====== */
async function loadPlaylist(url, {save=true} = {}) {
  channelsEl.innerHTML = '<p style="color:#8aa2b7">Carico playlist…</p>';
  const myGen = requestGen;

  try{
    if (currentPlaylistAbort) currentPlaylistAbort.abort();
    currentPlaylistAbort = new AbortController();

    const q = new URLSearchParams({ debug:'0', url, limit: 20000 });
    const res = await fetch(`${window.api.proxyBase()}/api/playlist?${q.toString()}`, {
      signal: currentPlaylistAbort.signal
    });
    if(!res.ok){
      if (myGen !== requestGen) return;
      const err = await res.json().catch(()=>({}));
      channelsEl.innerHTML = `<p style="color:#f59090">Errore: ${err.error || res.status}</p>`;
      return;
    }
    const { channels } = await res.json();

    if (myGen !== requestGen) return;

    allChannels = (channels||[]).map(x => ({ ...x, group: x.group || x.group_title || 'Senza categoria' }));
    if(save){
      const cacheKey = 'playlistCache::'+url;
      localStorage.setItem(cacheKey, JSON.stringify({ when:Date.now(), channels: allChannels }));
      await window.api.setSettings({ playlistUrl:url, adminUrl: settingAdmin.value.trim() });
    }

    buildCategories();
    activeCategory = 'Tutte';
    applyFilter('');
  }catch(e){
    if (e?.name === 'AbortError') return;
    if (myGen !== requestGen) return;
    channelsEl.innerHTML = `<p style="color:#f59090">Errore nel caricamento: ${e?.message||e}</p>`;
  } finally {
    currentPlaylistAbort = null;
  }
}

function clearLocalPlaylistCaches(){
  try{
    const toDelete = [];
    for (let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      if (k && k.startsWith('playlistCache::')) toDelete.push(k);
    }
    for (const k of toDelete) localStorage.removeItem(k);
  }catch{}
}

async function resetFrontendState(){
  requestGen++;
  try{ if (currentPlaylistAbort) currentPlaylistAbort.abort(); }catch{}
  try{
    if(window.currentSessionId){
      await fetch(`${window.api.proxyBase()}/api/remuxHls/stop`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sessionId:window.currentSessionId})
      });
      window.currentSessionId = null;
    }
  }catch{}
  try{
    if(hlsInstance){ hlsInstance.destroy(); hlsInstance=null; }
    video.pause(); video.removeAttribute('src'); video.load();
  }catch{}

  clearLocalPlaylistCaches();

  allChannels = [];
  filteredChannels = [];
  categories = [];
  activeCategory = 'Tutte';
  channelsEl.innerHTML = '';
  filterCounter.textContent = '';
  playerSection.classList.add('hidden');
  currentChannel.textContent = '-';
}

/* ====== PLAYER ====== */
async function waitForSegments(url, maxMs=10000){
  const start=Date.now(); let delay=300;
  while(Date.now()-start < maxMs){
    try{
      const r = await fetch(url, {method:'GET', cache:'no-store'});
      if(r.ok){
        const txt = await r.text();
        if(/#EXTINF:\d+/.test(txt) && /\.ts/i.test(txt)) return true;
      }
    }catch{}
    await sleep(delay);
    delay = Math.min(delay+50,500);
  }
  return true;
}

async function stopRemux(sessionId){
  try{
    await fetch(`${window.api.proxyBase()}/api/remuxHls/stop`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sessionId})
    });
  }catch{}
}

function attachVideoSource(url){
  if(window.Hls && Hls.isSupported()){
    const hls = new Hls({
      debug:false, enableWorker:true, lowLatencyMode:false,
      backBufferLength:90, maxBufferLength:30, maxMaxBufferLength:60,
      manifestLoadingTimeOut:20000, manifestLoadingMaxRetry:4, manifestLoadingRetryDelay:800,
      levelLoadingTimeOut:20000, levelLoadingMaxRetry:3, levelLoadingRetryDelay:800,
      fragLoadingTimeOut:15000, fragLoadingMaxRetry:5, fragLoadingRetryDelay:800,
      startFragPrefetch:true, testBandwidth:false, startLevel:-1, autoStartLoad:true
    });
    hlsInstance = hls;
    let started=false; const kick=()=>{ if(started) return; video.play().then(()=>{started=true}).catch(()=>{}) };
    hls.on(Hls.Events.MANIFEST_PARSED, kick);
    hls.on(Hls.Events.LEVEL_LOADED,   kick);
    hls.on(Hls.Events.BUFFER_APPENDED,kick);
    hls.on(Hls.Events.ERROR,(e,d)=>{
      if(d.fatal){
        if(d.type===Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else if(d.type===Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else { hls.destroy(); alert('Errore fatale durante la riproduzione.'); }
      }
    });
    hls.loadSource(url); hls.attachMedia(video);
  }else{
    video.src = url;
    video.play().catch(()=>{ /* click to start */ });
  }
  video.controls = true; video.muted = false;
}

async function playChannel(ch){
  currentChannel.textContent = ch.name || '';
  playerSection.classList.remove('hidden');

  if(hlsInstance){ try{hlsInstance.destroy()}catch{} hlsInstance=null; }
  video.pause(); video.removeAttribute('src'); video.load();

  // Se HLS diretto
  if((ch.url||'').toLowerCase().endsWith('.m3u8')){
    try{
      const r = await fetch(`${window.api.proxyBase()}/api/hlsProxy?url=${encodeURIComponent(ch.url)}`);
      if(!r.ok){ alert('HLS proxy non disponibile'); return; }
      const { m3u8Url } = await r.json();
      attachVideoSource(`${window.api.proxyBase()}${m3u8Url}`);
      return;
    }catch(e){ alert('Errore proxy HLS: '+ e.message); return; }
  }

  // Altrimenti remux
  if (window.currentSessionId) await stopRemux(window.currentSessionId);
  try {
    const g = (ch.group || '').toLowerCase();
    let vodHint = '';
    if (/(^|[^a-z])serie\s*tv([^a-z]|$)/i.test(g)) vodHint = 'series';
    else if (/film|primevisioni|sottotitoli|sub/i.test(g)) vodHint = 'movie';

    const url = `${window.api.proxyBase()}/api/remuxHls?url=${encodeURIComponent(ch.url)}${vodHint ? `&vodHint=${vodHint}` : ''}`;

    const res = await fetch(url);
    if (!res.ok) { alert('Remux non disponibile: ' + res.status); return; }
    const { m3u8Url, sessionId } = await res.json();
    window.currentSessionId = sessionId;
    const full = `${window.api.proxyBase()}${m3u8Url}`;
    await waitForSegments(full, 15000);
    attachVideoSource(full);
  } catch (e) { alert('Errore remux: ' + e.message); }
}

/* ====== EVENTI ====== */
btnLoad.onclick = async () => {
  const val = playlistInput.value.trim();
  if(!val) return;
  if(looksLikeUrl(val)) await loadPlaylist(val);
  else applyFilter(val);
};
playlistInput.addEventListener('keydown', async (e)=>{
  if(e.key==='Enter'){ e.preventDefault(); btnLoad.click(); }
});

let debounce;
playlistInput.addEventListener('input', ()=>{
  const v = playlistInput.value;
  if(looksLikeUrl(v)) return;
  clearTimeout(debounce);
  debounce = setTimeout(()=> applyFilter(v), 140);
});

saveSettings.onclick = async ()=>{
  await window.api.setSettings({
    playlistUrl: settingPlaylist.value.trim(),
    adminUrl: settingAdmin.value.trim()
  });
  alert('Impostazioni salvate.');
};

if (btnClearMemory) {
  btnClearMemory.onclick = async () => {
    const ok = confirm(
      'Svuotare completamente la memoria?\n\n- Cancellerà la cache server\n- Cancellerà la cache locale\n- Cancellerà la playlist mostrata\n\nProcedere?'
    );
    if (!ok) return;

    try { await fetch(`${window.api.proxyBase()}/api/resetCache`, { method: 'POST' }); } catch {}
    allChannels = [];
    filteredChannels = [];
    categories = [];
    activeCategory = 'Tutte';
    channelsEl.innerHTML = '<p style="color:#8aa2b7">Nessuna playlist caricata.</p>';
    filterCounter.textContent = '';
    playerSection.classList.add('hidden');
    currentChannel.textContent = '-';
    playlistInput.value = '';
    settingPlaylist.value = '';
    localStorage.clear();
    await window.api.setSettings({ playlistUrl: '', adminUrl: settingAdmin.value.trim() });
    alert('Memoria completamente svuotata. Nessuna playlist caricata.');
  };
}

async function loadSettings(){
  const s = await window.api.getSettings();
  settingPlaylist.value = s.playlistUrl || '';
  settingAdmin.value   = s.adminUrl   || '';

  if (!s.playlistUrl) {
    allChannels = []; filteredChannels = []; categories = []; activeCategory = 'Tutte';
    playlistInput.value = '';
    channelsEl.innerHTML = '<p style="color:#8aa2b7">Nessuna playlist caricata.</p>';
    filterCounter.textContent = '';
    catList.innerHTML = '';
    return;
  }

  playlistInput.value = s.playlistUrl;

  try {
    const cached = JSON.parse(localStorage.getItem('playlistCache::' + s.playlistUrl) || 'null');
    if (cached && Array.isArray(cached.channels) && cached.channels.length) {
      allChannels = cached.channels.map(x => ({ ...x, group: x.group || x.group_title || 'Senza categoria' }));
      setSection('live');
    } else {
      setSection('live');
    }
  } catch { setSection('live'); }

  await loadPlaylist(s.playlistUrl, { save: true });
  setSection('live');
}

window.addEventListener('beforeunload', async ()=>{
  if(window.currentSessionId) await stopRemux(window.currentSessionId);
  if(hlsInstance){ try{hlsInstance.destroy()}catch{} }
});
loadSettings();
