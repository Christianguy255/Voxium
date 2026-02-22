// Voxium offscreen.js — v6
// Persistent STT that survives popup close. Runs forever until stop phrase heard.
// Sends transcripts to background worker which processes commands.

let recognition = null;
let active = false;
let currentLang = 'en-US';
let triggerWord = 'test';
let stopPhrase  = 'stop listening';

// ─── STT CORRECTIONS ──────────────────────────────────────────────────────────
const FIXES = {
  'scroll':     ['scrawl','stroll','squall'],
  'click':      ['cclick','kclick','klick'],
  'submit':     ['some it','summit','sub-mit'],
  'search':     ['surge','church','lurch'],
  'youtube':    ['you tube','your tube',"you're tube",'utube'],
  'github':     ['get hub','git hub','get up'],
  'google':     ['goggle','googol'],
  'refresh':    ['re fresh','refreshed'],
  'download':   ['down load'],
  'settings':   ['setting','sittings'],
  'bookmark':   ['book mark'],
  'fullscreen': ['full scream','for screen'],
  'netflix':    ['net flicks','net fix'],
  'reddit':     ['read it','red it'],
};
const FILLERS = /^(um+|uh+|er+|hmm+|ah+|like\s|so\s|okay\s|ok\s|well\s|right\s|yeah\s|hey\s|please\s+)?/i;

function cleanText(raw) {
  let t = raw.trim();
  t = t.replace(FILLERS, '').trim();
  // Snapshot the original text in lowercase before applying corrections
  const original = t.toLowerCase();
  for (const [correct, wrongs] of Object.entries(FIXES)) {
    for (const wrong of wrongs) {
      // Check against snapshot, replace with word boundary to avoid substring corruption
      if (original.includes(wrong)) {
        t = t.replace(new RegExp(`\\b${wrong}\\b`, 'gi'), correct);
      }
    }
  }
  t = t.replace(/^(?:hey\s+)?(?:speak\s*path|speakpad|navigate\s+to|computer|ok\s+google)[,\s]+/i, '').trim();
  return t.replace(/\s+/g, ' ').trim();
}

// ─── RECOGNITION ENGINE ───────────────────────────────────────────────────────
function createRecognition() {
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
  if (!SR) {
    chrome.runtime.sendMessage({ type: 'SP_OFFSCREEN_ERROR', error: 'SpeechRecognition not supported' }).catch(()=>null);
    return null;
  }

  const rec = new SR();
  rec.lang = currentLang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 5;

  rec.onresult = (event) => {
    let bestFinal = '';
    let bestConf  = -1;
    let interim   = '';

    for (const result of event.results) {
      if (result.isFinal) {
        for (let i = 0; i < result.length; i++) {
          const alt  = result[i];
          const conf = Number(alt.confidence || 0);
          const txt  = String(alt.transcript || '').trim();
          // Prefer alts containing trigger word
          const hasTrigger = txt.toLowerCase().includes(triggerWord.toLowerCase());
          if (hasTrigger && conf > bestConf - 0.3) { bestFinal = txt; bestConf = conf; break; }
          if (conf > bestConf) { bestFinal = txt; bestConf = conf; }
        }
      } else {
        interim = result[0].transcript;
      }
    }

    // Send interim for live display
    if (interim && !bestFinal) {
      chrome.runtime.sendMessage({ type: 'SP_INTERIM', text: interim }).catch(()=>null);
    }

    if (!bestFinal) return;

    const cleaned = cleanText(bestFinal);

    // ── STOP PHRASE CHECK ─────────────────────────────────────────────────────
    const stopLower = (stopPhrase || 'stop listening').toLowerCase();
    if (cleaned.toLowerCase().includes(stopLower)) {
      chrome.runtime.sendMessage({ type: 'SP_STOP_PHRASE_HEARD' }).catch(()=>null);
      stop();
      return;
    }

    // Send final transcript for trigger/command processing
    chrome.runtime.sendMessage({ type: 'SP_FINAL_TRANSCRIPT', text: cleaned, conf: bestConf }).catch(()=>null);
  };

  rec.onerror = (event) => {
    if (!active) return;
    if (event.error === 'aborted' || event.error === 'no-speech') return;
    chrome.runtime.sendMessage({ type: 'SP_OFFSCREEN_ERROR', error: event.error }).catch(()=>null);
  };

  rec.onend = () => {
    if (!active) return;
    // Auto-restart — keeps listening forever
    setTimeout(() => {
      if (!active) return;
      try { rec.start(); }
      catch { setTimeout(() => { if (active) try { rec.start(); } catch {} }, 500); }
    }, 80);
  };

  return rec;
}

function start(config = {}) {
  currentLang = config.lang       || currentLang;
  triggerWord = config.triggerWord || triggerWord;
  stopPhrase  = config.stopPhrase  || stopPhrase;
  active = true;

  if (recognition) {
    try { recognition.abort(); } catch {}
  }

  recognition = createRecognition();
  if (!recognition) return;

  try { recognition.start(); }
  catch { setTimeout(() => { if (active) try { recognition.start(); } catch {} }, 300); }
}

function stop() {
  active = false;
  if (!recognition) return;
  try { recognition.abort(); } catch {}
  recognition = null;
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SP_OFFSCREEN_START') {
    start(msg.config || { lang: msg.lang });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SP_OFFSCREEN_STOP') {
    stop();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SP_OFFSCREEN_UPDATE_CONFIG') {
    triggerWord = msg.triggerWord || triggerWord;
    stopPhrase  = msg.stopPhrase  || stopPhrase;
    currentLang = msg.lang        || currentLang;
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

chrome.runtime.sendMessage({ type: 'SP_OFFSCREEN_READY' }).catch(()=>null);
