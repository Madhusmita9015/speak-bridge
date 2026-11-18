# Speak-Bridge

A two-way communication app: recognize ASL hand shapes from a webcam and
turn them into text, and turn spoken voice into text — both sides feeding
a shared conversation transcript that can be read aloud with ElevenLabs
TTS. **Either side can also just type**, so a limitation in camera or
microphone recognition never actually blocks the conversation — see
"Reliability: the typed fallback" below.

---

## Recognition architecture (hybrid, as actually implemented)

```
Camera (browser)
  → MediaPipe Hands (landmarks, runs locally in-browser)
  → gestureClassifier.js (rule-based static-pose classifier, local, instant, free)
        │
        ├─ recognized → normalized { gloss, confidence } → transcript
        │
        └─ NOT recognized, held ≥ 700ms
              → POST /api/stream/frame-sse (only if /api/config says NeuralSeek is configured)
              → NeuralSeek maistro agent → normalized { gloss, confidence } → transcript
```

Local recognition runs first because it's zero network latency, free, and
works offline — it covers a fixed, small vocabulary (below). When it can't
name a held pose, and the backend confirms NeuralSeek is actually
configured (checked once via `GET /api/config`, not guessed or assumed),
the frontend uploads that one frame to NeuralSeek as a fallback. Both
paths funnel into the same `emitRecognition(gloss, confidence, source)`
function in `Camera.jsx`, so the transcript treats a NeuralSeek result
identically to a local one — it's tagged with a small ☁️ so you can tell
which path produced it, nothing more.

If `NEURALSEEK_API_KEY` / `NEURALSEEK_STREAM_URL` / an agent ID aren't
set, `/api/config` reports `neuralseek_enabled: false` and the frontend
never attempts the cloud path — no wasted requests, no confusing errors.

### Supported sign vocabulary (local classifier)

`A, B, D, F, I, L, U, V, W, Y, HELLO, I LOVE YOU, THREE, GOOD (👍), BAD (👎)`

`F` is detected via an actual thumb-to-index-tip pinch distance check (not
just the finger-extended/curled booleans the other signs use — a pinched
index finger doesn't reliably read as "curled"). `GOOD`/`BAD` are
distinguished by comparing the thumb tip's position to the wrist, so a
thumbs-down now reads differently from a thumbs-up instead of the same
"thumb extended" bucket catching both.

This is **not full ASL** — it recognizes held static hand shapes, not
motion signs (`J`, `Z`), two-hand signs, or facial grammar. The NeuralSeek
fallback can extend real coverage beyond this list *if* you configure a
NeuralSeek agent that actually understands ASL frames — this app sends it
a raw PNG frame and expects back JSON shaped like
`{"gloss": "...", "confidence": 0.0-1.0}` (or plain text, which is used as
the gloss directly); what the agent itself recognizes is entirely up to
how you build/train it. Without NeuralSeek configured, the vocabulary
above is a hard ceiling.

### Sentences, not just one sign at a time

An earlier version of this app committed every single recognized sign as
its own separate transcript message immediately — sign "HELLO", it's a
message; sign "GOOD" next, that's a second, unrelated message. There was
no way to build an actual sentence.

That's fixed: recognized signs now accumulate into a running sentence
buffer (shown live, dashed border, under the transcript) as you sign them
in sequence. It only becomes a real transcript message when either:
- you move your hand out of frame for `SENTENCE_COMMIT_IDLE_MS` (1.5s
  default, see the constant in `Camera.jsx`) — treated as "done signing
  this sentence," or
- you tap **"Send now"** on the live buffer, if you don't want to wait.

This is still fundamentally word-by-word (fingerspelling-style)
composition, not continuous ASL with real grammar, motion signs, or
non-manual markers (facial expressions, etc.) — that would need a trained
video-sequence model, which is a different, much larger project than
extending a rule-based static-pose classifier. But it's the difference
between "the app outputs isolated words" and "you can actually sign a
short sentence and have it show up as one message."

### Reliability: the typed fallback

Camera and voice recognition both have real, unavoidable limits (small
vocabulary; browser-dependent Web Speech API; camera/mic permissions).
Rather than let a recognition failure block communication, the transcript
panel always has a plain text box — either person can type what they meant
to say at any time, in either mode. Typed messages are marked "⌨️ typed"
in the transcript so it's clear they weren't auto-recognized, but they
work identically for TTS playback. This is the one path in this app that
doesn't depend on a camera, a microphone, a specific browser, or any API
key — treat it as the reliable baseline, and the recognition features as
a convenience on top of it.

---

## If the camera hangs or freezes in production

Three real, separate causes were found and fixed:

1. **Missing `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
   headers.** MediaPipe Hands ships a fast, multi-threaded WASM build, but
   browsers only allow the `SharedArrayBuffer` it needs on pages that are
   "cross-origin isolated" — which requires these two response headers on
   *every* response. Without them, the browser silently falls back to a
   much slower single-threaded WASM path. Most hosts (Railway included)
   don't set these by default. Fixed in `server/main.py` via the
   `CrossOriginIsolation` middleware. Side effect: this also required
   moving Google Fonts loading from a CSS `@import` (which fetches in
   no-cors mode and can get blocked once `require-corp` is set) to
   `<link crossorigin>` tags in `index.html` instead.
2. **An unhandled error could permanently freeze the visible feed.** The
   render loop in `Camera.jsx` called `hands.send()` with no `try/catch`.
   If that single call threw for any reason — a transient WASM hiccup, a
   frame grabbed before the video was fully ready — the `async` loop
   function stopped, and since **the canvas is what's actually visible**
   (the raw `<video>` element is hidden), the last-drawn frame would just
   stay frozen on screen forever, with no error shown. One bad frame,
   silent permanent freeze. Fixed with a `try/catch` around `send()` that
   logs and keeps the loop alive.
3. **Unconstrained camera resolution + the full-precision model.**
   `getUserMedia({ video: true })` lets the browser hand back whatever
   resolution the webcam defaults to (often 1080p+), and `modelComplexity:
   1` is MediaPipe's heaviest/most precise model — multiplying per-frame
   cost for precision this app's rule-based classifier doesn't use. Now
   constrained to `{ width: 640, height: 480 }` (ideal, not exact — won't
   fail on cameras that don't support it exactly) and `modelComplexity: 0`
   (the lite model).

(1) and (2) were almost certainly the dominant causes of "hangs a lot" on
a real deployment; (3) matters more on low-end devices/phones. If you're
deploying your own fork rather than this fixed version, check all three.

---

## ✨ What's inside

- **Frontend:** React 19 + Vite, Tailwind v4, MediaPipe Hands for
  in-browser landmark detection, a rule-based classifier for static signs,
  a NeuralSeek fallback for unrecognized poses, the Web Speech API for
  voice input, and a manual typed-message fallback for both.
- **Backend:** FastAPI with CORS, static file hosting, rate limiting,
  upload validation, a `/api/config` capability check, a NeuralSeek
  streaming endpoint with normalized `{gloss, confidence}` output, and
  `/api/speak` using ElevenLabs TTS.

---

## 🗂 Project layout (key files)

```
speak-bridge/
├── index.html
├── vite.config.js
├── package.json
├── .env.example              # frontend env template
├── public/mediapipe/hands/   # self-hosted MediaPipe assets (see below)
├── src/
│   ├── main.jsx
│   ├── App.jsx                # UI shell, transcript, TTS playback
│   ├── Camera.jsx             # webcam capture + local sign recognition
│   ├── gestureClassifier.js   # rule-based static ASL pose classifier
│   └── VoiceInput.jsx         # Web Speech API voice input
└── server/
    ├── main.py                 # FastAPI app (CORS, static, SSE, TTS, STT, /api/config)
    ├── neuralseek_client.py    # NeuralSeek streaming, wired in as a fallback (see below)
    ├── eleven_labs_client.py   # ElevenLabs speech generation (TTS) and transcription (STT)
    ├── .env.example            # backend env template
    └── static/
```

---

## Requirements & known limitations (read before deploying)

- **Voice input now has three tiers, not one.** Chrome/Edge use the
  browser's built-in Web Speech API directly (free, instant, no backend
  call). Firefox/Safari — which don't implement Web Speech — now get a
  real fallback: `VoiceInput.jsx` records audio with `MediaRecorder`
  (broadly supported, including Firefox/Safari) and posts it to
  `/api/transcribe`, which transcribes it via ElevenLabs' Scribe STT. This
  only activates if `/api/config` confirms `ELEVENLABS_API_KEY` is set —
  otherwise, or if transcription fails, there's still the typed-input box
  as a last resort. So "browser-dependent" no longer means "broken outside
  Chrome," it means "a different (slightly slower, record-then-transcribe)
  path outside Chrome."
- **Camera access requires a secure context.** `getUserMedia` (used for the
  webcam) is only available on `https://` origins or `localhost`. Deploying
  the frontend over plain `http://` will make the camera silently
  unavailable — Camera.jsx now detects this and shows an explicit message
  instead of failing silently.
- **ElevenLabs `ELEVENLABS_API_KEY` powers both TTS and STT.** Without it,
  `/api/speak` returns a clear error (not a stack trace) and the 🔈 button
  won't produce audio, and `/api/transcribe` (the Firefox/Safari voice
  fallback above) won't work either — `/api/config` reports both as
  disabled so the frontend doesn't offer features that would just fail.
- **NeuralSeek is an optional fallback for poses the local classifier doesn't recognize.** Set `NEURALSEEK_API_KEY`, an agent ID/name, and `NEURALSEEK_STREAM_URL` to enable it — there's no hard-coded staging tenant fallback, so if any of these are missing the fallback path just stays off (`/api/config` reports `neuralseek_enabled: false`) rather than silently hitting a wrong endpoint.
- **The typed-message box always works** regardless of any of the above — no camera, mic, browser support, or API key required. If you only deploy one thing correctly, make it `ALLOWED_ORIGINS`/`VITE_API_BASE` so typed messages and TTS still work even if recognition doesn't.
- **MediaPipe assets are now self-hosted** under `public/mediapipe/hands/`
  (copied from the `@mediapipe/hands` npm package) instead of being loaded
  from `cdn.jsdelivr.net`. This removes the CDN as a runtime dependency, at
  the cost of a larger repo (~24MB of model/wasm assets). If you'd rather
  use the CDN, see the comment in `Camera.jsx`'s `locateFile`.

---

## 🔑 Environment variables

**Backend** — copy `server/.env.example` to `server/.env` and fill in:

```ini
ALLOWED_ORIGINS=http://localhost:5173   # your real frontend origin(s) in prod
NEURALSEEK_API_KEY=                     # only needed if you wire in NeuralSeek
NEURALSEEK_AGENT_ID=
# NEURALSEEK_STREAM_URL=https://api.neuralseek.com/v1/<tenant>/maistro_stream
ELEVENLABS_API_KEY=                     # required for the 🔈 speak button
# ELEVENLABS_VOICE_ID=                  # optional, defaults to JBFqnCBsd6RMkjVDRZzb
```

If `ALLOWED_ORIGINS` is left unset, the backend falls back to a public,
**non-credentialed** wildcard CORS policy (fine for local demos, not for
production — set it explicitly before deploying).

**Frontend** — copy `.env.example` to `.env`:

```ini
VITE_API_BASE=                          # optional; only for split-origin hosting
```

The frontend now uses **same-origin API calls by default**. During local
development Vite proxies `/api`, `/health`, and `/static` to FastAPI on port
8000. For the recommended production setup, run `npm run build` and deploy
the backend with the generated `dist/` folder beside `server/`; FastAPI
serves the React app and API from one origin. Set `VITE_API_BASE` only when
you intentionally host frontend and backend on different origins.

---

## Running locally

### Backend (FastAPI)

```bash
cd speak-bridge/server
python3 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # then fill in your keys
python main.py
# → http://localhost:8000
```

### Frontend (Vite + React)

```bash
cd speak-bridge
npm install                     # do NOT reuse a node_modules folder copied
                                 # from a different OS/architecture — native
                                 # deps (e.g. Rollup's platform binary) won't
                                 # match and the build will fail. Always run
                                 # a fresh `npm install` on the target machine.
cp .env.example .env            # optional for local dev
npm run dev
# → http://localhost:5173
```

### Endpoints

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | health check |
| GET | `/api/config` | tells the frontend which optional features (NeuralSeek fallback, TTS, STT) are actually configured |
| POST | `/api/stream/frame` | uploads a frame, updates `/static/latest.png` (rate-limited, size/type-validated) — not called by the current UI, kept for debugging/future use |
| POST | `/api/stream/frame-sse` | streams a held, locally-unrecognized frame to NeuralSeek; called automatically by `Camera.jsx` when `/api/config` says it's enabled (rate-limited) |
| POST | `/api/speak` | text → speech via ElevenLabs (rate-limited to 10 req/min/IP, generic error messages) |
| POST | `/api/transcribe` | audio → text via ElevenLabs Scribe STT; used by `VoiceInput.jsx` on Firefox/Safari (rate-limited, size/type-validated) |

---

## Deploying

1. **Deploy the backend** (FastAPI) somewhere that can run a long-lived
   Python process (Render, Fly.io, Railway, a VM, etc). Set
   `ALLOWED_ORIGINS`, `ELEVENLABS_API_KEY`, and (if used) the NeuralSeek
   vars as real environment variables on that host — not in a committed
   `.env` file.
2. **Build the frontend** into the backend's `dist/` folder so FastAPI can
   serve both from one origin (the default, safest path — see the SPA
   fallback route in `server/main.py`):
   ```bash
   npm run build   # writes to speak-bridge/dist
   ```
   You don't need to set `VITE_API_BASE` for this path — it defaults to
   same-origin. Only set it if you're deploying frontend and backend to
   **different** origins (e.g. Vercel frontend + Render backend):
   ```bash
   VITE_API_BASE=https://your-backend.example.com npm run build
   ```
3. Serve over **HTTPS** (required for camera access — see limitations
   above).
4. If frontend and backend are on different origins, double-check
   `ALLOWED_ORIGINS` on the backend includes the exact frontend origin
   (scheme + host + port, no trailing slash).

### Quick local tunnel (ngrok)

```bash
ngrok http 8000
# copy the https URL, then:
VITE_API_BASE=https://<random>.ngrok-free.app npm run dev
```

---

## 🔌 NeuralSeek fallback: what it expects from your agent

`neuralseek_client.py` posts a base64 PNG data URL to a `maistro_stream`
agent:

```json
{
  "agent_id": "…",
  "params": [
    { "name": "frame_png_b64", "value": "data:image/png;base64,..." },
    { "name": "prior_hypothesis", "value": "" }
  ]
}
```

with `Authorization: Bearer <NEURALSEEK_API_KEY>` and
`Accept: text/event-stream`. Whatever your agent streams back, the backend
tries to parse each token as JSON and pull out `gloss`/`label`/`text`/
`answer` and `confidence`/`score` fields; if a token isn't JSON, the raw
text is used as the gloss directly. Either way, the backend always emits
a normalized `{"gloss": ..., "confidence": ..., "error": ...}` event to
the frontend — that's the one contract `Camera.jsx` actually parses
(`parseNeuralSeekEvent`), so what your agent internally does to recognize
ASL is entirely up to you as long as it returns something in this shape
(or plain gloss text).

## ElevenLabs TTS

- `/api/speak` uses `ELEVENLABS_VOICE_ID` (default `JBFqnCBsd6RMkjVDRZzb`)
  and model `eleven_multilingual_v2`, returning MP3 (44.1kHz/128kbps).
- Errors (missing key, ElevenLabs API failure, etc.) are logged server-side
  and returned to the client as a generic message — the client no longer
  sees raw exception text.
- Requests are rate-limited per IP (10/min) to protect your ElevenLabs
  quota from being exhausted by repeated requests against a public
  deployment. This is an in-memory, single-process limiter — good enough

## ElevenLabs STT (Firefox/Safari voice fallback)

- `/api/transcribe` calls ElevenLabs' `POST /v1/speech-to-text` REST
  endpoint directly (model `scribe_v1`), not through the `elevenlabs`
  Python SDK — the SDK version pinned here (1.8.0) predates that client
  method, so this talks to the documented REST contract instead.
- **This specific call has not been exercised against a live ElevenLabs
  account** — I don't have a real `ELEVENLABS_API_KEY` or network access to
  `api.elevenlabs.io` in the environment I built this in. The request
  shape matches ElevenLabs' published API docs and the error handling
  follows the same pattern as the (tested) TTS path, but you should
  actually record a clip and confirm you get real text back before relying
  on it. If the response shape has changed since this was written, the
  fix is likely just adjusting the `body.get("text", "")` line in
  `eleven_labs_client.transcribe_audio`.
- Rate-limited per IP (15/min) for the same quota-protection reason as
  `/api/speak`.
  for a small deployment, not a substitute for a real API gateway if you
  scale this up.

---

## Key files explained

| File | Description |
|---|---|
| `src/Camera.jsx` | Captures webcam, runs MediaPipe Hands locally, classifies static poses |
| `src/gestureClassifier.js` | Rule-based static ASL pose classifier (the actual recognition logic) |
| `src/VoiceInput.jsx` | Web Speech API voice-to-text |
| `src/App.jsx` | UI shell: transcript, mode switch, TTS playback, `VITE_API_BASE` config |
| `server/main.py` | FastAPI app: CORS, static files, rate limiting, upload validation, TTS |
| `server/neuralseek_client.py` | NeuralSeek streaming logic (available, not wired into the UI) |
| `server/eleven_labs_client.py` | ElevenLabs speech generation |

---

## Troubleshooting

- **Camera shows "Camera requires HTTPS":** deploy behind HTTPS, or test on `localhost`.
- **Camera shows "Camera access denied":** check browser site permissions.
- **Voice mode shows a Chrome message:** the Web Speech API isn't supported in your browser — use Chrome or Edge.
- **`/api/speak` returns 502:** check the backend logs — the real ElevenLabs error is logged server-side even though the client only sees a generic message.
- **`/api/speak` returns 429:** you've hit the per-IP rate limit (10/min); wait a bit.
- **CORS errors:** make sure `ALLOWED_ORIGINS` on the backend exactly matches your frontend's origin.
- **`npm run build` fails with a Rollup/native-binding error:** you're reusing a `node_modules` folder built on a different OS/CPU architecture. Delete it and run `npm install` fresh on the machine that will actually build/run the app.
- **`latest.png` not updating:** that endpoint (`/api/stream/frame`) isn't called by the current UI at all — it's only relevant if you build a feature that posts frames to it.
- **Sign not recognized and nothing happens after ~1s:** if NeuralSeek isn't configured, that's expected — the local classifier only knows its fixed vocabulary. Type the message instead, or configure NeuralSeek. Check the browser console for `NeuralSeek fallback:` warnings if it is configured but still not producing results.
- **Cloud (☁️) results seem wrong or slow:** that's coming from your NeuralSeek agent, not this app's code — the agent's own accuracy and latency are outside what this repo controls. Check `prior_hypothesis` usage and your agent's prompt/logic.

---

## License

MIT (adjust if desired).

## Credits

MediaPipe Hands © Google · Vite & React · NeuralSeek (mAIstro Stream) · ElevenLabs TTS

The local static sign vocabulary remains intentionally limited. That is not
claimed as full ASL. Expanding it reliably requires a trained sign-language
model or a fully specified NeuralSeek recognition response contract; adding
more geometric guesses would make the demo less trustworthy, not more.
"# speak-bridge" 
