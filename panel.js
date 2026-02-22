// SpeakPath panel.js — compact floating window
// Same logic as popup.js but adapted for the tiny always-on-top panel.

const $ = id => document.getElementById(id);

let armed = false, triggered = false, forceAI = false;
let recognition = null, restartTimer = null, micStream = null;
let bgPort = null, audioQueue = [], isPlaying = false;
let commandHistory = [], historyIdx = -1;
let stats    = { actions:0, local:0, ai:0, saved:0 };
let settings = {
  apiKey:'', openaiKey:'',
  apiEndpoint:'https://api.cometapi.com/v1/chat/completions',
  triggerWord:'test', stopPhrase:'stop listening',
  confidenceThreshold:0.65, sttLang:'en-US',
};

const FIXES = {
  'scroll':     ['scrawl','crawl','stroll','squall'],
  'click':      ['cclick','kclick','klick'],
  'submit':     ['some it','summit','sub-mit'],
  'search':     ['surge','church','lurch'],
  'youtube':    ['you tube','your tube',"you're tube",'utube'],
  'github':     ['get hub','git hub','get up'],
  'google':     ['goggle','googol'],
  'refresh':    ['re fresh','refreshed'],
  'download':   ['down load'],
  'fullscreen': ['full scream','for screen'],
};
const FILLERS = /^(um+|uh+|er+|hmm+|ah+|like\s|so\s|okay\s|ok\s|well\s|right\s|yeah\s|hey\s|please\s+)?/i;

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  renderSettings();
  setupWave();
  setupMic();
  setupTypeInput();
  setupQuickCmds();
  setupSettingsPanel();
  connectBg();

  // Auto-resume if was armed
  const state = await chrome.runtime.sendMessage({ type:'GET_ARM_STATE' }).catch(()=>({armed:false}));
  if (state?.armed) {
    triggered = state.triggered || false;
    await startAll();
  }

  // Close button
  $('closeBtn').addEventListener('click', () => window.close());
}

// ─── BACKGROUND CONNECTION ────────────────────────────────────────────────────
function connectBg() {
  try {
    bgPort = chrome.runtime.connect({ name:'popup' });
    bgPort.onMessage.addListener(handleBgMsg);
    bgPort.onDisconnect.addListener(() => { bgPort=null; setTimeout(connectBg,1000); });
  } catch(e) { setTimeout(connectBg,2000); }
}

function handleBgMsg(msg) {
  switch(msg.type) {
    case 'COMMAND_RESULT': {
      const tl = {fast:'MINIMAX',standard:'GEMINI',haiku:'HAIKU',fallback:'AI'}[msg.tier]||'LOCAL';
      $('lastTier').textContent = tl;
      if (msg.success) {
        stats.actions++;
        if (!msg.tier||msg.tier==='LOCAL'){stats.local++;stats.saved++;}else stats.ai++;
        saveStats();
        showOut(`✓ ${msg.message}`, 'ok');
      } else {
        showOut(`⚠ ${msg.error}`, 'err');
      }
      resetAfterCmd();
      break;
    }
    case 'SPEAK_RESULT': {
      const label = msg.command ? msg.command.toUpperCase()+': ' : '';
      const preview = (msg.text||'').slice(0,100);
      showOut(`🔊 ${label}${preview}${(msg.text?.length||0)>100?'…':''}`, 'ok');
      resetAfterCmd();
      break;
    }
    case 'PLAY_AUDIO':   queueAudio(msg.audioB64, msg.mimeType); break;
    case 'TTS_FALLBACK': speakBrowser(msg.text); break;
    case 'CONTENT_CMD_START': showOut(`◌ ${(msg.command||'').toUpperCase()}…`, 'thinking'); break;
    case 'ARM_STATE':
      if (!msg.armed && armed) stopAll('bg');
      break;
  }
}

function resetAfterCmd() {
  triggered = false;
  chrome.runtime.sendMessage({type:'SET_ARM_STATE',armed,triggered:false});
  if (armed) setTimeout(() => {
    setMicUI('armed');
    setSbar('armed', `ARMED — SAY "${tw()}" TO ACTIVATE`);
    $('txWrap').classList.remove('triggered');
    $('waveLbl').classList.remove('hidden');
    $('txInterim').style.display = 'none';
  }, 1000);
}

const tw = () => (settings.triggerWord||'test').toUpperCase();

// ─── SPEECH RECOGNITION ───────────────────────────────────────────────────────
function startRec() {
  if (!armed) return;
  clearTimeout(restartTimer);
  const SR = window.SpeechRecognition||window.webkitSpeechRecognition;
  if (!SR) { showOut('⚠ Use Chrome for voice', 'err'); return; }
  if (recognition) { try{recognition.abort();}catch(e){} recognition=null; }

  recognition = new SR();
  recognition.lang = settings.sttLang||'en-US';
  recognition.interimResults  = true;
  recognition.maxAlternatives = 5;
  recognition.continuous      = false;

  recognition.onresult = (e) => {
    let bestFinal='', bestInterim='', bestConf=-1;
    for (const result of e.results) {
      if (result.isFinal) {
        for (let i=0;i<result.length;i++) {
          const alt=result[i], txt=(alt.transcript||'').trim(), conf=alt.confidence||0.5;
          if (hasTrigger(txt)&&conf>bestConf-0.3){bestFinal=txt;bestConf=conf;break;}
          if (conf>bestConf){bestFinal=txt;bestConf=conf;}
        }
      } else { bestInterim=result[0].transcript; }
    }

    if (bestInterim && !bestFinal) {
      $('txInterim').textContent   = bestInterim;
      $('txInterim').style.display = 'inline';
    }
    if (!bestFinal) return;
    $('txInterim').style.display = 'none';

    const cleaned = clean(bestFinal);
    if (!cleaned||cleaned.length<2) return;

    // Stop phrase
    if (cleaned.toLowerCase().includes((settings.stopPhrase||'stop listening').toLowerCase())) {
      stopAll('phrase');
      showOut('🛑 Stopped — click mic to restart', 'ok');
      speakBrowser('Listening stopped.');
      return;
    }

    if (!triggered) {
      if (hasTrigger(cleaned)) {
        triggered = true;
        chrome.runtime.sendMessage({type:'SET_ARM_STATE',armed:true,triggered:true});
        const cmd = stripTrigger(cleaned);
        setMicUI('heard');
        setSbar('heard','TRIGGER HEARD…');
        $('txWrap').classList.add('triggered');
        $('waveLbl').classList.add('hidden');
        if (cmd && cmd.length>1) {
          setTx(cmd); addHist(cmd);
          showOut('<span class="spin">◌</span> Processing…','thinking');
          dispatch(cmd);
        } else {
          showOut('<span class="spin">◌</span> Say command…','thinking');
        }
      } else { setTx(cleaned, true); }
    } else {
      if (cleaned.length>1) {
        setTx(cleaned); addHist(cleaned);
        showOut('<span class="spin">◌</span> Processing…','thinking');
        dispatch(cleaned);
      }
    }
  };

  recognition.onerror = (e) => {
    if (!armed) return;
    if (e.error==='not-allowed') {
      showOut('🚫 Mic blocked — allow in Chrome settings', 'err');
      stopAll('denied'); return;
    }
    if (e.error==='no-speech'||e.error==='aborted') return;
    console.warn('[STT]', e.error);
  };

  recognition.onend = () => { if (armed) restartTimer=setTimeout(startRec,120); };

  try { recognition.start(); } catch(e) { if (armed) restartTimer=setTimeout(startRec,500); }
}

function stopRec() {
  clearTimeout(restartTimer);
  if (recognition) { try{recognition.abort();}catch(e){} recognition=null; }
}

async function startAll() {
  if (!micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({audio:true});
    } catch(e) {
      if (e.name==='NotAllowedError'||e.name==='PermissionDeniedError') {
        showOut('🚫 Mic denied — allow in Chrome', 'err');
        return;
      }
    }
  }
  armed=true; triggered=false;
  chrome.runtime.sendMessage({type:'SET_ARM_STATE',armed:true,triggered:false});
  startRec(); syncMicUI(); window._waveStart?.();
}

function stopAll(reason) {
  armed=false; triggered=false; stopRec();
  if (micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null;}
  chrome.runtime.sendMessage({type:'SET_ARM_STATE',armed:false,triggered:false});
  setMicUI('idle');
  setSbar('idle','IDLE — CLICK MIC');
  $('txWrap').classList.remove('triggered');
  $('waveLbl').classList.remove('hidden');
  $('txInterim').style.display='none';
  window._waveStop?.();
}

// ─── MIC SETUP ────────────────────────────────────────────────────────────────
function setupMic() {
  $('micBtn').addEventListener('click', ()=> armed ? stopAll('manual') : startAll());
}

function syncMicUI() {
  if (armed) { setMicUI('armed'); setSbar('armed',`ARMED — SAY "${tw()}" TO ACTIVATE`); window._waveStart?.(); }
  else       { setMicUI('idle'); setSbar('idle','IDLE — CLICK MIC'); window._waveStop?.(); }
}

function setMicUI(state) {
  const btn=$('micBtn'), lbl=$('micLbl'), ico=btn.querySelector('.mic-ico');
  btn.classList.remove('armed','heard'); lbl.classList.remove('on');
  if (state==='armed') { btn.classList.add('armed'); lbl.classList.add('on'); lbl.textContent='LISTENING — CLICK TO STOP'; ico.textContent='🎙'; }
  else if (state==='heard') { btn.classList.add('heard'); lbl.textContent='COMMAND RECEIVED'; ico.textContent='⚡'; }
  else { lbl.textContent='CLICK TO START'; ico.textContent='🎙'; }
}

function setSbar(state, text) {
  const dot=$('dot'); dot.className='dot';
  if (state==='armed') dot.classList.add('on');
  if (state==='heard') dot.classList.add('wait');
  $('sbarTxt').textContent=text;
}

// ─── TEXT HELPERS ─────────────────────────────────────────────────────────────
function clean(raw) {
  let t=raw.trim();
  t=t.replace(FILLERS,'').trim();
  const snap=t.toLowerCase();
  for (const [correct,wrongs] of Object.entries(FIXES)) {
    for (const wrong of wrongs) {
      if (snap.includes(wrong)) {
        const esc=wrong.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        t=t.replace(new RegExp(esc,'gi'),correct);
      }
    }
  }
  t=t.replace(/^(?:hey\s+)?(?:speak\s*path|speakpad|navigate\s+to|computer|ok\s+google)[,\s]+/i,'').trim();
  return t.replace(/\s+/g,' ').trim();
}
function hasTrigger(text){return text.toLowerCase().includes((settings.triggerWord||'test').toLowerCase());}
function stripTrigger(text){
  const tw=(settings.triggerWord||'test').toLowerCase();
  const idx=text.toLowerCase().indexOf(tw);
  if(idx===-1)return text.trim();
  return text.slice(idx+tw.length).replace(/^[,\s]+/,'').trim();
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
function setTx(text, interim=false) {
  const ph=$('txPh'),tx=$('txText');
  if(text){ph.style.display='none';tx.style.display='inline';tx.textContent=text;tx.style.opacity=interim?'0.5':'1';$('txWrap').classList.add('active');}
  else{ph.style.display='inline';tx.style.display='none';$('txWrap').classList.remove('active','triggered');}
}
function showOut(msg, type='thinking') {
  const b=$('outBox'); b.className=`out show ${type}`; b.innerHTML=msg;
}

// ─── DISPATCH ─────────────────────────────────────────────────────────────────
async function dispatch(command) {
  const resp = await chrome.runtime.sendMessage({type:'MANUAL_COMMAND',command}).catch(e=>({ok:false,error:e.message}));
  if (resp&&!resp.ok&&resp.error) { showOut(`⚠ ${resp.error}`,'err'); resetAfterCmd(); }
}

// ─── TYPE INPUT ───────────────────────────────────────────────────────────────
function setupTypeInput() {
  const inp=$('typeInput'), btn=$('goBtn');
  btn.addEventListener('click',()=>{
    const cmd=inp.value.trim(); if(!cmd)return;
    addHist(cmd); setTx(cmd); showOut('<span class="spin">◌</span> Processing…','thinking');
    dispatch(cmd); inp.value=''; historyIdx=-1;
  });
  inp.addEventListener('keydown',e=>{
    if(e.key==='Enter'){btn.click();return;}
    if(e.key==='ArrowUp'){e.preventDefault();historyIdx=Math.min(historyIdx+1,commandHistory.length-1);inp.value=commandHistory[historyIdx]||'';}
    if(e.key==='ArrowDown'){e.preventDefault();historyIdx=Math.max(historyIdx-1,-1);inp.value=historyIdx>=0?commandHistory[historyIdx]:'';}
  });
}

function setupQuickCmds() {
  document.querySelectorAll('.qc').forEach(el=>{
    el.addEventListener('click',()=>{
      const cmd=el.dataset.cmd;
      setTx(cmd); addHist(cmd); showOut('<span class="spin">◌</span> Processing…','thinking');
      dispatch(cmd);
    });
  });
}

// ─── HISTORY ──────────────────────────────────────────────────────────────────
function addHist(cmd){if(!cmd||commandHistory[0]===cmd)return;commandHistory.unshift(cmd);commandHistory=commandHistory.slice(0,20);historyIdx=-1;try{localStorage.setItem('sp_hist',JSON.stringify(commandHistory));}catch(e){}}

// ─── WAVEFORM ─────────────────────────────────────────────────────────────────
function setupWave() {
  const canvas=$('wave'); if(!canvas)return;
  const ctx=canvas.getContext('2d');
  const W=canvas.width=256, H=canvas.height=32;
  function idle(){ctx.clearRect(0,0,W,H);ctx.strokeStyle='#1a1a2e';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();}
  idle();
  let id=null,t=0;
  function start(){
    if(id)return;
    function fr(){id=requestAnimationFrame(fr);t+=0.06;ctx.clearRect(0,0,W,H);ctx.fillStyle='#050508';ctx.fillRect(0,0,W,H);
    [['rgba(0,255,157,0.1)',2],['#00ff9d',1]].forEach(([c,lw],i)=>{ctx.beginPath();ctx.lineWidth=lw;ctx.strokeStyle=c;for(let x=0;x<=W;x++){const a=6+2*Math.sin(t*0.8+i);const y=H/2+a*Math.sin((x/W)*Math.PI*4+t+i*0.6);x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}ctx.stroke();});}
    fr();
  }
  function stop(){if(id){cancelAnimationFrame(id);id=null;idle();}}
  window._waveStart=start; window._waveStop=stop;
}

// ─── AUDIO ────────────────────────────────────────────────────────────────────
function queueAudio(b64,mimeType){audioQueue.push({b64,mimeType});if(!isPlaying)playNext();}
async function playNext(){
  if(!audioQueue.length){isPlaying=false;return;}isPlaying=true;
  const{b64,mimeType}=audioQueue.shift();
  try{const bytes=atob(b64),arr=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)arr[i]=bytes.charCodeAt(i);
  const url=URL.createObjectURL(new Blob([arr],{type:mimeType||'audio/mpeg'}));
  const a=new Audio(url);a.onended=()=>{URL.revokeObjectURL(url);setTimeout(playNext,80);};a.onerror=()=>{URL.revokeObjectURL(url);playNext();};await a.play();}
  catch(e){isPlaying=false;playNext();}
}
function speakBrowser(text){if(!text||!speechSynthesis)return;speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text.slice(0,800));u.rate=1.05;speechSynthesis.speak(u);}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
async function loadSettings(){
  return new Promise(resolve=>{
    chrome.storage.local.get(['sp_settings'],r=>{
      if(r.sp_settings)settings={...settings,...r.sp_settings};
      resolve();
    });
  });
}
function renderSettings(){
  $('twDisplay').textContent=(settings.triggerWord||'test').toUpperCase();
  $('s_apiKey').value    =settings.apiKey||'';
  $('s_openaiKey').value =settings.openaiKey||'';
  $('s_endpoint').value  =settings.apiEndpoint;
  $('s_trigger').value   =settings.triggerWord||'test';
  $('s_stop').value      =settings.stopPhrase||'stop listening';
  $('s_conf').value      =String(settings.confidenceThreshold);
  $('s_lang').value      =settings.sttLang||'en-US';
}
function saveSettings(){
  settings.apiKey              =$('s_apiKey').value.trim();
  settings.openaiKey           =$('s_openaiKey').value.trim();
  settings.apiEndpoint         =$('s_endpoint').value.trim()||'https://api.cometapi.com/v1/chat/completions';
  settings.triggerWord         =($('s_trigger').value.trim()||'test').toLowerCase();
  settings.stopPhrase          =($('s_stop').value.trim()||'stop listening').toLowerCase();
  settings.confidenceThreshold =parseFloat($('s_conf').value);
  settings.sttLang             =$('s_lang').value;
  chrome.storage.local.set({sp_settings:settings},()=>{
    $('twDisplay').textContent=(settings.triggerWord||'test').toUpperCase();
    chrome.runtime.sendMessage({type:'SETTINGS_UPDATED',triggerWord:settings.triggerWord,stopPhrase:settings.stopPhrase,lang:settings.sttLang});
    $('settingsPanel').classList.remove('open');
    showOut('✓ Saved','ok');
    if(armed){stopRec();setTimeout(startRec,300);}
  });
}
function saveStats(){chrome.storage.local.set({sp_stats:stats});}

// ─── SETTINGS PANEL ───────────────────────────────────────────────────────────
function setupSettingsPanel(){
  $('settingsBtn').addEventListener('click',()=>$('settingsPanel').classList.toggle('open'));
  $('s_save').addEventListener('click',saveSettings);
  $('s_trigger').addEventListener('input',()=>$('twDisplay').textContent=($('s_trigger').value.trim()||'test').toUpperCase());
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
init();
