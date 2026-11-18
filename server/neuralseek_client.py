import os
import json
import base64
from pathlib import Path
import requests
from dotenv import load_dotenv

# Load .env relative to this file, not the process's current working
# directory — otherwise API keys silently fail to load when the server is
# started from a different folder (e.g. a deploy script running from repo root).
load_dotenv(Path(__file__).parent / ".env")

API_KEY = os.getenv("NEURALSEEK_API_KEY", "")
AGENT_NAME = os.getenv("NEURALSEEK_AGENT_NAME", "")
AGENT_ID = os.getenv("NEURALSEEK_AGENT_ID", "")

MAISTRO_STREAM_URL = os.getenv("NEURALSEEK_STREAM_URL", "").strip()


def neuralseek_is_configured() -> bool:
    """True only if every value needed to actually call NeuralSeek is set.
    Used by /api/config so the frontend can decide, up front, whether it's
    worth attempting the cloud-fallback recognition path at all — rather
    than firing requests that are guaranteed to fail with a config error.
    """
    return bool(API_KEY and MAISTRO_STREAM_URL and (AGENT_ID or AGENT_NAME))


def _emit(gloss: str | None = None, confidence: float | None = None, error: str | None = None) -> str:
    """Every event this module yields is one JSON object with this shape,
    regardless of whether it came from a config check, a transport error,
    or the agent itself. This is the normalized contract the frontend
    parses — see src/Camera.jsx's parseNeuralSeekEvent.
    """
    return json.dumps({"gloss": gloss, "confidence": confidence, "error": error})


def _parse_agent_token(raw: str) -> tuple[str | None, float | None]:
    """Best-effort extraction of (gloss, confidence) from whatever a given
    NeuralSeek agent actually sends back. Agent output formats vary by how
    the agent itself is authored — this tries the JSON shape documented in
    README.md first, then falls back to treating the whole token as the
    gloss text so something still shows up in the transcript instead of
    silently dropping the event.
    """
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw.strip() or None, None

    if not isinstance(obj, dict):
        return raw.strip() or None, None

    gloss = obj.get("gloss") or obj.get("label") or obj.get("text") or obj.get("answer")
    confidence = obj.get("confidence") or obj.get("score")
    try:
        confidence = float(confidence) if confidence is not None else None
    except (TypeError, ValueError):
        confidence = None
    return gloss, confidence


# Stream an ASL frame to NeuralSeek and yield normalized {"gloss","confidence","error"} JSON events.
def stream_frame_png(png_bytes: bytes, prior_hypothesis: str = ""):
    if not API_KEY:
        yield _emit(error="Missing NEURALSEEK_API_KEY")
        return
    if not MAISTRO_STREAM_URL:
        yield _emit(error="Missing NEURALSEEK_STREAM_URL")
        return
    if not AGENT_ID and not AGENT_NAME:
        yield _emit(error="Missing NEURALSEEK_AGENT_ID or NEURALSEEK_AGENT_NAME")
        return

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    # convert to data URL
    b64 = base64.b64encode(png_bytes).decode("ascii")
    data_url = f"data:image/png;base64,{b64}"

    agent_field = {"agent_id": AGENT_ID} if AGENT_ID else {"agent": AGENT_NAME}

    payload = {
        **agent_field,
        "params": [
            {"name": "frame_png_b64", "value": data_url},
            {"name": "prior_hypothesis", "value": prior_hypothesis or ""},
        ],
    }

    try:
        with requests.post(
            MAISTRO_STREAM_URL,
            headers=headers,
            json=payload,
            stream=True,
            timeout=120,
        ) as r:
            if r.status_code != 200:
                yield _emit(error=f"NeuralSeek HTTP {r.status_code}: {r.text[:200]}")
                return

            for raw in r.iter_lines(decode_unicode=True):
                if not raw:
                    continue
                line = raw.strip()
                if line.startswith("data:"):
                    line = line[5:].strip()
                if not line:
                    continue
                gloss, confidence = _parse_agent_token(line)
                if gloss:
                    yield _emit(gloss=gloss, confidence=confidence)
    except requests.RequestException as e:
        yield _emit(error=f"NeuralSeek transport error: {e}")
