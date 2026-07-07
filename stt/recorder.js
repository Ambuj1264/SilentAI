// Hidden recorder renderer.
//
// On 'start' (push-to-talk pressed): open the mic, downsample to 16 kHz PCM16,
// and stream it to AssemblyAI's v3 streaming WebSocket.
// On 'stop' (released): terminate the stream, assemble the final transcript,
// and hand it back to the main process to paste into ChatGPT.
// On 'abort' (a Cmd+key shortcut was detected): discard everything silently.

const SAMPLE_RATE = 16000
const FINALIZE_MS = 1000   // after release, collect trailing words for this long, then send

let audioContext = null
let mediaStream  = null
let sourceNode   = null
let processor    = null
let socket       = null

// turn_order -> latest transcript for that turn (formatted overwrites partial)
let turns = {}

function floatTo16BitPCM(float32) {
  const out = new DataView(new ArrayBuffer(float32.length * 2))
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    out.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true) // little-endian
  }
  return out.buffer
}

async function start() {
  turns = {}
  try {
    const res = await window.stt.getToken()
    if (!res || !res.token) {
      window.stt.error('token error: ' + (res && res.error ? res.error : 'no token'))
      return
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })

    // Forcing the context sample rate makes Web Audio resample the mic for us.
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
    sourceNode = audioContext.createMediaStreamSource(mediaStream)
    processor = audioContext.createScriptProcessor(4096, 1, 1)

    // Use the context's ACTUAL rate. If the browser ignored our 16 kHz request
    // and ran at 48 kHz, sending audio mislabeled as 16 kHz garbles it — and the
    // model then hallucinates (e.g. "はい。"). Telling AssemblyAI the true rate
    // avoids that. We also pin the English model so it can't switch languages.
    const rate = audioContext.sampleRate

    const url = 'wss://streaming.assemblyai.com/v3/ws'
      + '?sample_rate=' + rate
      + '&encoding=pcm_s16le'
      + '&format_turns=true'
      + '&speech_model=universal-streaming-english'
      + '&token=' + encodeURIComponent(res.token)

    socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      sourceNode.connect(processor)
      processor.connect(audioContext.destination)
      window.stt.status('streaming')
    }

    socket.onmessage = (evt) => {
      let data
      try { data = JSON.parse(evt.data) } catch { return }
      if (data.type === 'Turn') {
        turns[data.turn_order] = data.transcript || ''
        window.stt.partial(currentTranscript())   // push live text to the composer
      } else if (data.type === 'Termination') {
        window.stt.status('terminated')
      }
    }

    socket.onerror = () => window.stt.error('websocket error')

    processor.onaudioprocess = (e) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      socket.send(floatTo16BitPCM(e.inputBuffer.getChannelData(0)))
    }
  } catch (err) {
    window.stt.error('start failed: ' + (err && err.message ? err.message : err))
    cleanup()
  }
}

function currentTranscript() {
  return Object.keys(turns)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => turns[k])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function stop() {
  // Stop feeding audio first so no new turns start.
  try { if (processor) processor.disconnect() } catch {}
  try { if (sourceNode) sourceNode.disconnect() } catch {}

  // Wait ~1s so AssemblyAI can deliver the final words for the audio we already
  // sent — this is what keeps the tail of your sentence from being cut off.
  // (Partials keep updating the composer live during this window.)
  await new Promise(r => setTimeout(r, FINALIZE_MS))

  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify({ type: 'Terminate' })) } catch {}
  }

  const text = currentTranscript()
  cleanup()
  window.stt.sendTranscript(text)
}

function abort() {
  cleanup()
  window.stt.status('aborted')
}

function cleanup() {
  try { if (processor) processor.disconnect() } catch {}
  try { if (sourceNode) sourceNode.disconnect() } catch {}
  try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()) } catch {}
  try { if (audioContext) audioContext.close() } catch {}
  try { if (socket && socket.readyState <= WebSocket.OPEN) socket.close() } catch {}
  processor = sourceNode = mediaStream = audioContext = socket = null
}

window.stt.onStart(start)
window.stt.onStop(stop)
window.stt.onAbort(abort)
