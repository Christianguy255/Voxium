// Voxium Content Script — v5
// Built-in commands, keyboard press system, element interaction, page control

(function () {
  'use strict';

  let uiMap = [];
  let observer = null;
  let lastSafetyCommand = null;     // Track last dangerous command for confirmation
  let safetyConfirmTimeout = null;  // Clear confirmation after 3 seconds

  // ─── SAFETY SYSTEM ────────────────────────────────────────────────────────
  function requiresSafetyConfirmation(cmd) {
    // Commands that require double confirmation
    const dangerousPatterns = [
      /^hard\s+reload|force\s+reload$/, // Force reload might lose data
      /^(?:close\s+tab)$/,              // Closing tabs
      /^(?:close\s+window|quit)$/,      // Closing entire window
      /^clear\s+(?:field|input|box|this|text)$/, // Clearing form data
    ];
    return dangerousPatterns.some(p => p.test(cmd.toLowerCase()));
  }

  function confirmSafetyCommand(cmd) {
    // If user says same dangerous command twice within 3 seconds, allow it
    if (lastSafetyCommand === cmd) {
      lastSafetyCommand = null;
      clearTimeout(safetyConfirmTimeout);
      return true; // Confirmed!
    }
    
    // First time: mark it and wait for confirmation
    lastSafetyCommand = cmd;
    clearTimeout(safetyConfirmTimeout);
    safetyConfirmTimeout = setTimeout(() => {
      lastSafetyCommand = null;
    }, 3000); // 3-second window for confirmation
    
    return false; // Needs confirmation
  }

  // ─── SELECTORS ────────────────────────────────────────────────────────────
  const SELECTORS = [
    'button','a[href]','input[type="submit"]','input[type="button"]',
    '[role="button"]','[role="link"]','[role="menuitem"]','[role="tab"]',
    'select','label[for]','[role="checkbox"]','[role="radio"]',
    '[role="switch"]','[role="option"]','[role="treeitem"]',
    'input[type="checkbox"]','input[type="radio"]','details > summary',
    '[role="combobox"]','[role="listbox"]','[contenteditable="true"]',
  ];

  function getVisibleText(el) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
    if (aria?.trim()) return aria.trim();
    return (el.innerText || el.textContent || el.value || '').trim().replace(/\s+/g,' ');
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width===0 || r.height===0) return false;
    const s = window.getComputedStyle(el);
    return s.display!=='none' && s.visibility!=='hidden' && s.opacity!=='0';
  }

  function extractUIMap() {
    document.querySelectorAll('[data-speak-id]').forEach(el=>el.removeAttribute('data-speak-id'));
    const elements=[]; const seen=new Set(); let id=1;
    SELECTORS.forEach(sel=>{
      document.querySelectorAll(sel).forEach(el=>{
        if (seen.has(el)||!isVisible(el)) return;
        const text=getVisibleText(el);
        if (!text||text.length<1||text.length>120) return;
        seen.add(el);
        el.setAttribute('data-speak-id',id);
        const tag=el.tagName.toLowerCase();
        const type=el.getAttribute('type')||el.getAttribute('role')||tag;
        elements.push({id,text:text.slice(0,80),tag:(type==='a'||tag==='a')?'link':'button',el});
        id++;
      });
    });
    uiMap=elements;
    return elements.map(({id,text,tag})=>`${id}|${text}|${tag}`).join('\n');
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────
  function getInput(sel) { const el=document.querySelector(sel); return el&&isVisible(el)?el:null; }

  function typeInto(el,text,append=false) {
    el.focus();
    if (!append) el.value=text;
    else el.value+=text;
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }

  function getSearchInput() {
    return getInput('input[type="search"],input[name="q"],input[name="query"],input[name="search"],input[placeholder*="search" i],input[aria-label*="search" i]');
  }

  function getFocusedEditable() {
    const a = document.activeElement;
    if (!a) return null;
    if (a.tagName==='INPUT'||a.tagName==='TEXTAREA') return a;
    if (a.isContentEditable) return a;
    return null;
  }

  // ─── KEY PRESS ENGINE ─────────────────────────────────────────────────────
  // Comprehensive keyboard key map — everything you can say to press a key
  const KEY_ALIASES = {
    // Navigation
    'enter':['enter','return','submit','confirm','go'],
    'escape':['escape','esc','cancel','dismiss','close dialog','close popup'],
    'tab':['tab','next field','next input'],
    'backspace':['backspace','delete char','delete character','back space'],
    'delete':['delete','del','forward delete'],
    'space':['space','spacebar','space bar'],
    'arrowup':['up','arrow up','up arrow','up key','move up'],
    'arrowdown':['down','arrow down','down arrow','down key','move down'],
    'arrowleft':['left','arrow left','left arrow','left key','move left'],
    'arrowright':['right','arrow right','right arrow','right key','move right'],
    'home':['home','go to start','beginning of line'],
    'end':['end','go to end','end of line'],
    'pageup':['page up','pageup','scroll page up'],
    'pagedown':['page down','pagedown','scroll page down'],
    // Function keys
    'f1':['f1','f 1'],'f2':['f2','f 2'],'f3':['f3','f 3'],'f4':['f4','f 4'],
    'f5':['f5','f 5','refresh key'],'f6':['f6','f 6'],'f7':['f7','f 7'],
    'f8':['f8','f 8'],'f9':['f9','f 9'],'f10':['f10','f 10'],
    'f11':['f11','f 11','fullscreen key'],'f12':['f12','f 12','developer tools key'],
    // Special chars
    '.':['period','dot','full stop'],
    ',':['comma'],
    ';':['semicolon'],
    ':':['colon'],
    '!':['exclamation','exclamation mark','bang'],
    '?':['question mark'],
    '/':['slash','forward slash'],
    '\\':['backslash','back slash'],
    '-':['hyphen','dash','minus'],
    '_':['underscore'],
    '=':['equals','equal sign'],
    '+':['plus'],
    '@':['at','at sign'],
    '#':['hash','hashtag','pound'],
    '$':['dollar','dollar sign'],
    '%':['percent','percentage'],
    '&':['ampersand','and sign'],
    '*':['asterisk','star','multiply'],
    '(':['open paren','left paren','open parenthesis'],
    ')':['close paren','right paren','close parenthesis'],
    '[':['open bracket','left bracket'],
    ']':['close bracket','right bracket'],
    '{':['open brace','left brace','open curly'],
    '}':['close brace','right brace','close curly'],
    '<':['less than','left angle bracket'],
    '>':['greater than','right angle bracket'],
    '`':['backtick','back tick','grave'],
    '\'':['apostrophe','single quote'],
    '"':['quote','double quote'],
  };

  // Modifier key detection
  const MOD_ALIASES = {
    ctrl:['ctrl','control','ctrl+','command'],
    shift:['shift','shift+'],
    alt:['alt','option','alt+'],
    meta:['meta','windows key','win key','command key','cmd'],
  };

  function parseKeyCommand(cmd) {
    // "press enter" / "hit escape" / "press the tab key" / "click enter"
    const pressMatch = cmd.match(/^(?:press|hit|push|tap|click|type|use|send|fire|trigger)\s+(?:the\s+)?(.+?)(?:\s+key)?$/);
    const keyPart = pressMatch ? pressMatch[1].trim() : cmd.trim();

    // Check for modifier combos: "ctrl+c", "control c", "ctrl shift t"
    let mods = { ctrlKey:false, shiftKey:false, altKey:false, metaKey:false };
    let remainingKey = keyPart;

    for (const [mod, aliases] of Object.entries(MOD_ALIASES)) {
      for (const alias of aliases) {
        if (remainingKey.toLowerCase().startsWith(alias)) {
          if (mod==='ctrl')  mods.ctrlKey=true;
          if (mod==='shift') mods.shiftKey=true;
          if (mod==='alt')   mods.altKey=true;
          if (mod==='meta')  mods.metaKey=true;
          remainingKey = remainingKey.slice(alias.length).replace(/^[\s+]+/,'').trim();
          break;
        }
      }
    }

    // Find the actual key
    const lower = remainingKey.toLowerCase();
    for (const [key, aliases] of Object.entries(KEY_ALIASES)) {
      if (aliases.includes(lower) || lower===key) {
        return { key, ...mods };
      }
    }

    // Single character?
    if (remainingKey.length===1) return { key:remainingKey, ...mods };

    // Common shortcut patterns: "ctrl c", "ctrl v", "ctrl z", "ctrl a"
    const shortcutMatch = remainingKey.match(/^([a-z])$/i);
    if (shortcutMatch) return { key:shortcutMatch[1], ...mods };

    return null;
  }

  function fireKey(keySpec, targetEl) {
    const el = targetEl || document.activeElement || document.body;
    const opts = {
      key:        keySpec.key,
      code:       `Key${keySpec.key.toUpperCase()}`,
      bubbles:    true,
      cancelable: true,
      ctrlKey:    keySpec.ctrlKey  || false,
      shiftKey:   keySpec.shiftKey || false,
      altKey:     keySpec.altKey   || false,
      metaKey:    keySpec.metaKey  || false,
    };
    el.dispatchEvent(new KeyboardEvent('keydown',  opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup',    opts));

    // Also insert character for editable elements
    if (el.tagName==='INPUT'||el.tagName==='TEXTAREA') {
      if (keySpec.key==='Backspace') {
        const s=el.selectionStart, e2=el.selectionEnd;
        if (s!==e2) el.value=el.value.slice(0,s)+el.value.slice(e2);
        else if (s>0) el.value=el.value.slice(0,s-1)+el.value.slice(s);
        el.dispatchEvent(new Event('input',{bubbles:true}));
      } else if (keySpec.key==='Delete') {
        const s=el.selectionStart, e2=el.selectionEnd;
        if (s!==e2) el.value=el.value.slice(0,s)+el.value.slice(e2);
        else el.value=el.value.slice(0,s)+el.value.slice(s+1);
        el.dispatchEvent(new Event('input',{bubbles:true}));
      }
    }
  }

  // Keyboard shortcut expansions
  const SHORTCUT_MAP = {
    // Text editing
    'ctrl+a': { key:'a', ctrlKey:true },
    'ctrl+c': { key:'c', ctrlKey:true },
    'ctrl+v': { key:'v', ctrlKey:true },
    'ctrl+x': { key:'x', ctrlKey:true },
    'ctrl+z': { key:'z', ctrlKey:true },
    'ctrl+y': { key:'y', ctrlKey:true },
    'ctrl+s': { key:'s', ctrlKey:true },
    'ctrl+f': { key:'f', ctrlKey:true },
    'ctrl+p': { key:'p', ctrlKey:true },
    'ctrl+r': { key:'r', ctrlKey:true },
    'ctrl+w': { key:'w', ctrlKey:true },
    'ctrl+t': { key:'t', ctrlKey:true },
    'ctrl+n': { key:'n', ctrlKey:true },
    'ctrl+l': { key:'l', ctrlKey:true },
    'ctrl+d': { key:'d', ctrlKey:true },
    'ctrl+k': { key:'k', ctrlKey:true },
    'ctrl+b': { key:'b', ctrlKey:true },
    'ctrl+i': { key:'i', ctrlKey:true },
    'ctrl+u': { key:'u', ctrlKey:true },
    'ctrl+shift+t': { key:'t', ctrlKey:true, shiftKey:true },
    'ctrl+shift+n': { key:'n', ctrlKey:true, shiftKey:true },
    'ctrl+shift+i': { key:'i', ctrlKey:true, shiftKey:true },
    // Named shortcuts
    'copy':         { key:'c', ctrlKey:true },
    'paste':        { key:'v', ctrlKey:true },
    'cut':          { key:'x', ctrlKey:true },
    'undo':         { key:'z', ctrlKey:true },
    'redo':         { key:'y', ctrlKey:true },
    'select all':   { key:'a', ctrlKey:true },
    'save':         { key:'s', ctrlKey:true },
    'find':         { key:'f', ctrlKey:true },
    'print':        { key:'p', ctrlKey:true },
    'close tab':    { key:'w', ctrlKey:true },
    'new tab':      { key:'t', ctrlKey:true },
    'reopen tab':   { key:'t', ctrlKey:true, shiftKey:true },
    'new window':   { key:'n', ctrlKey:true },
    'incognito':    { key:'n', ctrlKey:true, shiftKey:true },
    'devtools':     { key:'i', ctrlKey:true, shiftKey:true },
    'bold':         { key:'b', ctrlKey:true },
    'italic':       { key:'i', ctrlKey:true },
    'underline':    { key:'u', ctrlKey:true },
    'zoom in':      { key:'+', ctrlKey:true },
    'zoom out':     { key:'-', ctrlKey:true },
    'reset zoom':   { key:'0', ctrlKey:true },
  };

  // ─── BUILT-IN COMMAND HANDLER ─────────────────────────────────────────────
  function handleBuiltinCommand(raw) {
    const cmd = raw.toLowerCase().trim();

    // ── KEYBOARD SHORTCUTS by name ────────────────────────────────────────────
    for (const [name, spec] of Object.entries(SHORTCUT_MAP)) {
      if (cmd === name || cmd === `press ${name}` || cmd === `hit ${name}` || cmd === `${name} shortcut`) {
        fireKey(spec);
        const modStr = [spec.ctrlKey&&'Ctrl',spec.shiftKey&&'Shift',spec.altKey&&'Alt',spec.metaKey&&'Meta'].filter(Boolean).join('+');
        const keyStr = modStr ? `${modStr}+${spec.key.toUpperCase()}` : spec.key.toUpperCase();
        return { handled:true, message:`Pressed ${keyStr}` };
      }
    }

    // ── PRESS KEY commands ────────────────────────────────────────────────────
    const isPressCmd = /^(?:press|hit|push|tap|type\s+key|send\s+key|fire\s+key)\s+/.test(cmd)
      || /\s+key$/.test(cmd);
    if (isPressCmd || /^(?:enter|escape|esc|backspace|delete|tab|space)\s*$/.test(cmd)) {
      const keySpec = parseKeyCommand(cmd);
      if (keySpec) {
        fireKey(keySpec);
        const modStr = [keySpec.ctrlKey&&'Ctrl',keySpec.shiftKey&&'Shift',keySpec.altKey&&'Alt'].filter(Boolean).join('+');
        const label  = modStr ? `${modStr}+${keySpec.key}` : keySpec.key;
        return { handled:true, message:`Pressed ${label}` };
      }
    }

    // ── NAVIGATION ────────────────────────────────────────────────────────────
    const gotoMatch = cmd.match(/^(?:go to|navigate to|open|visit|take me to|load)\s+(.+)$/);
    if (gotoMatch) {
      let t = gotoMatch[1].trim();
      if (/^[\w-]+\.\w{2,}/.test(t)||t.startsWith('http')) {
        if (!t.startsWith('http')) t='https://'+t;
        window.location.href=t;
        return {handled:true,message:`Navigating to ${t}`};
      }
      window.location.href=`https://www.google.com/search?q=${encodeURIComponent(t)}`;
      return {handled:true,message:`Searching for "${gotoMatch[1]}"`};
    }

    if (/^(?:go\s+)?back$|^previous page$/.test(cmd)) { history.back(); return {handled:true,message:'Going back'}; }
    if (/^(?:go\s+)?forward$|^next page$/.test(cmd)) { history.forward(); return {handled:true,message:'Going forward'}; }
    if (/^(?:reload|refresh)(?:\s+(?:the\s+)?page)?$/.test(cmd)) { location.reload(); return {handled:true,message:'Refreshing'}; }
    if (/^hard\s+reload|force\s+reload$/.test(cmd)) { 
      if (!confirmSafetyCommand(cmd)) {
        return {handled:true,message:'⚠ Say again to confirm hard reload (loses unsaved data)'};
      }
      location.reload(true); 
      return {handled:true,message:'Hard reload - clearing cache'}; 
    }
    if (/^(?:go\s+)?(?:home|homepage)$/.test(cmd)) { window.location.href=window.location.origin; return {handled:true,message:'Going home'}; }

    // copy URL / title
    if (/^copy\s+(?:url|link|page\s+url|address|current\s+url)$/.test(cmd)) {
      navigator.clipboard.writeText(window.location.href).catch(()=>{});
      return {handled:true,message:`Copied: ${window.location.href}`};
    }
    if (/^copy\s+(?:page\s+)?title$/.test(cmd)) {
      navigator.clipboard.writeText(document.title).catch(()=>{});
      return {handled:true,message:`Copied title: ${document.title}`};
    }

    // ── SEARCH ────────────────────────────────────────────────────────────────
    const searchMatch = cmd.match(/^(?:search(?:\s+for)?|google|look\s+up|find\s+on\s+web|bing|search\s+the\s+web\s+for)\s+(.+)$/);
    if (searchMatch) {
      const q=searchMatch[1].trim();
      const si=getSearchInput();
      if (si) {
        typeInto(si,q);
        const f=si.closest('form');
        f?f.submit():si.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
        return {handled:true,message:`Searched for "${q}"`};
      }
      window.location.href=`https://www.google.com/search?q=${encodeURIComponent(q)}`;
      return {handled:true,message:`Googling "${q}"`};
    }

    const ytMatch = cmd.match(/^(?:search\s+)?youtube(?:\s+for)?\s+(.+)$/)||cmd.match(/^(?:find|search\s+for)\s+(.+)\s+on\s+youtube$/);
    if (ytMatch) { window.location.href=`https://www.youtube.com/results?search_query=${encodeURIComponent(ytMatch[1])}`; return {handled:true,message:`YouTube: "${ytMatch[1]}"`}; }

    const amznMatch = cmd.match(/^(?:search\s+)?amazon(?:\s+for)?\s+(.+)$/)||cmd.match(/^(?:find|search\s+for)\s+(.+)\s+on\s+amazon$/);
    if (amznMatch) { window.location.href=`https://www.amazon.com/s?k=${encodeURIComponent(amznMatch[1])}`; return {handled:true,message:`Amazon: "${amznMatch[1]}"`}; }

    const rdMatch = cmd.match(/^(?:search\s+)?reddit(?:\s+for)?\s+(.+)$/)||cmd.match(/^(?:find|search\s+for)\s+(.+)\s+on\s+reddit$/);
    if (rdMatch) { window.location.href=`https://www.reddit.com/search/?q=${encodeURIComponent(rdMatch[1])}`; return {handled:true,message:`Reddit: "${rdMatch[1]}"`}; }

    const wkMatch = cmd.match(/^(?:search\s+)?wikipedia(?:\s+for)?\s+(.+)$/)||cmd.match(/^(?:find|look\s+up)\s+(.+)\s+on\s+wikipedia$/);
    if (wkMatch) { window.location.href=`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(wkMatch[1])}`; return {handled:true,message:`Wikipedia: "${wkMatch[1]}"`}; }

    const ghMatch = cmd.match(/^(?:search\s+)?github(?:\s+for)?\s+(.+)$/);
    if (ghMatch) { window.location.href=`https://github.com/search?q=${encodeURIComponent(ghMatch[1])}`; return {handled:true,message:`GitHub: "${ghMatch[1]}"`}; }

    const mapsMatch = cmd.match(/^(?:directions?\s+to|map\s+of|maps?\s+for|find\s+on\s+map|navigate\s+to)\s+(.+)$/);
    if (mapsMatch) { window.location.href=`https://maps.google.com/maps?q=${encodeURIComponent(mapsMatch[1])}`; return {handled:true,message:`Maps: "${mapsMatch[1]}"`}; }

    const imgMatch = cmd.match(/^(?:images?\s+of|search\s+images?\s+for|google\s+images?\s+for)\s+(.+)$/);
    if (imgMatch) { window.location.href=`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(imgMatch[1])}`; return {handled:true,message:`Image search: "${imgMatch[1]}"`}; }

    const shopMatch = cmd.match(/^(?:buy|shop\s+for|shopping\s+for|price\s+of|find\s+price\s+of)\s+(.+)$/);
    if (shopMatch) { window.location.href=`https://www.google.com/search?tbm=shop&q=${encodeURIComponent(shopMatch[1])}`; return {handled:true,message:`Shopping: "${shopMatch[1]}"`}; }

    const newsMatch = cmd.match(/^(?:news\s+about|news\s+on|latest\s+(?:news\s+(?:about|on)))\s+(.+)$/);
    if (newsMatch) { window.location.href=`https://news.google.com/search?q=${encodeURIComponent(newsMatch[1])}`; return {handled:true,message:`News: "${newsMatch[1]}"`}; }

    const defineMatch = cmd.match(/^(?:define|definition\s+of|what\s+(?:does|is))\s+(.+?)(?:\s+mean)?$/);
    if (defineMatch) { window.location.href=`https://www.google.com/search?q=define+${encodeURIComponent(defineMatch[1])}`; return {handled:true,message:`Defining: "${defineMatch[1]}"`}; }

    const calcMatch = cmd.match(/^(?:calculate|compute|whats?|what\s+is)\s+(.+)$/)||cmd.match(/^(\d[\d\s\+\-\*\/\^\(\)\.]+)(?:\s*=\s*\?)?$/);
    if (calcMatch) { window.location.href=`https://www.google.com/search?q=${encodeURIComponent(calcMatch[1])}`; return {handled:true,message:`Calculate: ${calcMatch[1]}`}; }

    const convMatch = cmd.match(/^convert\s+(.+)$/);
    if (convMatch) { window.location.href=`https://www.google.com/search?q=convert+${encodeURIComponent(convMatch[1])}`; return {handled:true,message:`Converting: ${convMatch[1]}`}; }

    const translateMatch = cmd.match(/^translate(?:\s+this\s+page)?(?:\s+to\s+(.+))?$/);
    if (translateMatch) {
      const lang=translateMatch[1]||'english';
      window.location.href=`https://translate.google.com/translate?sl=auto&tl=${encodeURIComponent(lang)}&u=${encodeURIComponent(window.location.href)}`;
      return {handled:true,message:`Translating to ${lang}`};
    }

    // ── SCROLLING ─────────────────────────────────────────────────────────────
    if (/^scroll\s+down$|^scroll\s+a\s+bit$|^down\s+a\s+bit$|^page\s+down$/.test(cmd)) { window.scrollBy({top:400,behavior:'smooth'}); return {handled:true,message:'Scrolled down'}; }
    if (/^scroll\s+up$|^up\s+a\s+bit$|^page\s+up$/.test(cmd)) { window.scrollBy({top:-400,behavior:'smooth'}); return {handled:true,message:'Scrolled up'}; }
    if (/^scroll\s+down\s+(?:a\s+lot|more|further|fast|half)$/.test(cmd)) { window.scrollBy({top:1200,behavior:'smooth'}); return {handled:true,message:'Scrolled down a lot'}; }
    if (/^scroll\s+up\s+(?:a\s+lot|more|further|fast|half)$/.test(cmd)) { window.scrollBy({top:-1200,behavior:'smooth'}); return {handled:true,message:'Scrolled up a lot'}; }
    if (/^(?:.*)?(?:bottom|end\s+of\s+(?:the\s+)?page)$/.test(cmd)||cmd==='go to bottom') { window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'}); return {handled:true,message:'Scrolled to bottom'}; }
    if (/^(?:.*)?(?:top|top\s+of\s+(?:the\s+)?page)$/.test(cmd)||cmd==='go to top') { window.scrollTo({top:0,behavior:'smooth'}); return {handled:true,message:'Scrolled to top'}; }

    const scrollPxMatch = cmd.match(/^scroll\s+(down|up)\s+(\d+)(?:\s+(?:px|pixels?))?$/);
    if (scrollPxMatch) {
      const dir=scrollPxMatch[1]==='down'?1:-1;
      window.scrollBy({top:dir*parseInt(scrollPxMatch[2]),behavior:'smooth'});
      return {handled:true,message:`Scrolled ${scrollPxMatch[1]} ${scrollPxMatch[2]}px`};
    }

    // ── SWIPE GESTURES (for Shorts, Reels, TikTok) ────────────────────────────
    // Voice commands to simulate swipes on shorts platforms
    if (/^swipe\s+(?:right|left|up|down)$/.test(cmd) || /^(?:go\s+)?(?:next|previous)(?:\s+video)?$/.test(cmd) || /^(?:next|skip)$/.test(cmd)) {
      const direction = cmd.match(/swipe\s+(right|left|up|down)/)?.[1] || 
                       (/(?:next|skip)/.test(cmd) ? 'left' : 'right');
      const swipeCmd = {
        'left': 'next video, skip this',
        'right': 'previous video, go back',
        'up': 'volume up, unmute, show comments',
        'down': 'volume down, mute, hide comments'
      }[direction];
      
      if (swipeCmd) {
        chrome.runtime.sendMessage({
          type: 'GESTURE_COMMAND',
          command: swipeCmd,
          gesture: direction,
          source: 'voice'
        }).catch(() => {});
        const msg = {left:'Next video',right:'Previous video',up:'Volume up',down:'Volume down'}[direction];
        return {handled:true,message:`${msg} (voice swipe)`};
      }
    }

    // ── ZOOM ──────────────────────────────────────────────────────────────────
    if (/^zoom\s+in$/.test(cmd)) { document.body.style.zoom=String((parseFloat(document.body.style.zoom||'1')+0.1).toFixed(1)); return {handled:true,message:'Zoomed in'}; }
    if (/^zoom\s+out$/.test(cmd)) { document.body.style.zoom=String(Math.max(0.5,parseFloat(document.body.style.zoom||'1')-0.1).toFixed(1)); return {handled:true,message:'Zoomed out'}; }
    if (/^(?:reset|normal)\s+zoom$/.test(cmd)) { document.body.style.zoom='1'; return {handled:true,message:'Reset zoom'}; }
    const zoomPct=cmd.match(/^zoom\s+(?:to\s+)?(\d+)\s*%?$/);
    if (zoomPct) { document.body.style.zoom=String(parseInt(zoomPct[1])/100); return {handled:true,message:`Zoom ${zoomPct[1]}%`}; }

    // ── TEXT / CLIPBOARD ──────────────────────────────────────────────────────
    if (/^select\s+all(?:\s+text)?$/.test(cmd)) { document.execCommand('selectAll'); return {handled:true,message:'Selected all'}; }

    // Type into focused field: "type hello world"
    const typeMatch = cmd.match(/^type\s+(.+)$/);
    if (typeMatch) {
      const el=getFocusedEditable();
      if (el) {
        if (el.isContentEditable) {
          el.textContent += typeMatch[1];
          el.dispatchEvent(new Event('input',{bubbles:true}));
        } else {
          typeInto(el,typeMatch[1],true);
        }
        return {handled:true,message:`Typed: "${typeMatch[1]}"`};
      }
    }

    // Replace/set field value: "set field to hello"
    const setFieldMatch = cmd.match(/^(?:set|change|put|write)\s+(?:field|input|box|value)\s+to\s+(.+)$/);
    if (setFieldMatch) {
      const el=getFocusedEditable();
      if (el) { typeInto(el,setFieldMatch[1]); return {handled:true,message:`Set value: "${setFieldMatch[1]}"`}; }
    }

    // Clear focused field
    if (/^(?:clear|erase|empty)\s+(?:field|input|box|this|text)$/.test(cmd)) {
      if (!confirmSafetyCommand(cmd)) {
        return {handled:true,message:'⚠ Say again to confirm clearing this field'};
      }
      const el=getFocusedEditable();
      if (el) {
        el.value=''; el.textContent='';
        el.dispatchEvent(new Event('input',{bubbles:true}));
        return {handled:true,message:'Cleared field'};
      }
      // Clear all form fields
      document.querySelectorAll('input[type="text"],input[type="email"],input[type="search"],textarea')
        .forEach(e=>{e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));});
      return {handled:true,message:'Cleared all form fields'};
    }

    // Select text in field
    if (/^select\s+(?:text\s+)?in\s+(?:field|input)$|^select\s+field\s+text$/.test(cmd)) {
      const el=getFocusedEditable();
      if (el) { el.select?.(); return {handled:true,message:'Selected field text'}; }
    }

    // Focus specific fields by label/placeholder
    const focusMatch = cmd.match(/^(?:focus|click)\s+(?:the\s+)?(.+?)\s+(?:field|input|box|textarea)$/);
    if (focusMatch) {
      const label = focusMatch[1].toLowerCase();
      const inputs = document.querySelectorAll('input,textarea,select,[contenteditable]');
      for (const inp of inputs) {
        if (!isVisible(inp)) continue;
        const ph  = (inp.placeholder||'').toLowerCase();
        const lbl = (inp.getAttribute('aria-label')||'').toLowerCase();
        const nm  = (inp.name||'').toLowerCase();
        const id  = (inp.id||'').toLowerCase();
        // Find associated label element
        const labelEl = document.querySelector(`label[for="${inp.id}"]`);
        const labelTxt = (labelEl?.textContent||'').toLowerCase();
        if (ph.includes(label)||lbl.includes(label)||nm.includes(label)||id.includes(label)||labelTxt.includes(label)) {
          inp.focus();
          return {handled:true,message:`Focused: ${focusMatch[1]} field`};
        }
      }
    }

    // ── DARK MODE / READER ────────────────────────────────────────────────────
    if (/^(?:toggle\s+)?dark\s+mode$/.test(cmd)) {
      document.documentElement.classList.toggle('dark');
      document.documentElement.setAttribute('data-theme',document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');
      return {handled:true,message:'Toggled dark mode'};
    }
    if (/^(?:toggle\s+)?(?:reading\s+mode|reader\s+view)$/.test(cmd)) {
      const existing=document.getElementById('sp-reader');
      if (existing) { existing.remove(); return {handled:true,message:'Reader mode off'}; }
      const s=document.createElement('style'); s.id='sp-reader';
      s.textContent='body>*:not(main):not(article):not([role="main"]){opacity:0.1!important}main,article,[role="main"]{max-width:720px!important;margin:40px auto!important;font-size:18px!important;line-height:1.8!important}';
      document.head.appendChild(s);
      return {handled:true,message:'Reader mode on'};
    }

    // ── HIGHLIGHT / FIND ──────────────────────────────────────────────────────
    const findMatch=cmd.match(/^(?:find|highlight|search\s+for)\s+(.+)\s+on\s+(?:this\s+)?(?:page|site)$/)||cmd.match(/^find\s+on\s+page\s+(.+)$/);
    if (findMatch) { window.find(findMatch[1]); return {handled:true,message:`Finding "${findMatch[1]}"`}; }

    // Highlight all occurrences of a word on the page
    const highlightMatch = cmd.match(/^highlight\s+(?:all\s+)?(?:instances\s+of\s+|occurrences?\s+of\s+)?(.+)$/);
    if (highlightMatch) {
      const word = highlightMatch[1].trim();
      document.querySelectorAll('.sp-highlight').forEach(el=>{el.outerHTML=el.textContent;});
      const walker = document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      const nodes=[]; let node;
      while((node=walker.nextNode())) if(node.textContent.toLowerCase().includes(word.toLowerCase())) nodes.push(node);
      nodes.forEach(n=>{
        const re=new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
        const span=document.createElement('span');
        span.innerHTML=n.textContent.replace(re,'<mark class="sp-highlight" style="background:#ffd700;color:#000">$1</mark>');
        n.parentNode.replaceChild(span,n);
      });
      return {handled:true,message:`Highlighted "${word}" (${nodes.length} found)`};
    }

    // Clear highlights
    if (/^clear\s+highlights?$/.test(cmd)) {
      document.querySelectorAll('.sp-highlight').forEach(el=>{el.outerHTML=el.textContent;});
      return {handled:true,message:'Cleared highlights'};
    }

    // ── MEDIA CONTROLS ────────────────────────────────────────────────────────
    const video=document.querySelector('video');
    const audio=document.querySelector('audio');
    const media=video||audio;

    if (media) {
      if (/^(?:play|resume|unpause|start)$/.test(cmd)) { media.play(); return {handled:true,message:'Playing'}; }
      if (/^(?:pause|stop)$/.test(cmd)) { media.pause(); return {handled:true,message:'Paused'}; }
      if (/^(?:mute|silence)$/.test(cmd)) { media.muted=true; return {handled:true,message:'Muted'}; }
      if (/^unmute$/.test(cmd)) { media.muted=false; return {handled:true,message:'Unmuted'}; }
      if (/^toggle\s+(?:mute|play|pause)$|^play\s*pause$/.test(cmd)) {
        if (cmd.includes('mute')) { media.muted=!media.muted; return {handled:true,message:media.muted?'Muted':'Unmuted'}; }
        media.paused?media.play():media.pause(); return {handled:true,message:media.paused?'Paused':'Playing'};
      }
      if (/^(?:fullscreen|full\s*screen)$/.test(cmd)) { media.requestFullscreen?.(); return {handled:true,message:'Fullscreen'}; }
      if (/^exit\s+fullscreen$/.test(cmd)) { document.exitFullscreen?.(); return {handled:true,message:'Exited fullscreen'}; }
      if (/^(?:loop|repeat)(?:\s+video)?$/.test(cmd)) { media.loop=!media.loop; return {handled:true,message:media.loop?'Loop on':'Loop off'}; }
      if (/^restart$|^go\s+to\s+beginning$|^start\s+over$/.test(cmd)) { media.currentTime=0; return {handled:true,message:'Restarted'}; }

      const skip=cmd.match(/^(?:skip|forward|fast\s+forward)\s+(\d+)(?:\s+seconds?)?$/);
      if (skip) { media.currentTime+=parseInt(skip[1]); return {handled:true,message:`+${skip[1]}s`}; }
      const rew=cmd.match(/^(?:rewind|back(?:ward)?)\s+(\d+)(?:\s+seconds?)?$/);
      if (rew) { media.currentTime-=parseInt(rew[1]); return {handled:true,message:`-${rew[1]}s`}; }

      if (/^volume\s+up$/.test(cmd)) { media.volume=Math.min(1,media.volume+0.1); return {handled:true,message:'Volume up'}; }
      if (/^volume\s+down$/.test(cmd)) { media.volume=Math.max(0,media.volume-0.1); return {handled:true,message:'Volume down'}; }
      const vol=cmd.match(/^(?:set\s+)?volume\s+(?:to\s+)?(\d+)(?:%)?$/);
      if (vol) { media.volume=Math.min(1,Math.max(0,parseInt(vol[1])/100)); return {handled:true,message:`Volume ${vol[1]}%`}; }

      const spd=cmd.match(/^(?:(?:set\s+)?(?:playback\s+)?speed\s+(?:to\s+)?|play\s+at\s+)(\d+(?:\.\d+)?)[x×]?$/);
      if (spd) { media.playbackRate=parseFloat(spd[1]); return {handled:true,message:`Speed ${spd[1]}x`}; }
      if (/^(?:normal|1x)\s+speed$|^reset\s+speed$/.test(cmd)) { media.playbackRate=1; return {handled:true,message:'Normal speed'}; }
      if (/^(?:speed\s+up|faster)$/.test(cmd)) { media.playbackRate=Math.min(4,media.playbackRate+0.25); return {handled:true,message:`Speed ${media.playbackRate}x`}; }
      if (/^(?:slow\s+down|slower)$/.test(cmd)) { media.playbackRate=Math.max(0.25,media.playbackRate-0.25); return {handled:true,message:`Speed ${media.playbackRate}x`}; }

      const seekTS=cmd.match(/^(?:go\s+to|seek\s+to|jump\s+to)\s+(\d+):(\d+)$/);
      if (seekTS) { media.currentTime=parseInt(seekTS[1])*60+parseInt(seekTS[2]); return {handled:true,message:`Seeked to ${seekTS[1]}:${seekTS[2]}`}; }
      const seekS=cmd.match(/^(?:go\s+to|seek\s+to|jump\s+to)\s+(\d+)\s*(?:seconds?|s)$/);
      if (seekS) { media.currentTime=parseInt(seekS[1]); return {handled:true,message:`Seeked to ${seekS[1]}s`}; }

      // Picture-in-picture
      if (/^(?:picture\s+in\s+picture|pip|mini\s+player)$/.test(cmd)) {
        video?.requestPictureInPicture?.();
        return {handled:true,message:'Picture in picture'};
      }
      if (/^exit\s+(?:pip|picture\s+in\s+picture)$/.test(cmd)) {
        document.exitPictureInPicture?.();
        return {handled:true,message:'Exited PiP'};
      }

      // Captions / subtitles
      if (/^(?:enable|turn\s+on|show)\s+(?:captions?|subtitles?)$/.test(cmd)) {
        for (const track of media.textTracks) { if (track.kind==='subtitles'||track.kind==='captions') { track.mode='showing'; break; } }
        return {handled:true,message:'Captions on'};
      }
      if (/^(?:disable|turn\s+off|hide)\s+(?:captions?|subtitles?)$/.test(cmd)) {
        for (const track of media.textTracks) track.mode='hidden';
        return {handled:true,message:'Captions off'};
      }
    }

    // ── QUICK SITE NAV ────────────────────────────────────────────────────────
    const siteMap={
      'google':'https://www.google.com','youtube':'https://www.youtube.com',
      'gmail':'https://mail.google.com','github':'https://www.github.com',
      'twitter':'https://www.twitter.com','x':'https://www.x.com',
      'reddit':'https://www.reddit.com','wikipedia':'https://www.wikipedia.org',
      'amazon':'https://www.amazon.com','netflix':'https://www.netflix.com',
      'linkedin':'https://www.linkedin.com','instagram':'https://www.instagram.com',
      'facebook':'https://www.facebook.com','twitch':'https://www.twitch.tv',
      'spotify':'https://open.spotify.com','stackoverflow':'https://stackoverflow.com',
      'stack overflow':'https://stackoverflow.com','maps':'https://maps.google.com',
      'google maps':'https://maps.google.com','news':'https://news.google.com',
      'drive':'https://drive.google.com','docs':'https://docs.google.com',
      'sheets':'https://sheets.google.com','slides':'https://slides.google.com',
      'calendar':'https://calendar.google.com','translate':'https://translate.google.com',
      'meet':'https://meet.google.com','chatgpt':'https://chat.openai.com',
      'claude':'https://claude.ai','perplexity':'https://www.perplexity.ai',
      'gemini':'https://gemini.google.com','discord':'https://discord.com',
      'slack':'https://slack.com','notion':'https://notion.so',
      'figma':'https://figma.com','trello':'https://trello.com',
      'jira':'https://jira.atlassian.com','vercel':'https://vercel.com',
      'supabase':'https://supabase.com','hacker news':'https://news.ycombinator.com',
      'hn':'https://news.ycombinator.com','product hunt':'https://www.producthunt.com',
      'medium':'https://medium.com','substack':'https://substack.com',
      'pinterest':'https://www.pinterest.com','tiktok':'https://www.tiktok.com',
      'ebay':'https://www.ebay.com','etsy':'https://www.etsy.com',
      'paypal':'https://www.paypal.com','canva':'https://www.canva.com',
      'loom':'https://www.loom.com','zoom':'https://zoom.us',
      'teams':'https://teams.microsoft.com','outlook':'https://outlook.live.com',
      'onedrive':'https://onedrive.live.com','dropbox':'https://www.dropbox.com',
      'airtable':'https://airtable.com','linear':'https://linear.app',
      'asana':'https://asana.com','hubspot':'https://www.hubspot.com',
      'shopify':'https://www.shopify.com','stripe':'https://stripe.com',
      'twilio':'https://www.twilio.com','heroku':'https://www.heroku.com',
      'firebase':'https://firebase.google.com','cloudflare':'https://www.cloudflare.com',
      'replit':'https://replit.com','codepen':'https://codepen.io',
    };

    const siteOpen=cmd.match(/^(?:open|go\s+to|take\s+me\s+to|navigate\s+to|visit|launch)\s+(.+)$/);
    if (siteOpen) {
      const sn=siteOpen[1].trim().toLowerCase();
      if (siteMap[sn]) { window.location.href=siteMap[sn]; return {handled:true,message:`Opening ${sn}`}; }
    }
    if (siteMap[cmd]) { window.location.href=siteMap[cmd]; return {handled:true,message:`Opening ${cmd}`}; }

    // ── WEATHER / TIME / DATE ─────────────────────────────────────────────────
    const weatherM=cmd.match(/^(?:what(?:'s|\s+is)\s+)?(?:the\s+)?weather(?:\s+(?:in|for|at)\s+(.+))?$/);
    if (weatherM) { const p=weatherM[1]||''; window.location.href=`https://www.google.com/search?q=weather+${encodeURIComponent(p)}`; return {handled:true,message:`Weather${p?' in '+p:''}`}; }
    if (/^(?:what(?:'s|\s+is)\s+)?(?:the\s+)?(?:current\s+)?time$/.test(cmd)) { window.location.href='https://www.google.com/search?q=current+time'; return {handled:true,message:'Checking time'}; }
    if (/^(?:what(?:'s|\s+is)\s+)?(?:the\s+)?date(?:\s+today)?$|^today$/.test(cmd)) { window.location.href='https://www.google.com/search?q=today%27s+date'; return {handled:true,message:'Checking date'}; }

    // ── PAGE INFO ─────────────────────────────────────────────────────────────
    if (/^(?:what(?:'s|\s+is)\s+(?:this\s+)?(?:page|site)|page\s+info)$/.test(cmd)) {
      return {handled:true,message:`"${document.title}" — ${window.location.href}`};
    }
    if (/^word\s+count|how\s+many\s+words$/.test(cmd)) {
      const w=(document.body.innerText||'').trim().split(/\s+/).length;
      return {handled:true,message:`~${w.toLocaleString()} words on this page`};
    }
    if (/^(?:page|view|show)\s+source$/.test(cmd)) { window.open('view-source:'+window.location.href); return {handled:true,message:'Page source'}; }

    // ── ELEMENT INSPECTION ────────────────────────────────────────────────────
    // "what is this" / "describe element" — describe whatever is under cursor/focused
    if (/^(?:what\s+is\s+this|describe\s+(?:this\s+)?(?:element|button|link)|inspect\s+(?:this|element))$/.test(cmd)) {
      const el = document.activeElement || document.elementFromPoint(window.innerWidth/2, window.innerHeight/2);
      if (el) {
        const tag=el.tagName.toLowerCase();
        const txt=getVisibleText(el).slice(0,60);
        const role=el.getAttribute('role')||'';
        return {handled:true,message:`${tag}${role?' ('+role+')':''}: "${txt}"`};
      }
    }

    // "count buttons" / "how many links"
    const countMatch=cmd.match(/^(?:count|how\s+many)\s+(buttons?|links?|inputs?|images?|forms?|tables?)(?:\s+on\s+(?:this\s+)?(?:page|site))?$/);
    if (countMatch) {
      const type=countMatch[1].replace(/s$/,'').toLowerCase();
      const selMap={button:'button,[role="button"]',link:'a[href]',input:'input,textarea,select',image:'img',form:'form',table:'table'};
      const sel=selMap[type]||type;
      const count=document.querySelectorAll(sel).length;
      return {handled:true,message:`${count} ${type}(s) on this page`};
    }

    // ── SCROLL TO ELEMENT ─────────────────────────────────────────────────────
    const scrollToMatch=cmd.match(/^(?:scroll\s+to|jump\s+to|go\s+to)\s+(.+)$/);
    if (scrollToMatch) {
      const query=scrollToMatch[1];
      // Try heading elements first
      const headings=['h1','h2','h3','h4','h5','h6'];
      for (const h of headings) {
        for (const el of document.querySelectorAll(h)) {
          if (el.textContent.toLowerCase().includes(query.toLowerCase())) {
            el.scrollIntoView({behavior:'smooth',block:'start'});
            return {handled:true,message:`Scrolled to "${el.textContent.trim().slice(0,40)}"`};
          }
        }
      }
    }

    // ── TABS ──────────────────────────────────────────────────────────────────
    if (/^(?:new\s+tab|open\s+(?:a\s+)?new\s+tab)$/.test(cmd)) return {handled:true,action:'NEW_TAB',message:'New tab'};
    if (/^(?:close\s+(?:this\s+)?tab|close\s+tab)$/.test(cmd)) return {handled:true,action:'CLOSE_TAB',message:'Closing tab'};
    if (/^(?:next\s+tab|switch\s+(?:to\s+)?next\s+tab)$/.test(cmd)) return {handled:true,action:'NEXT_TAB',message:'Next tab'};
    if (/^(?:prev(?:ious)?\s+tab|switch\s+(?:to\s+)?prev(?:ious)?\s+tab|last\s+tab)$/.test(cmd)) return {handled:true,action:'PREV_TAB',message:'Prev tab'};
    if (/^(?:duplicate\s+(?:this\s+)?tab)$/.test(cmd)) return {handled:true,action:'DUPLICATE_TAB',message:'Duplicating tab'};
    if (/^(?:reopen\s+(?:closed\s+)?tab|restore\s+tab|undo\s+close)$/.test(cmd)) return {handled:true,action:'REOPEN_TAB',message:'Reopening tab'};
    if (/^pin\s+tab$/.test(cmd)) return {handled:true,action:'PIN_TAB',message:'Pinned tab'};
    if (/^unpin\s+tab$/.test(cmd)) return {handled:true,action:'UNPIN_TAB',message:'Unpinned tab'};
    if (/^mute\s+tab$/.test(cmd)) return {handled:true,action:'MUTE_TAB',message:'Muted tab'};
    if (/^unmute\s+tab$/.test(cmd)) return {handled:true,action:'UNMUTE_TAB',message:'Unmuted tab'};

    const newTabSite=cmd.match(/^open\s+(.+)\s+in\s+(?:a\s+)?new\s+tab$/);
    if (newTabSite) {
      const sn=newTabSite[1].trim();
      const url=siteMap[sn]||(sn.includes('.')?'https://'+sn:null);
      if (url) return {handled:true,action:'NEW_TAB_URL',url,message:`${sn} in new tab`};
    }

    // ── WINDOW ────────────────────────────────────────────────────────────────
    if (/^(?:new\s+window|open\s+(?:a\s+)?new\s+window)$/.test(cmd)) return {handled:true,action:'NEW_WINDOW',message:'New window'};
    if (/^(?:close\s+window|quit)$/.test(cmd)) {
      if (!confirmSafetyCommand(cmd)) {
        return {handled:true,action:'SAFETY_CONFIRM',message:'⚠ Say again to confirm closing entire window'};
      }
      return {handled:true,action:'CLOSE_WINDOW',message:'Closing window...'};
    }
    if (/^(?:new\s+incognito|incognito|private\s+window)$/.test(cmd)) return {handled:true,action:'INCOGNITO',message:'Incognito'};

    // ── MEDIA CONTROLS (YouTube, TikTok, Spotify, Netflix, etc.) ──────────────
    // Play/Pause
    if (/^(?:play|start|resume|unpause)$/.test(cmd)) {
      const video = document.querySelector('video');
      if (video) {
        video.play?.();
        return {handled:true,message:'Playing'};
      }
      // Try button selectors
      for (const sel of ['[aria-label*="Play"]', 'button[title*="play" i]', '.ytp-play-button']) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return {handled:true,message:'Playing'}; }
      }
    }
    if (/^(?:pause|stop)$/.test(cmd)) {
      const video = document.querySelector('video');
      if (video) {
        video.pause?.();
        return {handled:true,message:'Paused'};
      }
      for (const sel of ['[aria-label*="Pause"]', 'button[title*="pause" i]', '.ytp-play-button'] ) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return {handled:true,message:'Paused'}; }
      }
    }

    // Skip / Next / Previous
    if (/^(?:next|skip|skip\s+(?:this\s+)?(?:video|song|track)|next\s+(?:video|song|track))$/.test(cmd)) {
      // Try media keys first
      fireKey({key:'MediaTrackNext'});
      // Try buttons
      for (const sel of ['[aria-label*="Next"]', 'button[title*="next" i]', '.ytp-next-button']) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return {handled:true,message:'Next'}; }
      }
      return {handled:true,message:'Next'};
    }
    if (/^(?:previous|back|previous\s+(?:video|song|track))$/.test(cmd)) {
      fireKey({key:'MediaTrackPrevious'});
      for (const sel of ['[aria-label*="Previous"]', 'button[title*="previous" i]', '.ytp-prev-button']) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return {handled:true,message:'Previous'}; }
      }
      return {handled:true,message:'Previous'};
    }

    // Volume
    if (/^(?:mute|silence|quiet)$/.test(cmd)) {
      const video = document.querySelector('video');
      if (video) { video.muted = true; return {handled:true,message:'Muted'}; }
      fireKey({key:'AudioVolumeMute'});
      return {handled:true,message:'Muted'};
    }
    if (/^(?:unmute|unsilence)$/.test(cmd)) {
      const video = document.querySelector('video');
      if (video) { video.muted = false; return {handled:true,message:'Unmuted'}; }
      return {handled:true,message:'Unmuted'};
    }
    if (/^(?:volume\s+)?up$|^louder$/.test(cmd)) {
      fireKey({key:'AudioVolumeUp'});
      return {handled:true,message:'Volume up'};
    }
    if (/^(?:volume\s+)?down$|^quieter$/.test(cmd)) {
      fireKey({key:'AudioVolumeDown'});
      return {handled:true,message:'Volume down'};
    }
    const volMatch = cmd.match(/^(?:set\s+)?(?:volume\s+)?(?:to\s+)?(\d+)\s*%?$/);
    if (volMatch) {
      const vol = Math.min(100, Math.max(0, parseInt(volMatch[1])));
      const video = document.querySelector('video');
      if (video) { video.volume = vol / 100; return {handled:true,message:`Volume ${vol}%`}; }
    }

    // Fullscreen
    if (/^fullscreen|full\s+screen|go\s+fullscreen|maximize/.test(cmd)) {
      const video = document.querySelector('video');
      if (video && video.requestFullscreen) {
        video.requestFullscreen?.();
        return {handled:true,message:'Fullscreen'};
      }
      const btn = document.querySelector('[aria-label*="Full"]');
      if (btn) { btn.click(); return {handled:true,message:'Fullscreen'}; }
    }
    if (/^exit\s+fullscreen|leave\s+fullscreen|normal\s+size/.test(cmd)) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
        return {handled:true,message:'Exited fullscreen'};
      }
    }

    // Subtitles / Captions
    if (/^(?:turn\s+on\s+)?(?:subtitles|captions|closed\s+captions|subs)$|^cc\s+on$/.test(cmd)) {
      const btn = document.querySelector('[aria-label*="Captions"]');
      if (btn) { btn.click(); return {handled:true,message:'Captions on'}; }
      return {handled:true,message:'Captions on'};
    }
    if (/^(?:turn\s+off\s+)?(?:subtitles|captions|closed\s+captions|subs)$|^cc\s+off$/.test(cmd)) {
      const btn = document.querySelector('[aria-label*="Captions"]');
      if (btn) { btn.click(); return {handled:true,message:'Captions off'}; }
      return {handled:true,message:'Captions off'};
    }

    // Speed controls
    const speedMatch = cmd.match(/^(?:speed\s+)?(?:(?:to\s+)?(\d+(?:\.\d+)?)x?|(\d+)\/(\d+))$|^(?:normal|regular)\s+speed$/);
    if (speedMatch) {
      let speed = 1;
      if (speedMatch[1]) speed = parseFloat(speedMatch[1]);
      else if (speedMatch[2]) speed = parseInt(speedMatch[2]) / parseInt(speedMatch[3]);
      
      const video = document.querySelector('video');
      if (video) { video.playbackRate = Math.max(0.25, Math.min(3, speed)); return {handled:true,message:`Speed ${speed}x`}; }
    }
    if (/^faster$/.test(cmd)) {
      const video = document.querySelector('video');
      if (video) { video.playbackRate = Math.min(3, video.playbackRate + 0.25); return {handled:true,message:`Speed ${video.playbackRate}x`}; }
    }
    if (/^slower$/.test(cmd)) {
      const video = document.querySelector('video');
      if (video) { video.playbackRate = Math.max(0.25, video.playbackRate - 0.25); return {handled:true,message:`Speed ${video.playbackRate}x`}; }
    }

    // Like / Favorite / Thumbs up
    if (/^(?:like|thumbs\s+up|favorite|heart|love)$/.test(cmd)) {
      for (const sel of ['[aria-label*="Like"]', '[aria-label*="Favorite"]', 'button[title*="like" i]']) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return {handled:true,message:'Liked'}; }
      }
      return {handled:true,message:'Liked'};
    }
    if (/^(?:dislike|thumbs\s+down|unlike)$/.test(cmd)) {
      for (const sel of ['[aria-label*="Dislike"]', 'button[title*="dislike" i]']) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return {handled:true,message:'Disliked'}; }
      }
      return {handled:true,message:'Disliked'};
    }

    // Share / Comment
    if (/^(?:share|share\s+(?:this|video))$/.test(cmd)) {
      for (const sel of ['[aria-label*="Share"]', 'button[title*="share" i]']) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return {handled:true,message:'Share menu'}; }
      }
      return {handled:true,message:'Share'};
    }
    if (/^(?:comment|open\s+comments?|show\s+comments?)$/.test(cmd)) {
      for (const sel of ['[aria-label*="Comment"]', 'button[title*="comment" i]']) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return {handled:true,message:'Comments'}; }
      }
      window.scrollBy({top: window.innerHeight, behavior: 'smooth'});
      return {handled:true,message:'Comments section'};
    }

    // Repeat / Loop
    if (/^(?:repeat|loop|repeat\s+(?:this\s+)?(?:video|song|track))$/.test(cmd)) {
      for (const sel of ['[aria-label*="Repeat"]', 'button[title*="repeat" i]']) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return {handled:true,message:'Repeat on'}; }
      }
      const video = document.querySelector('video');
      if (video) { video.loop = !video.loop; return {handled:true,message:video.loop ? 'Repeat on' : 'Repeat off'}; }
    }
    if (/^no\s+repeat|shuffle/.test(cmd)) {
      const video = document.querySelector('video');
      if (video) { video.loop = false; return {handled:true,message:'Repeat off'}; }
    }

    // Theatre / Picture-in-Picture
    if (/^(?:theatre|theater)\s+mode|wide\s+mode/.test(cmd)) {
      const btn = document.querySelector('[aria-label*="Theatre"]');
      if (btn) { btn.click(); return {handled:true,message:'Theatre mode'}; }
    }
    if (/^picture\s+in\s+picture|pip|float\s+window/.test(cmd)) {
      const video = document.querySelector('video');
      if (video?.requestPictureInPicture) {
        video.requestPictureInPicture();
        return {handled:true,message:'Picture in picture'};
      }
    }

    // ── AI-POWERED COMMANDS (sent to background for GPT processing) ──────────
    // Summarize page
    if (/^summarize(?:\s+(?:this\s+)?page)?$|^give me a summary$|^whats?\s+on\s+this\s+page/.test(cmd)) {
      const pageText = document.body.innerText.slice(0, 3000);
      const pageTitle = document.title;
      chrome.runtime.sendMessage({
        type: 'AI_COMMAND',
        command: 'summarize',
        context: {
          pageTitle,
          pageText,
          url: window.location.href
        }
      }).catch(() => {});
      return {handled:true,message:'📝 Summarizing page... (speaking result soon)'};
    }

    // Explain (selected text or page element)
    if (/^explain|^what\s+(?:does\s+)?(?:this|that)\s+(?:mean|say)/.test(cmd)) {
      const selected = window.getSelection().toString().trim();
      const text = selected || document.body.innerText.slice(0, 1000);
      chrome.runtime.sendMessage({
        type: 'AI_COMMAND',
        command: 'explain',
        context: {
          text,
          url: window.location.href
        }
      }).catch(() => {});
      return {handled:true,message:'🧠 Explaining... (speaking result soon)'};
    }

    // Translate (selected text or ask for translation)
    const aiTranslateMatch = cmd.match(/^translate\s+(?:this\s+)?(?:to\s+)?(\w+)$|^translate(?:\s+(?:to|into)\s+(\w+))?$/);
    if (aiTranslateMatch) {
      const lang = aiTranslateMatch[1] || aiTranslateMatch[2] || 'english';
      const selected = window.getSelection().toString().trim();
      const text = selected || document.body.innerText.slice(0, 1000);
      chrome.runtime.sendMessage({
        type: 'AI_COMMAND',
        command: 'translate',
        context: {
          text,
          targetLang: lang,
          url: window.location.href
        }
      }).catch(() => {});
      return {handled:true,message:`🌐 Translating to ${lang}... (speaking result soon)`};
    }

    // Read aloud / Text-to-speech
    if (/^read\s+(?:this|aloud|to me)|^speak|^narrate/.test(cmd)) {
      const selected = window.getSelection().toString().trim();
      const text = selected || document.body.innerText.slice(0, 2000);
      chrome.runtime.sendMessage({
        type: 'SPEAK_TEXT',
        text: text.slice(0, 500)
      }).catch(() => {});
      return {handled:true,message:'🔊 Reading page aloud...'};
    }

    // Fact-check / Verify information
    if (/^fact\s*check|^is\s+this\s+true|^verify|^check\s+(?:facts?|this)/.test(cmd)) {
      const selected = window.getSelection().toString().trim();
      const text = selected || document.body.innerText.slice(0, 1000);
      chrome.runtime.sendMessage({
        type: 'AI_COMMAND',
        command: 'factcheck',
        context: {
          text,
          url: window.location.href
        }
      }).catch(() => {});
      return {handled:true,message:'✓ Fact-checking... (speaking result soon)'};
    }

    return {handled:false};
  }


  // ─── LOCAL KEYWORD MATCH ──────────────────────────────────────────────────
  function localMatch(command) {
    const cmd=command.toLowerCase();
    for (const item of uiMap) {
      const t=item.text.toLowerCase();
      if (t===cmd) return item;
      if (cmd.includes(t)&&t.length>3) return item;
      const words=cmd.split(/\s+/).filter(w=>w.length>3);
      if (words.length>0&&words.every(w=>t.includes(w))) return item;
    }
    return null;
  }

  // ─── CLICK / KEY EXECUTION ────────────────────────────────────────────────
  function executeClick(targetId) {
    const el=document.querySelector(`[data-speak-id="${targetId}"]`);
    if (!el) return {success:false,error:'Element not found'};
    el.scrollIntoView({behavior:'smooth',block:'center'});
    const prev=el.style.cssText;
    el.style.outline='3px solid #00ff9d';
    el.style.outlineOffset='3px';
    el.style.transition='outline 0.3s ease';
    setTimeout(()=>{el.style.cssText=prev;},1500);
    el.click();
    return {success:true,text:uiMap.find(i=>i.id===parseInt(targetId))?.text};
  }

  function executeKeypress(key) {
    // Find the key spec from our map
    const spec = KEY_ALIASES[key.toLowerCase()]
      ? { key }
      : { key }; // passthrough
    fireKey(spec);
    return { success:true, key };
  }

  // fireKey available in this scope (defined in handleBuiltinCommand's outer scope)
  function fireKey(keySpec, targetEl) {
    const el = targetEl || document.activeElement || document.body;
    const opts = {
      key:keySpec.key, bubbles:true, cancelable:true,
      ctrlKey:keySpec.ctrlKey||false, shiftKey:keySpec.shiftKey||false,
      altKey:keySpec.altKey||false, metaKey:keySpec.metaKey||false,
    };
    el.dispatchEvent(new KeyboardEvent('keydown',  opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup',    opts));
  }

  // ─── GESTURE RECOGNITION (YouTube Shorts, TikTok, Reels, etc.) ─────────────
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;

  function handleSwipeGesture(direction) {
    const cmd = {
      'left': 'next video, skip this',
      'right': 'previous video, go back',
      'up': 'volume up, unmute, show comments',
      'down': 'volume down, mute, hide comments'
    }[direction];
    
    if (cmd) {
      // Send back to popup to handle as a command
      chrome.runtime.sendMessage({
        type: 'GESTURE_COMMAND',
        command: cmd,
        gesture: direction
      }).catch(() => {});
    }
  }

  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartTime = Date.now();
  }, false);

  document.addEventListener('touchend', (e) => {
    if (!e.changedTouches[0]) return;
    const t = e.changedTouches[0];
    const endX = t.clientX;
    const endY = t.clientY;
    const duration = Date.now() - touchStartTime;
    const minSwipeDistance = 50;
    const maxDuration = 500;

    if (duration > maxDuration) return; // too slow

    const deltaX = endX - touchStartX;
    const deltaY = endY - touchStartY;

    // Determine swipe direction
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > minSwipeDistance) {
      // Horizontal swipe
      handleSwipeGesture(deltaX > 0 ? 'right' : 'left');
    } else if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > minSwipeDistance) {
      // Vertical swipe
      handleSwipeGesture(deltaY > 0 ? 'down' : 'up');
    }
  }, false);

  // ─── MUTATION OBSERVER ────────────────────────────────────────────────────
  function startObserver() {
    if (observer) observer.disconnect();
    let debounce;
    observer=new MutationObserver(()=>{clearTimeout(debounce);debounce=setTimeout(extractUIMap,600);});
    observer.observe(document.body,{childList:true,subtree:true});
  }

  // ─── MESSAGE HANDLER ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message,_,sendResponse)=>{
    if (message.type==='EXTRACT_UI') {
      sendResponse({uiString:extractUIMap(),count:uiMap.length});
      startObserver();
      return true;
    }
    if (message.type==='LOCAL_MATCH') {
      extractUIMap();
      const builtin=handleBuiltinCommand(message.command);
      if (builtin.handled) {
        sendResponse({builtin:true,action:builtin.action||null,url:builtin.url||null,message:builtin.message});
        return true;
      }
      const match=localMatch(message.command);
      sendResponse({match:match?{id:match.id,text:match.text}:null});
      return true;
    }
    if (message.type==='EXECUTE_CLICK') {
      sendResponse(executeClick(message.targetId));
      return true;
    }
    if (message.type==='EXECUTE_KEYPRESS') {
      const result = executeKeypress(message.key);
      sendResponse(result);
      return true;
    }
  });

  extractUIMap();
  startObserver();
})();
