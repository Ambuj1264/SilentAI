const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage,
        desktopCapturer, screen, clipboard, systemPreferences, dialog,
        ipcMain, session } = require('electron')
const zlib  = require('zlib')
const path  = require('path')
const fs    = require('fs')
const https = require('https')

// ── Config (API keys live here, NOT in source) ─────────────────────────────────
let config = {}
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
} catch (e) {
  console.warn('[SilentAI] Could not read config.json — voice will be disabled:', e.message)
}
const ASSEMBLYAI_API_KEY = config.assemblyaiApiKey || ''

// Hide macOS dock icon so app only lives in the menu bar tray
if (process.platform === 'darwin') {
  app.dock.hide()
}

// Disable GPU shader cache to suppress cache errors
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// Block accessibility APIs — prevents AI tools (Copilot, Recall, etc.)
// from reading window content via UIA / MSAA even if they bypass screen capture
app.on('accessibility-support-changed', () => {
  app.setAccessibilitySupportEnabled(false)
})

// Only allow one instance — if a second starts, focus the first and quit
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// Force a standard desktop User-Agent so ChatGPT doesn't serve the mobile/voice UI
app.userAgentFallback = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

let chatWindow = null
let tray       = null
let pendingScreenshot = null
let recorderWindow = null
let keyListener = null

// Appended to both prompts below. The candidate speaks Hinglish naturally, so
// every answer ends with a short recap they can read straight out to the
// interviewer without translating on the fly.
const HINGLISH_RECAP = 'Finally, end with a section titled "Hinglish Summary": ' +
  '2-4 short lines in Hinglish (Hindi written in Roman script, technical terms ' +
  'kept in English) summarising what the code or problem does and the core logic ' +
  'behind it. Write it exactly as I would say it out loud to an interviewer. ' +
  'Do not translate technical terms into Hindi.'

// Auto-typed into the composer whenever a screenshot is pasted
const SCREENSHOT_PROMPT = 'Read and answer the interview question in this image. ' +
  'If it is a coding problem, give working, well-structured code plus a brief ' +
  'explanation of the approach and its time/space complexity. If it is conceptual ' +
  'or system design, give a clear, confident answer I can say out loud. State any ' +
  'assumptions if the question is ambiguous. Be concise. ' + HINGLISH_RECAP

// Auto-sent as the opening message of every new chat to set the assistant's behaviour
const SYSTEM_PROMPT = `You are an expert AI Engineering interview assistant helping a candidate answer technical interview questions in real time.

Base every answer primarily on the candidate's resume and align it with the provided job description whenever relevant. Treat the resume as the source of truth for the candidate's experience. Never invent projects, technologies, achievements, or responsibilities that are not supported by the resume. If information is missing, answer generically while clearly avoiding fabricated personal experience.

Assume the candidate has approximately 5 years of AI engineering experience unless the resume indicates otherwise. Tailor explanations to that experience level.

When an interview question, screenshot, coding problem, system design prompt, or follow-up question is provided:

- Identify the interviewer's intent.
- Generate a clear, confident, conversational answer suitable for speaking aloud.
- Keep answers concise by default (30-90 seconds), expanding only if requested.
- Explain technical concepts accurately with practical reasoning.
- When appropriate, reference relevant experience from the resume naturally.
- Align examples and emphasis with the job description without forcing keyword matching.
- If multiple valid approaches exist, recommend the most practical one and briefly justify it.
- If the question is ambiguous, state reasonable assumptions before answering.

Prioritize correctness, clarity, and authenticity over sounding impressive.

${HINGLISH_RECAP}`

// ── Tray icon ─────────────────────────────────────────────────────────────────
function makeTrayIcon() {
  const tbl = new Uint32Array(256)
  for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); tbl[i] = c }
  const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = tbl[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
  const chunk  = (type, data) => { const t=Buffer.from(type),l=Buffer.alloc(4),cr=Buffer.alloc(4); l.writeUInt32BE(data.length); cr.writeUInt32BE(crc32(Buffer.concat([t,data]))); return Buffer.concat([l,t,data,cr]) }
  const w=16,h=16,raw=Buffer.alloc(h*(1+w*4))
  for (let y=0;y<h;y++){raw[y*(1+w*4)]=0;for(let x=0;x<w;x++){const cx=x-7.5,cy=y-7.5,in_=cx*cx+cy*cy<=42,o=y*(1+w*4)+1+x*4;raw[o]=in_?108:0;raw[o+1]=in_?99:0;raw[o+2]=in_?255:0;raw[o+3]=in_?255:0}}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6
  return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])
}

// ── Drag bar injected into ChatGPT page ───────────────────────────────────────
const DRAG_BAR_CSS = `
  #__silentai_drag {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    height: 40px !important;
    background: rgba(10,10,10,0.85) !important;
    -webkit-app-region: drag !important;
    z-index: 2147483647 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    backdrop-filter: blur(8px) !important;
    border-bottom: 1px solid rgba(255,255,255,0.07) !important;
    cursor: move !important;
  }
  #__silentai_drag .handle {
    width: 48px;
    height: 5px;
    background: rgba(255,255,255,0.35);
    border-radius: 3px;
    pointer-events: none;
    -webkit-app-region: no-drag;
  }
  /* Bottom-right corner grip for resizing the window */
  #__silentai_resize {
    position: fixed !important;
    right: 0 !important;
    bottom: 0 !important;
    width: 20px !important;
    height: 20px !important;
    z-index: 2147483647 !important;
    cursor: nwse-resize !important;
    -webkit-app-region: no-drag !important;
    background: linear-gradient(135deg, transparent 45%, rgba(255,255,255,0.45) 45%, rgba(255,255,255,0.45) 55%, transparent 55%, transparent 70%, rgba(255,255,255,0.45) 70%, rgba(255,255,255,0.45) 80%, transparent 80%) !important;
  }
`

function injectDragBar() {
  chatWindow.webContents.insertCSS(DRAG_BAR_CSS)
  chatWindow.webContents.executeJavaScript(`
    (function() {
      if (document.getElementById('__silentai_drag')) return

      // Move handle (native drag via -webkit-app-region)
      const bar = document.createElement('div')
      bar.id = '__silentai_drag'
      bar.innerHTML = '<div class="handle"></div>'
      document.body.appendChild(bar)

      // Resize grip (bottom-right). Drives window size through the preload bridge.
      const grip = document.createElement('div')
      grip.id = '__silentai_resize'
      document.body.appendChild(grip)

      let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0
      grip.addEventListener('mousedown', async (e) => {
        if (!window.silentai) return
        e.preventDefault(); e.stopPropagation()
        const size = await window.silentai.winSize()
        sw = size[0]; sh = size[1]; sx = e.screenX; sy = e.screenY
        resizing = true
      })
      window.addEventListener('mousemove', (e) => {
        if (!resizing) return
        window.silentai.winSetSize(sw + (e.screenX - sx), sh + (e.screenY - sy))
      })
      window.addEventListener('mouseup', () => { resizing = false })
    })()
  `)
}

function injectLayoutFix() {
  chatWindow.webContents.insertCSS(`
    /* Push the whole app (sidebar + main) below the 40px drag bar
       so nothing is hidden underneath it. ChatGPT's natural layout —
       sidebar, chat history, new-chat and model picker — stays intact. */
    body > div:first-of-type {
      padding-top: 40px !important;
    }

    /* Thin scrollbar */
    ::-webkit-scrollbar { width: 4px !important; }
    ::-webkit-scrollbar-thumb { background: #444 !important; border-radius: 2px !important; }
  `)
}

// ── Window state persistence ───────────────────────────────────────────────────
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json')

// First-launch default: ~85% of the work area (capped), centered
function defaultBounds() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const w = Math.min(1400, Math.round(width  * 0.85))
  const h = Math.min(900,  Math.round(height * 0.85))
  return { width: w, height: h, x: Math.round((width - w) / 2), y: Math.round((height - h) / 2) }
}

// True only if the saved top-left still lands on a connected display's work area
// (guards against reopening off-screen after a monitor is unplugged)
function boundsAreVisible(b) {
  if (!b || ['x', 'y', 'width', 'height'].some(k => typeof b[k] !== 'number')) return false
  return screen.getAllDisplays().some(({ workArea: wa }) =>
    b.x >= wa.x && b.x < wa.x + wa.width &&
    b.y >= wa.y && b.y < wa.y + wa.height)
}

function loadBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'))
    if (boundsAreVisible(saved)) return saved
  } catch { /* no saved state yet, or unreadable — fall through to default */ }
  return defaultBounds()
}

// Debounced so a single drag/resize gesture doesn't hammer the disk
let saveBoundsTimer = null
function saveBounds() {
  clearTimeout(saveBoundsTimer)
  saveBoundsTimer = setTimeout(() => {
    if (!chatWindow) return
    try {
      fs.writeFileSync(windowStateFile(), JSON.stringify(chatWindow.getBounds()))
    } catch (e) {
      console.error('[SilentAI] Failed to save window state:', e.message)
    }
  }, 300)
}

// ── ChatGPT window ────────────────────────────────────────────────────────────
function createChatWindow() {
  const bounds = loadBounds()

  chatWindow = new BrowserWindow({
    width:       bounds.width,
    height:      bounds.height,
    x:           bounds.x,
    y:           bounds.y,
    frame:       false,
    resizable:   true,
    skipTaskbar: true,
    show:        false,
    focusable:   false,      // starts non-focusable; toggled on when shown
    minimizable: false,      // a stray Cmd+M must NOT minimize it
    minWidth:    360,
    minHeight:   320,
    hasShadow:   true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'stt', 'chat-preload.js')
    }
  })

  // ⚠️  CRITICAL: Set content protection IMMEDIATELY after window construction,
  // BEFORE loadURL or show(). This ensures the window is NEVER capturable by
  // screen recorders — even for a single frame. Do NOT move this lower.
  chatWindow.setContentProtection(true)

  // Show on whichever Space/desktop is currently active, instead of yanking the
  // user back to the Space where the window was first shown. Without this, a
  // window created on Space 1 forces macOS to switch to Space 1 on every show().
  if (process.platform === 'darwin') {
    chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  // Any popup/OAuth window ChatGPT opens also gets content protection
  chatWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'allow' }
  })
  chatWindow.webContents.on('did-create-window', (win) => {
    // Protect child/popup windows the instant they are created
    win.setContentProtection(true)
  })

  // Use default desktop user agent — mobile UA triggers auto voice mode
  chatWindow.loadURL('https://chatgpt.com')

  // Inject drag bar + layout fixes every time a page finishes loading
  chatWindow.webContents.on('did-finish-load', () => {
    injectDragBar()
    injectLayoutFix()
  })

  // Auto-send the system prompt whenever a new chat is opened (full load or the
  // SPA "New chat" in-page navigation).
  chatWindow.webContents.on('did-navigate', (_e, url) => maybePrimeNewChat(url))
  chatWindow.webContents.on('did-navigate-in-page', (_e, url) => maybePrimeNewChat(url))

  // Cmd+V anywhere in the ChatGPT window pastes straight into the composer.
  // Only fires while THIS window is focused, so it never affects other apps.
  chatWindow.webContents.on('before-input-event', (event, input) => {
    const isPaste = input.type === 'keyDown' && input.meta &&
                    !input.control && !input.alt &&
                    (input.key === 'v' || input.key === 'V')
    if (!isPaste) return
    event.preventDefault()   // stop the default paste so we can aim it at the box
    chatWindow.webContents.executeJavaScript(`
      (function focusComposer() {
        const el = document.querySelector('#prompt-textarea')
                || document.querySelector('div[contenteditable="true"]')
                || document.querySelector('textarea')
        if (el) { el.focus(); el.click(); }
      })()
    `).then(() => chatWindow.webContents.paste())
     .catch(() => {})
  })

  // Persist size/position whenever the user resizes or moves the window
  chatWindow.on('resize', saveBounds)
  chatWindow.on('move',   saveBounds)

  chatWindow.on('close', e => {
    e.preventDefault()
    hideChat()   // hide + hand keyboard focus back to the previous app
  })
}

// ── Voice push-to-talk (hold Command → speak → release → send) ──────────────────

// Hidden window that owns the microphone + AssemblyAI WebSocket. Never shown.
function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'stt', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false   // keep audio processing alive while hidden
    }
  })
  recorderWindow.setContentProtection(true)
  recorderWindow.loadFile(path.join(__dirname, 'stt', 'recorder.html'))
}

// Mint a short-lived AssemblyAI streaming token using the API key.
// Done here (Node) so the raw key never has to live in the renderer.
function getAssemblyToken() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'streaming.assemblyai.com',
      path: '/v3/token?expires_in_seconds=600',
      method: 'GET',
      headers: { Authorization: ASSEMBLYAI_API_KEY }
    }, res => {
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => {
        try {
          const json = JSON.parse(body)
          if (json.token) resolve(json.token)
          else reject(new Error('No token in response: ' + body))
        } catch (e) { reject(new Error('Bad token response: ' + body)) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Bring the chat window forward so the user can read ChatGPT's reply.
// Lighter than showChat() — no fresh-page navigation / screenshot logic.
function revealChat() {
  if (!chatWindow) return
  chatWindow.setContentProtection(true)
  if (process.platform === 'darwin') {
    chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  chatWindow.setFocusable(true)
  chatWindow.setAlwaysOnTop(true, 'floating')
  chatWindow.show()
  chatWindow.focus()
}

// Live composer writing.
//
// We write into ChatGPT's ProseMirror composer with a real input event
// (execCommand('insertText')) so the editor updates its own state and the Send
// button enables. To stay smooth as the sentence grows, we only write the
// DELTA: in the common case the new transcript just extends the old one, so we
// append the new suffix at the caret (cheap, constant-time). Only when
// AssemblyAI revises earlier words do we fall back to a full select-all replace.
//
// Writes are coalesced: while one update is in flight, newer live partials just
// overwrite `composerPending`, so we always converge to the latest transcript.
let composerRendered = ''   // what's currently in the box (what we last wrote)
let composerPending  = null // newest transcript waiting to be written, or null
let composerBusy     = false

function composerWriteScript(op) {
  return `
    (function (op) {
      const el = document.querySelector('#prompt-textarea')
              || document.querySelector('div[contenteditable="true"]')
              || document.querySelector('textarea')
      if (!el) return 'no-composer'
      el.focus()

      if (el.tagName === 'TEXTAREA') {
        el.value = op.type === 'append' ? el.value + op.s : op.s
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return 'ok'
      }

      const sel = window.getSelection()
      if (op.type === 'append') {
        // Collapse the caret to the end (no highlight, no full redraw) then type
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      } else {
        sel.selectAllChildren(el)   // full replace (rare: a revised partial)
      }
      document.execCommand('insertText', false, op.s)
      return 'ok'
    })(${JSON.stringify(op)})
  `
}

async function setComposerText(text) {
  composerPending = text
  if (composerBusy || !chatWindow) return
  composerBusy = true
  try {
    while (composerPending !== null) {
      const next = composerPending
      composerPending = null
      if (next === composerRendered) continue   // nothing changed

      // Append-only when the new text extends the old; otherwise full replace.
      const op = next.startsWith(composerRendered)
        ? { type: 'append',  s: next.slice(composerRendered.length) }
        : { type: 'replace', s: next }
      composerRendered = next
      await chatWindow.webContents.executeJavaScript(composerWriteScript(op))
    }
  } catch (e) {
    console.error('[SilentAI] composer update error:', e.message)
  } finally {
    composerBusy = false
  }
}

// Resolve once every pending composer write has flushed to the page.
function composerIdle() {
  return new Promise(resolve => {
    const check = () =>
      (!composerBusy && composerPending === null) ? resolve() : setTimeout(check, 25)
    check()
  })
}

// Recording started: surface the chat window and clear the composer so the
// live transcript types into an empty box. The sentinel forces an actual
// replace-to-empty even if our last render was already empty.
function beginLiveCompose() {
  revealChat()
  composerRendered = ' '   // force the next '' to count as a change
  setComposerText('')
}

// Recording finished: make sure the final transcript is in the box, then Send.
async function finalizeAndSend(text) {
  if (!chatWindow) return
  if (!text) { console.warn('[SilentAI] Empty transcript — nothing to send'); return }
  console.log('[SilentAI] 📝 Transcript:', text)

  setComposerText(text)
  await composerIdle()                         // guarantee the final text is in
  await new Promise(r => setTimeout(r, 250))   // let React enable the Send button

  const result = await chatWindow.webContents.executeJavaScript(`
    (function clickSend() {
      const btn = document.querySelector('#composer-submit-button')
               || document.querySelector('[data-testid="send-button"]')
      if (btn && !btn.disabled) { btn.click(); return 'clicked' }
      return btn ? 'disabled' : 'no-button'
    })()
  `)
  console.log('[SilentAI] Send button:', result)
  composerRendered = ''   // ChatGPT empties the composer on send
  // Window is already visible (revealed at recording start), so the reply shows.
}

// Global push-to-talk: hold Option (⌥) alone to record, release to stop and
// send. A bare modifier avoids every macOS/app shortcut conflict (notably Cmd+M
// = minimize), and a short hold + abort-on-other-key guard keeps ⌥ shortcuts
// (⌥+letter for special characters, ⌥+arrow, …) from accidentally recording.
function setupVoiceHotkey() {
  if (!ASSEMBLYAI_API_KEY) {
    console.warn('[SilentAI] No AssemblyAI key in config.json — voice push-to-talk disabled')
    return
  }

  let uIOhook, UiohookKey
  try {
    ({ uIOhook, UiohookKey } = require('uiohook-napi'))
  } catch (e) {
    console.error('[SilentAI] uiohook-napi failed to load — run `npm install`:', e.message)
    return
  }

  keyListener = uIOhook
  // Push-to-talk = hold Option (⌥) alone, either side. A bare modifier collides
  // with nothing (no minimize, no text shortcuts), so normal keys stay free.
  const isPTT = kc => kc === UiohookKey.Alt || kc === UiohookKey.AltRight
  const THRESHOLD_MS = 20           // hold ⌥ this long before recording starts (near-instant)

  let pttDown    = false
  let recording  = false
  let aborted    = false
  let startTimer = null

  const startRecording = () => {
    if (recording || aborted || !pttDown) return
    recording = true
    recorderWindow.webContents.send('stt:start')
    beginLiveCompose()              // show the window + clear the box for live text
    console.log('[SilentAI] 🎙️  recording… (⌥)')
  }
  const stopRecording = () => {
    if (!recording) return
    recording = false
    recorderWindow.webContents.send('stt:stop')
    console.log('[SilentAI] ⏹️  stop + send')
  }
  const abortRecording = () => {
    aborted = true
    clearTimeout(startTimer)
    if (recording) {
      recording = false
      recorderWindow.webContents.send('stt:abort')
      setComposerText('')           // wipe the half-typed live transcript
      hideChat()                    // nothing was sent — tuck the window away
      console.log('[SilentAI] ✋ aborted (⌥ + another key)')
    }
  }

  uIOhook.on('keydown', (e) => {
    if (isPTT(e.keycode)) {
      if (pttDown) return           // ignore repeats while held
      pttDown = true
      aborted = false
      clearTimeout(startTimer)
      startTimer = setTimeout(startRecording, THRESHOLD_MS)
    } else if (pttDown) {
      // Another key while ⌥ is held → it's a shortcut, not push-to-talk
      abortRecording()
    }
  })

  uIOhook.on('keyup', (e) => {
    if (!isPTT(e.keycode)) return
    pttDown = false
    clearTimeout(startTimer)
    stopRecording()
  })

  // Global key capture needs macOS Accessibility permission. If it isn't
  // granted, trigger the system prompt and bail — the grant only takes effect
  // after a restart, so there's no point starting the hook now.
  if (process.platform === 'darwin' &&
      !systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true)  // shows the macOS prompt
    console.warn('[SilentAI] ⚠️  Voice needs Accessibility permission.')
    console.warn('[SilentAI]    System Settings → Privacy & Security → Accessibility')
    console.warn('[SilentAI]    Enable the app, then QUIT and restart SilentAI.')
    return
  }

  try {
    uIOhook.start()
  } catch (e) {
    console.error('[SilentAI] uIOhook.start() failed:', e.message)
    return
  }

  console.log('[SilentAI] 🎤 Voice push-to-talk ready — hold Option (⌥) to talk')
}

// ── Auto-start helpers ────────────────────────────────────────────────────────
function isAutoStartEnabled() {
  return app.getLoginItemSettings().openAtLogin
}

function setAutoStart(enable) {
  app.setLoginItemSettings({
    openAtLogin: enable,
    openAsHidden: true   // start silently in tray, no window on boot
  })
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(makeTrayIcon()))
  tray.setToolTip('System Service')
  buildTrayMenu()
  tray.on('double-click', showChat)
}

function buildTrayMenu() {
  const autoStart = isAutoStartEnabled()
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show',  click: showChat },
    { label: 'Hide',  click: () => { chatWindow.setFocusable(false); chatWindow.hide() } },
    { type: 'separator' },
    {
      label: autoStart ? '✓ Start at login' : '  Start at login',
      click: () => {
        setAutoStart(!autoStart)
        buildTrayMenu()   // refresh menu to reflect new state
      }
    },
    { type: 'separator' },
    { label: 'Quit',  click: () => { chatWindow.removeAllListeners('close'); app.quit() } }
  ]))
}

// ── Hide helper ──────────────────────────────────────────────────────────────
function hideChat() {
  chatWindow.setFocusable(false)
  chatWindow.hide()
  // Deactivate the whole app so macOS hands keyboard focus back to whatever the
  // user was using — otherwise we stay frontmost (window hidden) and keystrokes
  // go nowhere. This makes every key work normally again right after hiding.
  if (process.platform === 'darwin') app.hide()
}

// ── Sending helpers (screenshot auto-send + new-chat system-prompt prime) ──────

// Replace the composer's contents with `text`. With guardEmpty, it leaves the
// composer alone if the user has already typed something (returns 'has-text').
function composerScript(text, guardEmpty) {
  return `
    (function (t, guard) {
      const el = document.querySelector('#prompt-textarea')
              || document.querySelector('div[contenteditable="true"]')
              || document.querySelector('textarea')
      if (!el) return 'no-composer'
      const cur = (el.tagName === 'TEXTAREA' ? el.value : el.innerText).trim()
      if (guard && cur) return 'has-text'
      el.focus()
      if (el.tagName === 'TEXTAREA') {
        el.value = t
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        window.getSelection().selectAllChildren(el)
        document.execCommand('insertText', false, t)
      }
      return 'ok'
    })(${JSON.stringify(text)}, ${guardEmpty ? 'true' : 'false'})
  `
}

// Click Send, retrying until it's enabled — image uploads can keep the button
// disabled for a moment after the text is in.
async function clickSendWhenReady(timeoutMs = 6000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await chatWindow.webContents.executeJavaScript(`
      (function () {
        const btn = document.querySelector('#composer-submit-button')
                 || document.querySelector('[data-testid="send-button"]')
        if (btn && !btn.disabled) { btn.click(); return 'clicked' }
        return btn ? 'disabled' : 'no-button'
      })()
    `)
    if (r === 'clicked') return true
    await new Promise(res => setTimeout(res, 250))
  }
  return false
}

// Drop the system prompt into a fresh chat and send it (skips if the user has
// already started typing).
async function sendSystemPrompt() {
  if (!chatWindow) return false
  const set = await chatWindow.webContents.executeJavaScript(composerScript(SYSTEM_PROMPT, true))
  if (set !== 'ok') return false
  await new Promise(r => setTimeout(r, 300))
  const sent = await clickSendWhenReady()
  console.log('[SilentAI] System-prompt prime:', sent ? 'sent ✓' : 'not sent')
  return sent
}

// Prime the system prompt once each time we land on a brand-new chat.
let onNewChat = false
function isNewChatUrl(url) {
  try {
    const u = new URL(url)
    return /(^|\.)chatgpt\.com$/.test(u.hostname) && (u.pathname === '/' || u.pathname === '')
  } catch { return false }
}
async function maybePrimeNewChat(url) {
  if (!isNewChatUrl(url)) { onNewChat = false; return }   // left the new-chat view
  if (onNewChat) return                                   // already handled this visit
  onNewChat = true
  await new Promise(r => setTimeout(r, 1200))             // let the composer render
  await sendSystemPrompt().catch(e => console.error('[SilentAI] prime error:', e.message))
}

// ── Show / paste ──────────────────────────────────────────────────────────────
async function showChat() {
  // Re-assert content protection before show() — defence in depth.
  // The primary protection is set at window creation, but we re-apply here
  // in case any Electron internals reset it during a hide/show cycle.
  chatWindow.setContentProtection(true)

  // Re-assert current-Space visibility so the window opens on the desktop the
  // user is on now, rather than switching back to the one it was created on.
  if (process.platform === 'darwin') {
    chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  // Make focusable BEFORE showing so the user can type in the input box
  chatWindow.setFocusable(true)
  chatWindow.setAlwaysOnTop(true, 'floating')
  chatWindow.show()
  chatWindow.focus()           // bring keyboard focus to this window

  if (!pendingScreenshot) return

  // ── Snapshot + clear pending immediately ─────────────────────────────────
  const screenshot = pendingScreenshot
  pendingScreenshot = null

  // Stay in the SAME conversation — no fresh-page reload. The screenshot is
  // pasted as an attachment into the current chat's composer.
  clipboard.writeImage(screenshot)

  // ── Focus the ChatGPT textarea (DOM-level focus, no OS focus needed) ──────
  await chatWindow.webContents.executeJavaScript(`
    (function focusInput() {
      const el = document.querySelector('#prompt-textarea')
              || document.querySelector('div[contenteditable="true"]')
              || document.querySelector('textarea')
      if (el) { el.focus(); el.click(); }
    })()
  `)

  // Small settle before paste
  await new Promise(r => setTimeout(r, 150))

  // ── Paste clipboard image into the focused textarea ───────────────────────
  chatWindow.webContents.paste()

  // After the image attaches, auto-type the prompt alongside it.
  await new Promise(r => setTimeout(r, 600))
  await chatWindow.webContents.executeJavaScript(`
    (function writePrompt() {
      const el = document.querySelector('#prompt-textarea')
              || document.querySelector('div[contenteditable="true"]')
              || document.querySelector('textarea')
      if (!el) return
      el.focus()
      if (el.tagName === 'TEXTAREA') {
        el.value = ${JSON.stringify(SCREENSHOT_PROMPT)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        document.execCommand('insertText', false, ${JSON.stringify(SCREENSHOT_PROMPT)})
      }
    })()
  `)

  // Auto-send — wait out the image upload until the Send button enables.
  const sent = await clickSendWhenReady()
  console.log('[SilentAI] Screenshot + prompt:', sent ? 'auto-sent ✓' : 'send button never enabled')
}

// ── Screen capture ────────────────────────────────────────────────────────────
async function captureMainScreen() {
  try {
    // Capture the display the cursor is currently on — i.e. the screen the user
    // is actually looking at — not always the primary one where ChatGPT opened.
    const active = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const sf = active.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(active.size.width * sf),
                       height: Math.round(active.size.height * sf) }
    })

    if (!sources?.length) {
      console.warn('[SilentAI] No screen sources found — Screen Recording permission may be denied')
      showPermissionDialog()
      return
    }

    // Pick the source matching the active display; fall back to the first one.
    const source = sources.find(s => s.display_id === String(active.id)) || sources[0]
    const thumb = source.thumbnail
    if (thumb.isEmpty()) {
      console.warn('[SilentAI] Screenshot is blank — Screen Recording permission denied in System Settings')
      showPermissionDialog()
      return
    }

    pendingScreenshot = thumb.resize({ width: 1280 })
    console.log('[SilentAI] Screen captured ✓ (display ' + active.id + ')')

  } catch (e) {
    // On macOS, a denied Screen Recording permission throws a non-standard
    // error object with no .message — "Failed to get sources" string error
    const msg = (e && (e.message || e.toString())) || 'Unknown error'
    console.error('[SilentAI] Capture failed:', msg)

    // "Failed to get sources" is the macOS permission-denied signal
    if (!e || !e.message || msg.toLowerCase().includes('failed to get sources') || msg === 'Unknown error') {
      showPermissionDialog()
    }
  }
}

// One-shot Cmd+Shift+S: capture the current screen, then show ChatGPT and let
// showChat() paste it + write the prompt + auto-send — all in a single press.
// (The ChatGPT window is content-protected, so it never appears in the capture
// even if it's already on screen.)
async function captureAndSend() {
  await captureMainScreen()
  if (pendingScreenshot) await showChat()
}

function showPermissionDialog() {
  // Show the exact binary path so the user knows which entry to enable
  const binaryName = path.basename(process.execPath)   // e.g. "Electron" or "electron"
  dialog.showMessageBox({
    type: 'warning',
    title: 'Screen Recording Permission Required',
    message: 'SilentAI cannot capture the screen.',
    detail: [
      '📍 How to fix this:',
      '',
      '1. Open: Apple Menu → System Settings',
      '2. Go to: Privacy & Security → Screen Recording',
      `3. Find and enable "${binaryName}" in the list`,
      '   (If it is already ON, toggle it OFF then back ON)',
      '4. Quit SilentAI from the tray menu, then run: npm start',
      '',
      `Binary: ${process.execPath}`
    ].join('\n'),
    buttons: ['OK']
  })
}

// ── Voice IPC: token minting + transcript handoff ──────────────────────────────
ipcMain.handle('stt:get-token', async () => {
  try { return { token: await getAssemblyToken() } }
  catch (e) { return { error: e.message } }
})
ipcMain.on('stt:partial', (_e, text) => setComposerText(text))   // live, as you speak
ipcMain.on('stt:transcript', (_e, text) =>
  finalizeAndSend(text).catch(err => console.error('[SilentAI] send error:', err)))
ipcMain.on('stt:status', (_e, m) => console.log('[SilentAI][recorder]', m))
ipcMain.on('stt:error',  (_e, m) => console.error('[SilentAI][recorder] ERROR:', m))

// ── Window IPC: lets the in-page resize grip drive the frameless window ─────────
ipcMain.handle('win:size', () => (chatWindow ? chatWindow.getSize() : [900, 540]))
ipcMain.on('win:set-size', (_e, w, h) => {
  if (chatWindow) chatWindow.setSize(Math.max(360, Math.round(w)), Math.max(320, Math.round(h)))
})

// ── App ───────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Allow the hidden recorder window (and ChatGPT) to use the microphone
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media' || permission === 'microphone'))

  createChatWindow()
  createRecorderWindow()
  createTray()
  setupVoiceHotkey()

  // On macOS: trigger permission checks early so macOS prompts the user the
  // first time (instead of silently failing on first use)
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen')
    console.log('[SilentAI] macOS Screen Recording permission status:', status)
    if (status !== 'granted') {
      console.warn('[SilentAI] ⚠️  Screen Recording not granted. Cmd+Shift+S will not work.')
      console.warn('[SilentAI]    Go to: System Settings → Privacy & Security → Screen Recording')
      console.warn('[SilentAI]    Enable the app (Terminal/Electron) then restart SilentAI.')
    }

    // Prompt for microphone access (needed for voice push-to-talk)
    systemPreferences.askForMediaAccess('microphone')
      .then(ok => console.log('[SilentAI] Microphone access granted:', ok))
      .catch(e => console.error('[SilentAI] Mic access error:', e.message))
  }

  // Wrap async shortcut handlers with .catch() to prevent
  // UnhandledPromiseRejectionWarning from crashing the process
  globalShortcut.register('CommandOrControl+Shift+S', () =>
    captureAndSend().catch(e => console.error('[SilentAI] captureAndSend error:', e))
  )
  globalShortcut.register('CommandOrControl+Shift+C', () =>
    showChat().catch(e => console.error('[SilentAI] showChat error:', e))
  )
  globalShortcut.register('CommandOrControl+Shift+X', () => hideChat())
})

// If user launches a second instance, focus the existing window instead
app.on('second-instance', () => {
  if (chatWindow) showChat()
})

app.on('window-all-closed', () => {})
app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  try { if (keyListener) keyListener.stop() } catch {}   // stop the global key hook
})

// Global safety net — log but don't crash on any stray unhandled rejection
process.on('unhandledRejection', (reason) => {
  console.error('[SilentAI] Unhandled rejection (safe):', reason)
})
