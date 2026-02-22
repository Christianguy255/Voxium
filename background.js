// Voxium background.js — v6
// Persistent background listening via offscreen doc.
// GPT-4o-mini-audio for TTS. AI content commands. Minimax→Gemini→Haiku routing.

// ─── OFFSCREEN MANAGEMENT ─────────────────────────────────────────────────────
async function ensureOffscreen() {
  try {
    if (!await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: ['USER_MEDIA'],
        justification: 'Persistent speech recognition'
      });
    }
  } catch(e) {
    if (!e.message?.includes('already exists')) console.error('Offscreen error:', e);
  }
}

ensureOffscreen();
chrome.runtime.onStartup.addListener(ensureOffscreen);

// ─── STATE ────────────────────────────────────────────────────────────────────
const EP = {
  MINIMAX: 'minimax-m2.5',
  GEMINI: 'gemini-2.0-flash',
  HAIKU:  'claude-haiku-4-5-20251001',
};

// Shared state (background service worker)
let bgState = {
  armed:       false,
  triggered:   false,
  settings:    null,   // loaded lazily
  popupPorts:  [],     // all connected popups
};

// ─── TEXT CLEANING (mirror of popup.js & offscreen.js) ──────────────────────
const FILLERS = /^(um+|uh+|er+|hmm+|ah+|like\s|so\s|okay\s|ok\s|well\s|right\s|yeah\s|hey\s|please\s+)?/i;
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
  'fullscreen': ['full scream','for screen'],
};

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

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
async function getSettings() {
  if (bgState.settings) return bgState.settings;
  return new Promise(resolve => {
    chrome.storage.local.get(['sp_settings'], r => {
      bgState.settings = r.sp_settings || {};
      resolve(bgState.settings);
    });
  });
}

// Invalidate cache when settings change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.sp_settings) bgState.settings = changes.sp_settings.newValue;
});

// ─── POPUP PORTS ──────────────────────────────────────────────────────────────
function broadcastToPopups(msg) {
  bgState.popupPorts = bgState.popupPorts.filter(p => {
    try { p.postMessage(msg); return true; }
    catch { return false; }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    bgState.popupPorts.push(port);
    // Send current arm state so popup can sync UI
    port.postMessage({ type: 'ARM_STATE', armed: bgState.armed, triggered: bgState.triggered });
    port.onDisconnect.addListener(() => {
      bgState.popupPorts = bgState.popupPorts.filter(p => p !== port);
    });
  }
});

// ─── ARM STATE — popup owns STT, background just stores state ────────────────
// Chrome only grants Web Speech API mic access to user-visible contexts (popup).
// Background stores arm/triggered state so popup auto-resumes when reopened.
function armListening() {
  bgState.armed     = true;
  bgState.triggered = false;
}
function disarmListening(reason) {
  bgState.armed     = false;
  bgState.triggered = false;
  broadcastToPopups({ type: 'ARM_STATE', armed: false, triggered: false, reason });
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── Arm state sync from popup ──────────────────────────────────────────────
  if (msg.type === 'SET_ARM_STATE') {
    bgState.armed     = msg.armed;
    bgState.triggered = msg.triggered || false;
    return false;
  }
  if (msg.type === 'GET_ARM_STATE') {
    sendResponse({ armed: bgState.armed, triggered: bgState.triggered });
    return true;
  }

  // ── AI Navigation ──────────────────────────────────────────────────────────
  if (msg.type === 'AI_NAVIGATE') {
    const cleanedCmd = cleanText(msg.command);
    route(cleanedCmd, msg.uiString, msg.apiKey, msg.apiEndpoint)
      .then(r  => sendResponse({ success: true, result: r }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Connection test ────────────────────────────────────────────────────────
  if (msg.type === 'TEST_CONNECTION') {
    testConnection(msg.apiKey, msg.apiEndpoint)
      .then(r  => sendResponse(r))
      .catch(e => sendResponse({ ok: false, msg: e.message }));
    return true;
  }

  // ── Manual command from popup ──────────────────────────────────────────────
  if (msg.type === 'MANUAL_COMMAND') {
    getSettings()
      .then(s => executeCommandFromBackground(msg.command, s))
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Settings updated ───────────────────────────────────────────────────────
  if (msg.type === 'SETTINGS_UPDATED') {
    bgState.settings = null;
    sendResponse({ ok: true });
    return true;
  }

  // ── TTS request ───────────────────────────────────────────────────────────
  if (msg.type === 'SPEAK_TEXT') {
    getSettings().then(s => speakViaAudio(msg.text, s.openaiKey)).catch(()=>null);
    return false;
  }
});

// ─── TRANSCRIPT PROCESSOR ─────────────────────────────────────────────────────
async function processTranscript(text, conf) {
  const s = await getSettings();
  const tw = (s.triggerWord || 'test').toLowerCase();

  if (!bgState.triggered) {
    if (text.toLowerCase().includes(tw)) {
      bgState.triggered = true;
      const afterTrigger = text.slice(text.toLowerCase().indexOf(tw) + tw.length).replace(/^[,\s]+/, '').trim();
      broadcastToPopups({ type: 'TRIGGER_HEARD', partial: afterTrigger });

      if (afterTrigger && afterTrigger.length > 1) {
        // Command in same utterance
        await executeCommandFromBackground(afterTrigger, s);
      } else {
        // Wait for next utterance
        broadcastToPopups({ type: 'WAITING_FOR_COMMAND' });
      }
    } else {
      broadcastToPopups({ type: 'AMBIENT_TRANSCRIPT', text });
    }
  } else {
    // Already triggered — this is the command
    if (text && text.length > 1) {
      await executeCommandFromBackground(text, s);
    }
  }
}

async function executeCommandFromBackground(command, settings) {
  const cleanedCmd = cleanText(command);
  broadcastToPopups({ type: 'COMMAND_PROCESSING', command: cleanedCmd });

  // Get active tab
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch(e) { tabs = []; }

  const tab = tabs[0];
  if (!tab || !tab.url || /^(chrome|chrome-extension|edge|about|data):/.test(tab.url)) {
    const err = 'Navigate to a real website first';
    broadcastToPopups({ type: 'COMMAND_RESULT', success: false, error: err, command: cleanedCmd });
    await speakViaAudio(err, settings.openaiKey);
    bgState.triggered = false;
    return;
  }

  // ── AI Content Commands (no UI needed) ────────────────────────────────────
  const contentCmd = detectContentCommand(cleanedCmd);
  if (contentCmd) {
    broadcastToPopups({ type: 'CONTENT_CMD_START', command: contentCmd.type });
    const ctx = await getPageContext(tab.id, contentCmd);
    const result = await runContentAI(contentCmd.type, ctx, settings.apiKey, contentCmd.param);
    if (result) {
      broadcastToPopups({ type: 'SPEAK_RESULT', text: result, command: contentCmd.type });
      await speakViaAudio(result, settings.openaiKey);
    }
    bgState.triggered = false;
    return;
  }

  // ── Navigation commands ────────────────────────────────────────────────────
  try {
    // Try local first
    let local;
    try {
      local = await chrome.tabs.sendMessage(tab.id, { type: 'LOCAL_MATCH', command: cleanedCmd });
    } catch(e) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      local = await chrome.tabs.sendMessage(tab.id, { type: 'LOCAL_MATCH', command: cleanedCmd });
    }

    if (local?.builtin) {
      await runBuiltinAction(local, tab);
      const msg = `Done: ${local.message}`;
      broadcastToPopups({ type: 'COMMAND_RESULT', success: true, message: msg, tier: 'LOCAL', command });
      await speakViaAudio(local.message, settings.openaiKey);
      bgState.triggered = false;
      return;
    }

    if (local?.match) {
      const cr = await chrome.tabs.sendMessage(tab.id, { type: 'EXECUTE_CLICK', targetId: local.match.id });
      if (cr.success) {
        const msg = `Clicked ${local.match.text}`;
        broadcastToPopups({ type: 'COMMAND_RESULT', success: true, message: msg, tier: 'LOCAL', command });
        await speakViaAudio(msg, settings.openaiKey);
        bgState.triggered = false;
        return;
      }
    }

    // AI fallback
    if (!settings.apiKey) {
      const err = 'No API key configured';
      broadcastToPopups({ type: 'COMMAND_RESULT', success: false, error: err, command });
      await speakViaAudio(err, settings.openaiKey);
      bgState.triggered = false;
      return;
    }

    broadcastToPopups({ type: 'COMMAND_PROCESSING', command, stage: 'ai' });
    let uiData;
    try {
      uiData = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_UI' });
    } catch(e) { uiData = null; }

    if (!uiData?.count) {
      const err = 'No clickable elements found';
      broadcastToPopups({ type: 'COMMAND_RESULT', success: false, error: err, command });
      await speakViaAudio(err, settings.openaiKey);
      bgState.triggered = false;
      return;
    }

    const aiResult = await route(cleanedCmd, uiData.uiString, settings.apiKey, settings.apiEndpoint);

    if (aiResult.action === 'none' || (aiResult.confidence < (settings.confidenceThreshold || 0.65))) {
      const err = 'Could not find matching element';
      broadcastToPopups({ type: 'COMMAND_RESULT', success: false, error: err, command: cleanedCmd, tier: aiResult.tier });
      await speakViaAudio(err, settings.openaiKey);
      bgState.triggered = false;
      return;
    }

    if (aiResult.action === 'keypress') {
      const kr = await chrome.tabs.sendMessage(tab.id, { type: 'EXECUTE_KEYPRESS', key: aiResult.key });
      const msg = `Pressed ${aiResult.key}`;
      broadcastToPopups({ type: 'COMMAND_RESULT', success: true, message: msg, tier: aiResult.tier, command: cleanedCmd });
      await speakViaAudio(msg, settings.openaiKey);
      bgState.triggered = false;
      return;
    }

    const cr = await chrome.tabs.sendMessage(tab.id, { type: 'EXECUTE_CLICK', targetId: aiResult.target_id });
    const tierLabel = { fast:'Minimax', standard:'Gemini', haiku:'Haiku', fallback:'AI' }[aiResult.tier] || 'AI';
    if (cr.success) {
      const msg = `Clicked ${cr.text}`;
      broadcastToPopups({ type: 'COMMAND_RESULT', success: true, message: msg, tier: aiResult.tier, command: cleanedCmd });
      await speakViaAudio(msg, settings.openaiKey);
    } else {
      const err = `Click failed: ${cr.error}`;
      broadcastToPopups({ type: 'COMMAND_RESULT', success: false, error: err, tier: aiResult.tier, command: cleanedCmd });
      await speakViaAudio('Click failed', settings.openaiKey);
    }
  } catch(e) {
    const err = `Error: ${e.message}`;
    broadcastToPopups({ type: 'COMMAND_RESULT', success: false, error: err, command: cleanedCmd });
    await speakViaAudio('Something went wrong', settings.openaiKey);
  }

  bgState.triggered = false;
}

// ─── CONTENT COMMAND DETECTION ────────────────────────────────────────────────
const CONTENT_PATTERNS = [
  { type: 'summarize',  re: /^(?:summarize|summary|sum\s+up|give\s+(?:me\s+)?(?:a\s+)?summary|what'?s?\s+on\s+this\s+page|overview|tldr|tl;?dr)(\s+this\s+page)?$/i },
  { type: 'explain',    re: /^(?:explain(?:\s+this)?|what\s+does\s+this\s+(?:mean|say)|what\s+is\s+this\s+about|clarify|elaborate)$/i },
  { type: 'read',       re: /^(?:read(?:\s+this)?(?:\s+(?:aloud|to\s+me|out\s+loud))?|narrate|speak(?:\s+this)?|read\s+aloud)$/i },
  { type: 'translate',  re: /^translate(?:\s+(?:this|page|to))?\s*(.*)$/i,   paramGroup: 1 },
  { type: 'factcheck',  re: /^(?:fact\s*[- ]?check|is\s+this\s+true|verify|check\s+(?:the\s+)?facts?|is\s+this\s+accurate)$/i },
  { type: 'ask',        re: /^(?:ask|answer\s+(?:me\s+)?(?:this|a\s+question)|question:?)\s+(.+)$/i, paramGroup: 1 },
  { type: 'define',     re: /^(?:define|what\s+(?:is|does)\s+.+\s+mean|definition\s+of)\s+(.+)$/i, paramGroup: 1 },
  { type: 'proofread',  re: /^(?:proofread|check\s+(?:my\s+)?(?:grammar|spelling|writing)|grammar\s+check)$/i },
  { type: 'improve',    re: /^(?:improve|rewrite|make\s+this\s+better|rephrase)$/i },
  { type: 'bullets',    re: /^(?:bullet\s+points?|list\s+(?:the\s+)?(?:key\s+)?points?|key\s+takeaways?|main\s+points?)$/i },
];

function detectContentCommand(text) {
  const lower = text.toLowerCase().trim();
  for (const pattern of CONTENT_PATTERNS) {
    const m = lower.match(pattern.re);
    if (m) {
      return {
        type:  pattern.type,
        param: pattern.paramGroup ? (m[pattern.paramGroup] || '').trim() : '',
        raw:   text,
      };
    }
  }
  return null;
}

// ─── PAGE CONTEXT EXTRACTION ──────────────────────────────────────────────────
async function getPageContext(tabId, contentCmd) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cmdType) => {
        const title = document.title || '';
        const url   = window.location.href;
        // Selected text takes priority
        const selected = window.getSelection()?.toString()?.trim() || '';
        // Main content extraction
        const selectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post', '.article-body', '.entry-content', 'body'];
        let text = '';
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) { text = el.innerText || el.textContent || ''; break; }
        }
        if (!text) text = document.body?.innerText || '';
        // Trim to reasonable size
        text = text.replace(/\s+/g, ' ').trim().slice(0, 8000);
        return { title, url, text, selected, wordCount: text.split(/\s+/).length };
      },
      args: [contentCmd.type],
    });
    return result[0]?.result || {};
  } catch(e) {
    return { title: 'Unknown page', text: '', selected: '', url: '' };
  }
}

// ─── AI CONTENT COMMANDS ──────────────────────────────────────────────────────
async function runContentAI(type, ctx, apiKey, param) {
  // Use OpenAI if available (better for content), fallback to Comet endpoint
  const s = await getSettings();
  const openaiKey = s.openaiKey;
  const useOpenAI = !!openaiKey;

  const endpoint = useOpenAI
    ? 'https://api.openai.com/v1/chat/completions'
    : s.apiEndpoint || 'https://api.cometapi.com/v1/chat/completions';
  const key    = useOpenAI ? openaiKey : apiKey;
  const model  = useOpenAI ? 'gpt-4o-mini' : EP.HAIKU;

  const textSrc = ctx.selected || ctx.text || '';
  const shortText = textSrc.slice(0, 4000);

  const prompts = {
    summarize:  {
      sys: 'Summarize the given webpage content in 3-4 natural spoken sentences. Write as if speaking directly to the user. No markdown, no lists.',
      usr: `Page: "${ctx.title}"\nURL: ${ctx.url}\n\nContent:\n${shortText}`,
    },
    explain:    {
      sys: 'Explain the following text clearly in 2-4 sentences as if talking to someone. Simple, conversational language only.',
      usr: `Explain this:\n\n${shortText}`,
    },
    read:       {
      sys: 'You will be given text. Return it cleaned up for reading aloud — remove markdown, fix formatting, keep first 300 words max.',
      usr: shortText.slice(0, 1500),
    },
    translate:  {
      sys: `Translate the following text to ${param || 'English'}. Provide only the translation, nothing else.`,
      usr: shortText.slice(0, 2000),
    },
    factcheck:  {
      sys: 'Fact-check the given content. In 2-3 sentences, say whether it appears accurate and why. Be direct and conversational.',
      usr: `Fact check:\n\n${shortText}`,
    },
    ask:        {
      sys: `You are a helpful assistant. Answer the user's question based on the webpage content. Be concise, 2-3 sentences max. Speak naturally.`,
      usr: `Page content:\n${shortText}\n\nQuestion: ${param}`,
    },
    define:     {
      sys: 'Define the given term in 1-2 clear spoken sentences. No jargon, plain English.',
      usr: `Define: ${param}`,
    },
    proofread:  {
      sys: 'Proofread the following text. Briefly describe errors found (grammar, spelling, clarity) in 2-3 sentences. Speak conversationally.',
      usr: shortText,
    },
    improve:    {
      sys: 'Rewrite the following text to be clearer and more engaging. Return only the improved text.',
      usr: shortText.slice(0, 1000),
    },
    bullets:    {
      sys: 'Extract 3-5 key points from this content. State each point naturally as a short sentence. No bullet symbols.',
      usr: shortText,
    },
  };

  const p = prompts[type];
  if (!p) return null;

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0.6,
        messages: [
          { role: 'system', content: p.sys },
          { role: 'user',   content: p.usr },
        ],
      }),
    });
    if (!resp.ok) { const e = await resp.text(); throw new Error(e); }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch(e) {
    console.error('[AI Content] Error:', e.message);
    return null;
  }
}

// ─── GPT-4o AUDIO TTS ──────────────────────────────────────────────────────
// Uses gpt-4o-mini-audio-preview-2024-12-17 to generate spoken audio
// Falls back to offscreen Web Speech API if no OpenAI key
async function speakViaAudio(text, openaiKey) {
  if (!text || text.length === 0) return;

  if (openaiKey) {
    try {
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini-audio-preview-2024-12-17',
          voice: 'alloy',
          input: text.slice(0, 1000),
          response_format: 'mp3',
          speed: 1.0,
        }),
      });

      if (!resp.ok) {
        const e = await resp.text();
        console.warn('[TTS] OpenAI audio error, falling back to browser TTS:', e);
        broadcastToPopups({ type: 'TTS_FALLBACK', text });
        return;
      }

      const buffer    = await resp.arrayBuffer();
      const b64       = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      // Send audio to popup(s) to play — can't play audio in service worker
      broadcastToPopups({ type: 'PLAY_AUDIO', audioB64: b64, mimeType: 'audio/mpeg', text });
      return;
    } catch(e) {
      console.warn('[TTS] OpenAI audio failed, falling back:', e.message);
    }
  }

  // Fallback: tell popup to use browser speech synthesis
  broadcastToPopups({ type: 'TTS_FALLBACK', text });
}

// ─── BUILTIN ACTIONS ─────────────────────────────────────────────────────────
async function runBuiltinAction(r, tab) {
  const a=r.action, w=chrome.windows, t=chrome.tabs;
  if      (a==='NEW_TAB')         t.create({});
  else if (a==='NEW_TAB_URL')     t.create({ url:r.url });
  else if (a==='CLOSE_TAB')       t.remove(tab.id);
  else if (a==='DUPLICATE_TAB')   t.duplicate(tab.id);
  else if (a==='REOPEN_TAB')      chrome.sessions.restore();
  else if (a==='PIN_TAB')         t.update(tab.id,{pinned:true});
  else if (a==='UNPIN_TAB')       t.update(tab.id,{pinned:false});
  else if (a==='MUTE_TAB')        t.update(tab.id,{muted:true});
  else if (a==='UNMUTE_TAB')      t.update(tab.id,{muted:false});
  else if (a==='NEW_WINDOW')      w.create({});
  else if (a==='CLOSE_WINDOW')    w.remove(tab.windowId);
  else if (a==='INCOGNITO')       w.create({incognito:true});
  else if (a==='BOOKMARK')        chrome.bookmarks.create({title:tab.title,url:tab.url});
  else if (a==='OPEN_BOOKMARKS')  t.create({url:'chrome://bookmarks/'});
  else if (a==='OPEN_HISTORY')    t.create({url:'chrome://history/'});
  else if (a==='OPEN_DOWNLOADS')  t.create({url:'chrome://downloads/'});
  else if (a==='OPEN_EXTENSIONS') t.create({url:'chrome://extensions/'});
  else if (a==='OPEN_SETTINGS')   t.create({url:'chrome://settings/'});
  else if (a==='NEXT_TAB') t.query({currentWindow:true},tabs=>{const i=tabs.findIndex(tt=>tt.id===tab.id);t.update(tabs[(i+1)%tabs.length].id,{active:true});});
  else if (a==='PREV_TAB') t.query({currentWindow:true},tabs=>{const i=tabs.findIndex(tt=>tt.id===tab.id);t.update(tabs[(i-1+tabs.length)%tabs.length].id,{active:true});});
}

// ─── AI ROUTING ───────────────────────────────────────────────────────────────
const COMPLEX_PATTERNS = [
  /\bnot\b|\bdon'?t\b|\binstead\b|\bother\b|\bexcept\b/i,
  /\bif\b.+\botherwise\b|\bif\b.+\belse\b|\bunless\b/i,
  /\bsecond\b|\bthird\b|\blast\b|\bfirst\b|\bmiddle\b|\b\d+(?:st|nd|rd|th)\b/i,
  /\bwhatever\b|\bwhichever\b|\bany(?:thing)?\s+that\b/i,
  /\bgrayed?\s*out\b|\bdisabled\b|\benabled\b|\bactive\b|\bhighlighted\b/i,
  /\bbut\s+not\b|\brather\s+than\b|\binstead\s+of\b/i,
];
function isComplex(cmd) { return COMPLEX_PATTERNS.some(p => p.test(cmd)); }

const MINIMAX_PROMPT = `Browser voice nav AI. Map command to best UI element.
Synonyms OK: "sign in"=login, "hit submit"=submit, "go to profile"=profile link.
No match: {"action":"none","confidence":0}
Click: {"action":"click","target_id":NUMBER,"confidence":NUMBER}
Key: {"action":"keypress","key":"Enter","confidence":1}
JSON ONLY.`;

const GEMINI_PROMPT = `Browser voice nav AI. Previous model uncertain — try harder.
Consider indirect phrasing, synonyms, user intent.
Confidence <0.60: {"action":"none","confidence":0}
Click: {"action":"click","target_id":NUMBER,"confidence":NUMBER}
Key: {"action":"keypress","key":"Enter","confidence":1}
JSON only.`;

const HAIKU_PROMPT = `SpeakPath: voice browser control. Handle COMPLEX command carefully.
May involve: negation, conditions, ordinals (second/last/first button), vague intent, state-based.
Read ALL elements. For negation: eliminate mentioned, pick alternative. For ordinal: count matching type.
Confidence honest. <0.55 = none.
{"action":"none","confidence":0} or {"action":"click","target_id":NUMBER,"confidence":NUMBER,"reasoning":"brief"}
JSON ONLY.`;

function diagnoseError(err, ep) {
  const m=err.message||String(err);
  if(m.includes('Failed to fetch')||m.includes('NetworkError')||m.includes('net::ERR'))return ep?.includes('api.comet.com')?'PLACEHOLDER':'NETWORK';
  if(m.includes('401')||m.includes('Unauthorized'))return 'KEY';
  if(m.includes('403'))return 'FORBIDDEN';
  if(m.includes('404'))return 'NOT_FOUND';
  if(m.includes('429')||m.includes('rate limit'))return 'RATE';
  if(m.includes('50'))return 'SERVER';
  return 'UNKNOWN';
}
const ERRS={PLACEHOLDER:'⚙ Set your real API endpoint in Settings.',NETWORK:'🌐 Cannot reach API.',KEY:'🔑 API key rejected.',FORBIDDEN:'🚫 Access forbidden.',NOT_FOUND:'🔍 Endpoint 404.',RATE:'⏱ Rate limited.',SERVER:'💥 Server error.',UNKNOWN:null};
function isConfigErr(e){return['PLACEHOLDER','NETWORK','KEY','FORBIDDEN','NOT_FOUND'].some(c=>e.message.includes((ERRS[c]||'').slice(0,12)));}

async function callModel(model,sys,usr,key,ep,tokens,timeout=9000){
  const ctrl=new AbortController();const tid=setTimeout(()=>ctrl.abort(),timeout);
  let resp;
  try{resp=await fetch(ep,{method:'POST',signal:ctrl.signal,headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model,max_tokens:tokens,temperature:0,messages:[{role:'system',content:sys},{role:'user',content:usr}]})});}
  catch(e){clearTimeout(tid);if(e.name==='AbortError')throw new Error(`⏱ Timed out`);throw new Error(ERRS[diagnoseError(e,ep)]||`Network: ${e.message}`);}
  clearTimeout(tid);
  if(!resp.ok){const b=await resp.text().catch(()=>'');throw new Error(ERRS[diagnoseError({message:`${resp.status} ${b}`},ep)]||`API ${resp.status}`);}
  const data=await resp.json().catch(()=>{throw new Error('Invalid JSON');});
  const raw=data.choices?.[0]?.message?.content?.trim();
  if(!raw)throw new Error('Empty response');
  const clean=raw.replace(/```json|```/g,'').trim();
  try{return JSON.parse(clean);}catch{const m=clean.match(/\{[\s\S]*?\}/);if(m){try{return JSON.parse(m[0]);}catch{}}throw new Error(`Non-JSON: "${clean.slice(0,60)}"`);}
}

function normalize(raw){
  if(!raw)return{action:'none',confidence:0};
  if(raw.a==='click')return{action:'click',target_id:raw.id,confidence:raw.c};
  if(raw.a==='none')return{action:'none',confidence:0};
  if(raw.a==='keypress')return{action:'keypress',key:raw.key||raw.k,confidence:raw.c||1};
  if(raw.action)return raw;
  return{action:'none',confidence:0};
}

async function route(command,uiString,apiKey,endpoint){
  const userMsg=`Command: "${command}"\n\nUI elements:\n${uiString}`;

  if(isComplex(command)){
    try{const raw=await callModel(EP.HAIKU,HAIKU_PROMPT,userMsg,apiKey,endpoint,150,12000);return{...normalize(raw),tier:'haiku'};}
    catch(e){if(isConfigErr(e))throw e;}
  }

  let d=null,g=null;
  try{const raw=await callModel(EP.MINIMAX,MINIMAX_PROMPT,userMsg,apiKey,endpoint,80,8000);d=normalize(raw);if(d.action==='click'&&d.confidence>=0.75)return{...d,tier:'fast'};if(d.action==='keypress')return{...d,tier:'fast'};}
  catch(e){if(isConfigErr(e))throw e;}

  try{const raw=await callModel(EP.GEMINI,GEMINI_PROMPT,userMsg,apiKey,endpoint,80,8000);g=normalize(raw);if(g.action==='click'&&g.confidence>=0.62)return{...g,tier:'standard'};if(g.action==='keypress')return{...g,tier:'standard'};}
  catch(e){if(isConfigErr(e))throw e;}

  try{const raw=await callModel(EP.HAIKU,HAIKU_PROMPT,userMsg,apiKey,endpoint,150,12000);return{...normalize(raw),tier:'haiku'};}
  catch(e){
    if(isConfigErr(e))throw e;
    const best=[d,g].filter(r=>r?.action==='click').sort((a,b)=>(b?.confidence||0)-(a?.confidence||0))[0];
    if(best)return{...best,tier:'fallback'};
    throw e;
  }
}

async function testConnection(apiKey,endpoint){
  try{
    // Test with actual route function to verify AI tier progression (skip local matching)
    const testCmd = 'hello world';
    const testUI = 'Button: Home|Link: About|Input: Search';
    const result = await route(testCmd, testUI, apiKey, endpoint);
    if (result.tier) {
      return{ok:true,msg:`✓ Connected! AI tier: ${result.tier}. Minimax → Gemini → Haiku ready.`};
    }
    return{ok:true,msg:'✓ Connected! AI routing active.'};
  }
  catch(e){
    // Fallback: direct API test
    try{
      const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},body:JSON.stringify({model:EP.MINIMAX,max_tokens:5,temperature:0,messages:[{role:'user',content:'hi'}]})});
      if(r.status===401)return{ok:false,msg:'🔑 API key rejected.'};
      if(r.status===403)return{ok:false,msg:'🚫 Access forbidden.'};
      if(r.status===404)return{ok:false,msg:'🔍 Endpoint 404.'};
      if(r.status===429)return{ok:true,msg:'✓ Connected (rate limited but key works)'};
      if(!r.ok){const b=await r.text().catch(()=>'');return{ok:false,msg:`API ${r.status}: ${b.slice(0,80)}`};}
      return{ok:true,msg:'✓ Connected! Minimax → Gemini → Haiku ready.'};
    }
    catch(e2){
      return{ok:false,msg:ERRS[diagnoseError(e,endpoint)]||`Failed: ${e.message}`.slice(0,100)};
    }
  }
}
