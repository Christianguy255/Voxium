// Voxium popup.js — v7
// STT runs in popup (only place Chrome allows Web Speech API with mic).
// Background stores arm state + processes commands so reopening popup auto-resumes.

const $ = id => document.getElementById(id);

// ─── STATE ────────────────────────────────────────────────────────────────────
let armed          = false;
let triggered      = false;
let forceAI        = false;
let recognition    = null;
let restartTimer   = null;
let micStream      = null;  // keep getUserMedia stream alive so SpeechRecognition works
let bgPort         = null;
let audioQueue     = [];
let isPlaying      = false;
let commandHistory = [];
let historyIdx     = -1;
let stats          = { actions: 0, local: 0, ai: 0, saved: 0 };
let settings       = {
  apiKey:              '',
  openaiKey:           '',
  apiEndpoint:         'https://api.cometapi.com/v1/chat/completions',
  triggerWord:         'test',
  stopPhrase:          'stop listening',
  confidenceThreshold: 0.65,
  sttLang:             'en-US',
};

const FIXES = {
  'scroll':     ['scrawl','crawl','stroll','squall'],
  'click':      ['lick','flick','brick','thick','cclick'],
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
  await loadStats();
  loadHistory();
  renderStats();
  setupViews();
  setupWave();
  setupTypeInput();
  setupMicButton();
  checkApiKey();
  updateTriggerDisplays();
  connectToBackground();
  renderHistoryChips();

  // Check mic permission state (don't show banner unless actually denied)
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    if (p.state === 'denied') applyMicState('denied');
    // 'granted' or 'prompt' — don't show banner, let user click mic
    p.onchange = () => { if (p.state === 'denied') applyMicState('denied'); };
  } catch(e) {}

  // Auto-resume if background says we were armed
  const state = await chrome.runtime.sendMessage({ type: 'GET_ARM_STATE' }).catch(()=>({armed:false}));
  if (state?.armed) {
    triggered = state.triggered || false;
    await startAll(); // startAll acquires getUserMedia stream then starts recognition
  }
}

// ─── BACKGROUND PORT ──────────────────────────────────────────────────────────
function connectToBackground() {
  try {
    bgPort = chrome.runtime.connect({ name: 'popup' });
    bgPort.onMessage.addListener(handleBgMessage);
    bgPort.onDisconnect.addListener(() => {
      bgPort = null;
      setTimeout(connectToBackground, 1000);
    });
  } catch(e) { setTimeout(connectToBackground, 2000); }
}

function handleBgMessage(msg) {
  switch (msg.type) {
    case 'ARM_STATE':
      // Background tells us arm state changed (e.g. stop phrase from another context)
      if (!msg.armed && armed) { stopAll('stop_phrase'); }
      break;

    case 'COMMAND_RESULT': {
      const tl = { fast:'DOUBAO', standard:'GEMINI', haiku:'HAIKU', fallback:'AI' }[msg.tier] || 'LOCAL';
      $('lastTier').textContent = tl;
      if (msg.success) {
        stats.actions++;
        if (!msg.tier || msg.tier === 'LOCAL') { stats.local++; stats.saved++; }
        else stats.ai++;
        saveStats(); renderStats();
        showOut(`✓ ${msg.message} · ${tl}`, 'ok');
      } else {
        showOut(`⚠ ${msg.error}`, 'err');
      }
      resetAfterCommand();
      break;
    }

    case 'SPEAK_RESULT': {
      const label   = msg.command ? msg.command.toUpperCase() + ': ' : '';
      const preview = (msg.text || '').slice(0, 140);
      showOut(`🔊 ${label}<em>${preview}${(msg.text?.length||0) > 140 ? '…' : ''}</em>`, 'ok');
      resetAfterCommand();
      break;
    }

    case 'PLAY_AUDIO':
      queueAudio(msg.audioB64, msg.mimeType);
      break;

    case 'TTS_FALLBACK':
      speakBrowser(msg.text);
      break;

    case 'CONTENT_CMD_START':
      showOut(`<span class="spin">◌</span> ${msg.command?.toUpperCase()}…`, 'thinking');
      break;
  }
}

function resetAfterCommand() {
  triggered = false;
  chrome.runtime.sendMessage({ type: 'SET_ARM_STATE', armed, triggered: false });
  if (armed) {
    setTimeout(() => {
      setMicUI('armed');
      setSbarState('armed', `ARMED — SAY "${tw()}" TO ACTIVATE`);
      $('txBox').classList.remove('triggered');
      $('waveLbl').classList.remove('hidden');
      $('txInterim').style.display = 'none';
    }, 1200);
  }
}

function tw() { return (settings.triggerWord || 'test').toUpperCase(); }

// ─── SPEECH RECOGNITION (runs in popup) ──────────────────────────────────────
function startRec() {
  if (!armed) return;
  clearTimeout(restartTimer);

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showOut('⚠ Browser speech API not supported. Use Chrome.', 'err');
    return;
  }

  if (recognition) {
    try { recognition.abort(); } catch(e) {}
    recognition = null;
  }

  recognition = new SR();
  recognition.lang            = settings.sttLang || 'en-US';
  recognition.interimResults  = true;
  recognition.maxAlternatives = 5;
  recognition.continuous      = false;

  recognition.onstart = () => {
    // Clear any previous mic error
    if ($('micPermBanner').style.display !== 'none' &&
        !$('micPermBanner').classList.contains('err-denied')) {
      $('micPermBanner').style.display = 'none';
    }
  };

  recognition.onresult = (e) => {
    let bestFinal = '', bestInterim = '', bestConf = -1;

    for (const result of e.results) {
      if (result.isFinal) {
        for (let i = 0; i < result.length; i++) {
          const alt  = result[i];
          const txt  = (alt.transcript || '').trim();
          const conf = alt.confidence || 0.5;
          if (containsTrigger(txt) && conf > bestConf - 0.3) { bestFinal = txt; bestConf = conf; break; }
          if (conf > bestConf) { bestFinal = txt; bestConf = conf; }
        }
      } else {
        bestInterim = result[0].transcript;
      }
    }

    if (bestInterim && !bestFinal) {
      $('txInterim').textContent   = bestInterim;
      $('txInterim').style.display = 'inline';
    }

    if (!bestFinal) return;
    $('txInterim').style.display = 'none';

    const cleaned = cleanText(bestFinal);
    if (!cleaned || cleaned.length < 2) return;

    // ── STOP PHRASE ────────────────────────────────────────────────────────────
    const sp = (settings.stopPhrase || 'stop listening').toLowerCase();
    if (cleaned.toLowerCase().includes(sp)) {
      stopAll('stop_phrase');
      showOut(`🛑 Stopped. Click mic to restart.`, 'ok');
      speakBrowser('Listening stopped.');
      return;
    }

    // ── TRIGGER DETECTION ──────────────────────────────────────────────────────
    if (!triggered) {
      if (containsTrigger(cleaned)) {
        triggered = true;
        chrome.runtime.sendMessage({ type: 'SET_ARM_STATE', armed: true, triggered: true });
        const command = stripTrigger(cleaned);

        setMicUI('heard');
        setSbarState('heard', 'TRIGGER HEARD…');
        $('txBox').classList.add('triggered');
        $('waveLbl').classList.add('hidden');

        if (command && command.length > 1) {
          setTranscript(command);
          addToHistory(command);
          showOut('<span class="spin">◌</span> Processing…', 'thinking');
          dispatchCommand(command);
        } else {
          showOut('<span class="spin">◌</span> Say your command now…', 'thinking');
        }
      } else {
        setTranscript(cleaned, true); // ambient — show dimly
      }
    } else {
      // Already triggered — this utterance IS the command
      if (cleaned.length > 1) {
        setTranscript(cleaned);
        addToHistory(cleaned);
        showOut('<span class="spin">◌</span> Processing…', 'thinking');
        dispatchCommand(cleaned);
      }
    }
  };

  recognition.onerror = (e) => {
    if (!armed) return;
    if (e.error === 'not-allowed') {
      // This means Chrome ACTUALLY blocked mic — show real help
      showOut('🚫 Mic blocked by Chrome. Check chrome://settings/content/microphone', 'err');
      applyMicState('denied');
      stopAll('denied');
      return;
    }
    if (e.error === 'no-speech' || e.error === 'aborted') return; // normal, just restart
    // Any other error — show briefly but keep trying
    console.warn('[STT] error:', e.error);
    showOut(`⚠ STT: ${e.error} — retrying…`, 'err');
  };

  recognition.onend = () => {
    if (armed) {
      // Auto-restart with small delay to avoid rapid-fire restarts
      restartTimer = setTimeout(startRec, 120);
    }
  };

  try {
    recognition.start();
  } catch(e) {
    if (armed) restartTimer = setTimeout(startRec, 500);
  }
}

function stopRec() {
  clearTimeout(restartTimer);
  if (recognition) {
    try { recognition.abort(); } catch(e) {}
    recognition = null;
  }
}

async function startAll() {
  // Must keep a getUserMedia stream alive — Chrome requires an active media
  // stream before SpeechRecognition will grant mic access in an extension popup.
  if (!micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch(e) {
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        applyMicState('denied');
        showOut('🚫 Mic access denied. Allow it in Chrome site settings.', 'err');
        return;
      }
      // Any other error — try anyway, SpeechRecognition might still work
      console.warn('[MIC] getUserMedia failed:', e.message);
    }
  }
  armed     = true;
  triggered = false;
  chrome.runtime.sendMessage({ type: 'SET_ARM_STATE', armed: true, triggered: false });
  startRec();
  syncMicUI();
  window._waveStart?.();
}

function stopAll(reason) {
  armed     = false;
  triggered = false;
  stopRec();
  // Release the getUserMedia stream
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  chrome.runtime.sendMessage({ type: 'SET_ARM_STATE', armed: false, triggered: false });
  setMicUI('idle');
  setSbarState('idle', 'IDLE — CLICK MIC TO START');
  $('txBox').classList.remove('triggered');
  $('waveLbl').classList.remove('hidden');
  $('txInterim').style.display = 'none';
  window._waveStop?.();
}

// ─── MIC BUTTON ───────────────────────────────────────────────────────────────
function setupMicButton() {
  $('micBtn').addEventListener('click', () => {
    if (armed) stopAll('manual');
    else startAll(); // startAll handles getUserMedia + permission check
  });

  $('micPermBtn').addEventListener('click', () => startAll());
}

function syncMicUI() {
  if (armed) {
    setMicUI('armed');
    setSbarState('armed', `ARMED — SAY "${tw()}" TO ACTIVATE`);
    window._waveStart?.();
  } else {
    setMicUI('idle');
    setSbarState('idle', 'IDLE — CLICK MIC TO START');
    window._waveStop?.();
  }
}

// ─── TEXT CLEANING ────────────────────────────────────────────────────────────
function cleanText(raw) {
  let t = raw.trim();
  t = t.replace(FILLERS, '').trim();
  const lower = t.toLowerCase();
  for (const [correct, wrongs] of Object.entries(FIXES)) {
    for (const wrong of wrongs) {
      if (lower.includes(wrong)) t = t.replace(new RegExp(wrong, 'gi'), correct);
    }
  }
  t = t.replace(/^(?:hey\s+)?(?:speak\s*path|speakpad|navigate\s+to|computer|ok\s+google)[,\s]+/i, '').trim();
  return t.replace(/\s+/g, ' ').trim();
}
function containsTrigger(text) { return text.toLowerCase().includes((settings.triggerWord || 'test').toLowerCase()); }
function stripTrigger(text) {
  const tw = (settings.triggerWord || 'test').toLowerCase();
  const idx = text.toLowerCase().indexOf(tw);
  if (idx === -1) return text.trim();
  return text.slice(idx + tw.length).replace(/^[,\s]+/, '').trim();
}

// ─── COMMAND DISPATCH ─────────────────────────────────────────────────────────
async function dispatchCommand(command) {
  // Send to background — it handles local match, content AI, navigation AI
  const resp = await chrome.runtime.sendMessage({ type: 'MANUAL_COMMAND', command }).catch(e => ({ ok: false, error: e.message }));
  // Background will send result back via port (handleBgMessage)
  // If it returned an error synchronously, show it
  if (resp && !resp.ok && resp.error) {
    showOut(`⚠ ${resp.error}`, 'err');
    resetAfterCommand();
  }
}

// ─── AUDIO PLAYBACK ───────────────────────────────────────────────────────────
function queueAudio(b64, mimeType) {
  audioQueue.push({ b64, mimeType });
  if (!isPlaying) playNextAudio();
}
async function playNextAudio() {
  if (!audioQueue.length) { isPlaying = false; return; }
  isPlaying = true;
  const { b64, mimeType } = audioQueue.shift();
  try {
    const bytes = atob(b64);
    const arr   = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const url   = URL.createObjectURL(new Blob([arr], { type: mimeType || 'audio/mpeg' }));
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); setTimeout(playNextAudio, 80); };
    audio.onerror = () => { URL.revokeObjectURL(url); playNextAudio(); };
    await audio.play();
  } catch(e) { isPlaying = false; playNextAudio(); }
}
function speakBrowser(text) {
  if (!text || !speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 800));
  u.rate = 1.05; speechSynthesis.speak(u);
}

// ─── WAVEFORM ─────────────────────────────────────────────────────────────────
function setupWave() {
  const canvas = $('wave'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width = 328, H = canvas.height = 56;

  function drawIdle() {
    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle='#1c1c30'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
    ctx.strokeStyle='#12121f';
    for (let x=0;x<W;x+=20){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  }
  drawIdle();

  let animId=null, t=0;
  function startAnim() {
    if (animId) return;
    function frame() {
      animId=requestAnimationFrame(frame); t+=0.05;
      ctx.clearRect(0,0,W,H);
      ctx.fillStyle='#0d0d1a'; ctx.fillRect(0,0,W,H);
      [['rgba(0,255,157,0.12)',3],['#00ff9d',1.5]].forEach(([color,lw],i)=>{
        ctx.beginPath(); ctx.lineWidth=lw; ctx.strokeStyle=color;
        for(let x=0;x<=W;x++){const amp=8+4*Math.sin(t*0.7+i);const y=H/2+amp*Math.sin((x/W)*Math.PI*4+t+i*0.5);x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}
        ctx.stroke();
      });
    }
    frame();
  }
  function stopAnim(){if(animId){cancelAnimationFrame(animId);animId=null;drawIdle();}}
  window._waveStart=startAnim; window._waveStop=stopAnim;
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
function setMicUI(state) {
  const btn=$('micBtn'), lbl=$('micLbl');
  btn.classList.remove('armed','heard'); lbl.classList.remove('armed','heard');
  const ico = btn.querySelector('.mic-ico');
  if (state==='armed') {
    btn.classList.add('armed'); lbl.classList.add('armed');
    lbl.textContent='LISTENING — CLICK TO STOP'; ico.textContent='🎙';
  } else if (state==='heard') {
    btn.classList.add('heard'); lbl.classList.add('heard');
    lbl.textContent='COMMAND RECEIVED'; ico.textContent='⚡';
  } else {
    lbl.textContent='CLICK TO START LISTENING'; ico.textContent='🎙';
  }
}
function setSbarState(state, text) {
  const dot=$('sbarDot'); dot.className='sbar-dot';
  if(state==='armed') dot.classList.add('active');
  if(state==='heard') dot.classList.add('waiting');
  $('sbarText').textContent=text;
}
function setTranscript(text, interim=false) {
  const ph=$('txPh'), tx=$('txText');
  if(text){ph.style.display='none';tx.style.display='inline';tx.textContent=text;tx.style.opacity=interim?'0.5':'1';$('txBox').classList.add('active');}
  else{ph.style.display='block';tx.style.display='none';$('txBox').classList.remove('active','triggered');}
}
function showOut(msg, type='thinking') {
  const box=$('outBox'); box.className=`out-box show ${type}`; box.innerHTML=msg;
}
function checkApiKey() {
  $('noKeyBanner').style.display=(settings.apiKey||settings.openaiKey)?'none':'block';
}
function applyMicState(state) {
  const banner=$('micPermBanner');
  if(state==='denied'){
    banner.style.display='block'; banner.className='banner err'; banner.classList.add('err-denied');
    $('micPermIcon').textContent='🚫';
    $('micPermTitle').textContent='MICROPHONE BLOCKED BY CHROME';
    $('micPermBody').innerHTML='Chrome is blocking mic access.<br><br>To fix: <strong>click the 🔒 lock icon</strong> in Chrome\'s address bar → set Microphone → <strong>Allow</strong> → reload the page, then reopen SpeakPath.<br><br><span style="font-size:10px;opacity:0.6">Or go to chrome://settings/content/microphone</span>';
    $('micPermBtn').style.display='none';
  } else {
    banner.style.display='none';
  }
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['sp_settings'], r => {
      if (r.sp_settings) settings={...settings,...r.sp_settings};
      $('apiKeyInput').value         = settings.apiKey      || '';
      $('openaiKeyInput').value      = settings.openaiKey   || '';
      $('apiEndpoint').value         = settings.apiEndpoint;
      $('triggerWordInput').value    = settings.triggerWord  || 'test';
      $('stopPhraseInput').value     = settings.stopPhrase   || 'stop listening';
      $('confidenceThreshold').value = String(settings.confidenceThreshold);
      $('sttLang').value             = settings.sttLang      || 'en-US';
      resolve();
    });
  });
}
function saveSettings() {
  settings.apiKey              = $('apiKeyInput').value.trim();
  settings.openaiKey           = $('openaiKeyInput').value.trim();
  settings.apiEndpoint         = $('apiEndpoint').value.trim() || 'https://api.cometapi.com/v1/chat/completions';
  settings.triggerWord         = ($('triggerWordInput').value.trim() || 'test').toLowerCase();
  settings.stopPhrase          = ($('stopPhraseInput').value.trim() || 'stop listening').toLowerCase();
  settings.confidenceThreshold = parseFloat($('confidenceThreshold').value);
  settings.sttLang             = $('sttLang').value;
  chrome.storage.local.set({sp_settings:settings},()=>{
    updateTriggerDisplays();
    chrome.runtime.sendMessage({type:'SETTINGS_UPDATED',triggerWord:settings.triggerWord,stopPhrase:settings.stopPhrase,lang:settings.sttLang});
    showOut('✓ Settings saved','ok');
    setTimeout(()=>showView('main'),700);
    if(armed){stopRec();setTimeout(startRec,300);}
  });
}
function updateTriggerDisplays() {
  const t=tw(); const sp=settings.stopPhrase||'stop listening';
  $('triggerWordDisplay').textContent=t; $('triggerHint').textContent=t; $('triggerPreview').textContent=t;
  if($('stopPhraseDisplay'))$('stopPhraseDisplay').textContent=`"${sp}"`;
}

async function loadStats() {
  return new Promise(resolve=>{chrome.storage.local.get(['sp_stats'],r=>{if(r.sp_stats)stats={...stats,...r.sp_stats};resolve();});});
}
function saveStats(){chrome.storage.local.set({sp_stats:stats});}
function renderStats(){$('statActions').textContent=stats.actions;$('statLocal').textContent=stats.local;$('statAI').textContent=stats.ai;$('statSaved').textContent=stats.saved;}

// ─── HISTORY ──────────────────────────────────────────────────────────────────
function loadHistory(){try{const s=localStorage.getItem('sp_hist');if(s)commandHistory=JSON.parse(s).slice(0,20);}catch(e){}}
function saveHistory(){try{localStorage.setItem('sp_hist',JSON.stringify(commandHistory));}catch(e){}}
function addToHistory(cmd){if(!cmd||commandHistory[0]===cmd)return;commandHistory.unshift(cmd);commandHistory=commandHistory.slice(0,20);historyIdx=-1;saveHistory();renderHistoryChips();}
function renderHistoryChips(){
  const row=$('histRow');if(!row)return;row.innerHTML='';
  commandHistory.slice(0,5).forEach(cmd=>{
    const c=document.createElement('div');c.className='hist-chip';c.title=cmd;
    c.textContent=cmd.length>18?cmd.slice(0,16)+'…':cmd;
    c.onclick=()=>{setTranscript(cmd);addToHistory(cmd);showOut('<span class="spin">◌</span> Processing…','thinking');dispatchCommand(cmd);};
    row.appendChild(c);
  });
}

// ─── VIEWS ────────────────────────────────────────────────────────────────────
function setupViews(){
  $('settingsBtn').addEventListener('click',()=>showView('settings'));
  $('backBtn').addEventListener('click',()=>showView('main'));
  $('saveSettings').addEventListener('click',saveSettings);
  $('testConnection').addEventListener('click',runConnTest);
  $('forceAIBtn').addEventListener('click',toggleForceAI);
  $('noKeyBanner').addEventListener('click',()=>showView('settings'));
  $('triggerWordInput').addEventListener('input',()=>{$('triggerPreview').textContent=($('triggerWordInput').value.trim()||'test').toUpperCase();});
}
function showView(name){$('mainView').classList.toggle('active',name==='main');$('settingsView').classList.toggle('active',name==='settings');if(name==='main')checkApiKey();}
function toggleForceAI(){forceAI=!forceAI;$('forceAIBtn').classList.toggle('on',forceAI);showOut(forceAI?'🤖 Force AI ON':'⚡ Force AI OFF',forceAI?'thinking':'ok');}

// ─── TYPE INPUT ───────────────────────────────────────────────────────────────
function setupTypeInput(){
  const input=$('typeInput'),btn=$('goBtn');
  btn.addEventListener('click',()=>{
    const cmd=input.value.trim();if(!cmd)return;
    addToHistory(cmd);setTranscript(cmd);
    showOut('<span class="spin">◌</span> Processing…','thinking');
    dispatchCommand(cmd);input.value='';historyIdx=-1;
  });
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){btn.click();return;}
    if(e.key==='ArrowUp'){e.preventDefault();historyIdx=Math.min(historyIdx+1,commandHistory.length-1);input.value=commandHistory[historyIdx]||'';}
    if(e.key==='ArrowDown'){e.preventDefault();historyIdx=Math.max(historyIdx-1,-1);input.value=historyIdx>=0?commandHistory[historyIdx]:'';}
  });
}

// ─── CONNECTION TEST ──────────────────────────────────────────────────────────
async function runConnTest(){
  const btn=$('testConnection'),res=$('testResult');
  const key=$('apiKeyInput').value.trim();const ep=$('apiEndpoint').value.trim()||'https://api.cometapi.com/v1/chat/completions';
  if(!key){res.style.display='block';res.className='test-result err';res.textContent='⚠ Enter API key first.';return;}
  btn.disabled=true;btn.textContent='TESTING…';res.style.display='none';
  const r=await chrome.runtime.sendMessage({type:'TEST_CONNECTION',apiKey:key,apiEndpoint:ep});
  btn.disabled=false;btn.textContent='TEST CONNECTION';
  res.style.display='block';res.className=r.ok?'test-result ok':'test-result err';res.textContent=r.msg;
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
init();
