import os
import time
import logging
from collections import defaultdict, deque
from pathlib import Path
from io import BytesIO

from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, PlainTextResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from neuralseek_client import stream_frame_png, neuralseek_is_configured
from eleven_labs_client import generate_speech, transcribe_audio, elevenlabs_is_configured

from dotenv import load_dotenv  # For Eleven Labs / NeuralSeek API keys

BASE_DIR = Path(__file__).parent.resolve()
# Load relative to this file, not the current working directory, so `.env`
# is found no matter where `python main.py` / `uvicorn` is launched from.
load_dotenv(BASE_DIR / ".env")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("speak-bridge")

STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Speak-Bridge Backend (Public Stream)")

# ---------------------------------------------------------------------------
# CORS
#
# ALLOWED_ORIGINS should be a comma-separated list of the exact frontend
# origin(s) allowed to call this API, e.g.
#   ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:5173
#
# We deliberately do NOT allow credentialed requests from "*" — browsers
# reject that combination anyway, and wildcard + credentials is a classic
# CORS misconfiguration. If no explicit origins are configured we fall back
# to an unauthenticated, non-credentialed wildcard (fine for a public demo,
# but you should set ALLOWED_ORIGINS before a real deployment).
# ---------------------------------------------------------------------------
allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "").strip()
if allowed_origins_env:
    origins = [o.strip() for o in allowed_origins_env.split(",") if o.strip()]
    allow_credentials = True
else:
    log.warning(
        "ALLOWED_ORIGINS is not set — falling back to a public, non-credentialed "
        "wildcard CORS policy. Set ALLOWED_ORIGINS to your real frontend origin(s) "
        "before deploying."
    )
    origins = ["*"]
    allow_credentials = False

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


#  Prevent caching of latest.png
class NoCacheLatest(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        if request.url.path.endswith("/static/latest.png"):
            resp.headers["Cache-Control"] = "no-store, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        return resp


app.add_middleware(NoCacheLatest)


# ---------------------------------------------------------------------------
# Cross-origin isolation headers, for MediaPipe performance.
#
# This is very likely the actual cause of "the camera hangs a lot" once
# deployed. MediaPipe Hands ships a multi-threaded, SIMD WASM build that's
# dramatically faster than its single-threaded fallback — but browsers only
# allow `SharedArrayBuffer` (which the threaded build needs) on pages that
# are "cross-origin isolated", which requires these two response headers on
# every response. Without them, the browser silently falls back to the slow
# single-threaded WASM path, and hand-tracking inference that should take
# single-digit milliseconds can instead take hundreds of milliseconds per
# frame — which reads exactly like "the camera hangs."
#
# This mattered less in local dev because `npm run dev` may behave
# differently across browsers/versions, but a real deployment needs these
# headers set explicitly — most hosts (Railway included) don't set them by
# default. All of this app's own assets (JS bundles, MediaPipe files,
# images, fonts loaded via Google Fonts' CORS-enabled endpoint) are
# compatible with `require-corp`; if you add other cross-origin resources
# later and the page breaks, that's the header to check first.
# ---------------------------------------------------------------------------
class CrossOriginIsolation(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        resp.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        return resp


app.add_middleware(CrossOriginIsolation)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# ---------------------------------------------------------------------------
# Minimal in-memory rate limiter (no extra dependency needed).
#
# This is intentionally simple: it's per-process, per-IP, sliding-window.
# Good enough to stop someone from hammering /api/speak and burning your
# ElevenLabs quota from a single client. For multi-instance deployments,
# replace with a shared store (e.g. Redis) — this won't coordinate across
# processes/machines.
# ---------------------------------------------------------------------------
_RATE_LIMITS = {
    "/api/speak": (10, 60),          # 10 requests / 60s per IP
    "/api/transcribe": (15, 60),
    "/api/stream/frame": (120, 60),  # frames come in fast during camera use
    "/api/stream/frame-sse": (60, 60),
}
_request_log: dict[str, deque] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limited(request: Request, route: str) -> bool:
    limit, window = _RATE_LIMITS.get(route, (30, 60))
    key = f"{route}:{_client_ip(request)}"
    now = time.monotonic()
    q = _request_log[key]
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(now)
    return False


# Upload constraints
MAX_FRAME_BYTES = 5 * 1024 * 1024  # 5 MB
ALLOWED_FRAME_TYPES = {"image/png", "image/jpeg"}
MAX_SPEAK_CHARS = 2000
MAX_AUDIO_BYTES = 15 * 1024 * 1024  # 15 MB — a few minutes of compressed speech
ALLOWED_AUDIO_TYPES = {
    "audio/webm", "audio/ogg", "audio/wav", "audio/wave", "audio/x-wav",
    "audio/mp4", "audio/mpeg", "audio/mp3",
}


def _validate_frame(frame: UploadFile, data: bytes) -> str | None:
    """Returns an error message if the upload is invalid, else None."""
    if not data:
        return "empty frame"
    if len(data) > MAX_FRAME_BYTES:
        return f"frame too large (max {MAX_FRAME_BYTES // (1024 * 1024)}MB)"
    if frame.content_type and frame.content_type not in ALLOWED_FRAME_TYPES:
        return f"unsupported content type: {frame.content_type}"
    return None


def _validate_audio(audio: UploadFile, data: bytes) -> str | None:
    if not data:
        return "empty audio"
    if len(data) > MAX_AUDIO_BYTES:
        return f"audio too large (max {MAX_AUDIO_BYTES // (1024 * 1024)}MB)"
    if audio.content_type and audio.content_type.split(";")[0] not in ALLOWED_AUDIO_TYPES:
        return f"unsupported content type: {audio.content_type}"
    return None


#  Health check
@app.get("/health")
def health():
    return {"ok": True, "time": int(time.time())}


# Lets the frontend know, without guessing or hardcoding, whether the
# NeuralSeek fallback path is actually usable right now. The hybrid
# recognition pipeline (local classifier first, cloud fallback for
# unrecognized poses) uses this to decide whether it's worth attempting a
# frame upload at all — avoids spamming a misconfigured endpoint with
# doomed requests, and avoids the frontend silently pretending a feature
# exists when it doesn't.
@app.get("/api/config")
def get_config():
    return {
        "neuralseek_enabled": neuralseek_is_configured(),
        # Same underlying key powers both; exposed separately since a
        # future deployment could reasonably have one without the other.
        "tts_enabled": elevenlabs_is_configured(),
        "stt_enabled": elevenlabs_is_configured(),
    }


# Upload ASL frame endpoint
@app.post("/api/stream/frame")
async def upload_frame(request: Request, frame: UploadFile = File(...)):
    if _rate_limited(request, "/api/stream/frame"):
        return PlainTextResponse("rate limit exceeded", status_code=429)

    data = await frame.read()
    err = _validate_frame(frame, data)
    if err:
        return PlainTextResponse(err, status_code=400)

    tmp = STATIC_DIR / f"latest_{int(time.time()*1000)}.png"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, STATIC_DIR / "latest.png")

    return {"ok": True, "url": "/static/latest.png", "bytes": len(data)}


@app.post("/api/stream/frame-sse")
async def stream_frame(
    request: Request,
    frame: UploadFile = File(...),
    prior_hypothesis: str = Form(default=""),
):
    if _rate_limited(request, "/api/stream/frame-sse"):
        return PlainTextResponse("rate limit exceeded", status_code=429)

    data = await frame.read()
    err = _validate_frame(frame, data)
    if err:
        return PlainTextResponse(err, status_code=400)


    def gen():
        for token in stream_frame_png(data, prior_hypothesis=prior_hypothesis):
            yield f"data: {token}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# Generate speech through ElevenLabs
@app.post("/api/speak")
async def speak(request: Request, text: str = Form(...)):
    if _rate_limited(request, "/api/speak"):
        return PlainTextResponse("rate limit exceeded — please slow down", status_code=429)

    if not text or not text.strip():
        return PlainTextResponse("text cannot be empty", status_code=400)
    if len(text) > MAX_SPEAK_CHARS:
        return PlainTextResponse(f"text too long (max {MAX_SPEAK_CHARS} chars)", status_code=400)

    try:
        audio_bytes = generate_speech(text)
        return StreamingResponse(BytesIO(audio_bytes), media_type="audio/mpeg")
    except Exception as e:
        # Log the real error server-side, but never leak internals (stack
        # traces, API error bodies, key hints, etc.) to the client.
        log.error("TTS generation failed: %s", e)
        return JSONResponse(
            {"error": "Speech generation failed. Please try again later."},
            status_code=502,
        )


# Speech-to-text fallback for browsers without the Web Speech API
# (Firefox, Safari). The frontend records audio with MediaRecorder and
# posts the clip here; see eleven_labs_client.transcribe_audio for why this
# calls ElevenLabs' REST endpoint directly instead of through the SDK.
@app.post("/api/transcribe")
async def transcribe(request: Request, audio: UploadFile = File(...)):
    if _rate_limited(request, "/api/transcribe"):
        return PlainTextResponse("rate limit exceeded — please slow down", status_code=429)

    data = await audio.read()
    err = _validate_audio(audio, data)
    if err:
        return PlainTextResponse(err, status_code=400)

    try:
        text = transcribe_audio(data, filename=audio.filename or "audio.webm", content_type=audio.content_type or "audio/webm")
        return {"text": text}
    except Exception as e:
        log.error("STT transcription failed: %s", e)
        return JSONResponse(
            {"error": "Transcription failed. Please try again or type your message."},
            status_code=502,
        )


# Optional unified deployment: after `npm run build`, FastAPI serves `dist/`.
# API/static routes above keep priority; the SPA fallback handles frontend routes.
DIST_DIR = BASE_DIR.parent / "dist"
if DIST_DIR.exists():
    from fastapi.responses import FileResponse

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        candidate = (DIST_DIR / full_path).resolve()
        try:
            candidate.relative_to(DIST_DIR.resolve())
        except ValueError:
            return PlainTextResponse("not found", status_code=404)
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", 8000)), reload=False)
