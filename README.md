# 🎙 Voxium — Voice Navigation Chrome Extension

Navigate any website with natural language commands, powered by Claude via the Comet API.

---

## 📁 File Structure

```
voxium/
├── manifest.json       # Chrome extension config (MV3)
├── popup.html          # Extension UI
├── popup.js            # UI logic, voice recognition, command routing
├── content.js          # DOM extraction, element tagging, click execution
├── background.js       # Claude API calls via Comet
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 Setup

### 1. Load the extension in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `voxium/` folder

### 2. Add your Comet API key

1. Click the Voxium icon in your toolbar
2. Click the ⚙ settings icon
3. Paste your **Comet API key** in the field
4. Verify the **API Endpoint** matches your Comet gateway URL
5. Click **SAVE SETTINGS**

> Default endpoint: `https://api.comet.com/v1/chat/completions`  
> Default model: `claude-sonnet-4-6`  
> Update these to match your Comet configuration if needed.

---

## 🎤 How to Use

1. Navigate to any website
2. Click the Voxium extension icon
3. Click the **microphone button** and speak a command
4. OR type a command in the text field and hit **GO**

### Example Commands

| You say | Voxium does |
|---|---|
| "Apply for the job" | Clicks "Apply Now" button |
| "Go to my profile" | Clicks the Profile link |
| "Submit the form" | Clicks the Submit button |
| "Save my progress" | Clicks "Save Draft" |

---

## ⚡ Architecture

```
Voice Input → Speech Recognition API
                    ↓
            Local Keyword Match  ──── HIT ──→ Click immediately (free, instant)
                    ↓ MISS
            Extract UI Map (compact)
            [1|Submit|button, 2|Apply Now|button, ...]
                    ↓
            Claude via Comet API (~200 tokens)
                    ↓
            { action: "click", target_id: 2, confidence: 0.94 }
                    ↓
            Inject click → DOM element [data-speak-id="2"]
```

**Cost optimization:**
- Local matching skips API calls ~60–80% of the time
- Only sends pipe-delimited UI metadata to Claude (~200-400 tokens max)
- MutationObserver re-scans on DOM changes (SPA-friendly)

---

## ⚙ Settings

| Setting | Default | Description |
|---|---|---|
| Comet API Key | — | Your Comet aggregation key |
| API Endpoint | `https://api.comet.com/v1/...` | Comet gateway URL |
| Model | `claude-sonnet-4-6` | Claude model via Comet |
| Confidence Threshold | 70% | Min confidence to execute a click |

---

## 🛠 Troubleshooting

**"No clickable elements found"** — Try refreshing the page, then retrying.

**API errors** — Double-check your Comet key and endpoint URL in settings.

**Mic unavailable** — Chrome requires HTTPS or localhost for microphone access. Extension popups are exempt, so this shouldn't occur normally.

**Content script not injecting** — Some pages (Chrome Web Store, `chrome://` pages) block extensions. This is expected.

---

## 🏆 Hackathon Demo Script

> *"Voxium listens to natural language, understands intent using Claude, and safely selects the correct UI element with structured JSON output. We use AI only when necessary — local keyword matching handles obvious commands for free, reducing API calls by 60–80%. When AI is needed, we send only distilled UI metadata — around 200 tokens — making it cost-efficient and scalable to any website."*
