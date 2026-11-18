import os
from pathlib import Path
import requests
from elevenlabs.client import ElevenLabs
from dotenv import load_dotenv

# Load relative to this file (not CWD) so keys load regardless of where the
# server process was launched from, and force-reload in case another module
# already populated os.environ with stale values.
load_dotenv(Path(__file__).parent / ".env", override=True)

# Get API key and debug
api_key = os.getenv("ELEVENLABS_API_KEY")
# Configurable so you can swap voices without touching code. Defaults to the
# voice this project was built with. Note: the README previously called this
# "Rachel" — that was stale; this ID is whatever voice is set below/in .env.
VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
client = None

if api_key:
    masked_key = f"{api_key[:7]}...{api_key[-4:]}" if len(api_key) > 11 else "***"
    print(f" ElevenLabs API Key loaded: {masked_key}")
    client = ElevenLabs(api_key=api_key)
else:
    print(" ElevenLabs API Key missing — /api/speak and /api/transcribe will return an error until ELEVENLABS_API_KEY is set")


def elevenlabs_is_configured() -> bool:
    return bool(api_key)


#generate speech function
def generate_speech(text: str) -> bytes:
    if not client:
        raise ValueError("Missing ELEVENLABS_API_KEY — set it as an environment variable to enable speech")

    if not text or not text.strip():
        raise ValueError("Text cannot be empty")
    
    try:
        print(f"Requesting TTS for: '{text[:50]}{'...' if len(text) > 50 else ''}'")    #Testing
        
        # Generate audio using the client
        audio = client.text_to_speech.convert(
            text=text,
            voice_id=VOICE_ID,
            model_id="eleven_multilingual_v2",
            output_format="mp3_44100_128",
        )
        
        # Convert generator to bytes
        audio_bytes = b"".join(audio)
        print(f"Generated {len(audio_bytes)} bytes of audio")
        return audio_bytes
        
    except Exception as e:
        print(f"\\ElevenLabs API Error: {str(e)}")
        raise Exception(f"ElevenLabs API error: {str(e)}")


# ---------------------------------------------------------------------------
# Speech-to-text, via ElevenLabs' Scribe STT REST endpoint.
#
# Why this exists: the frontend's primary voice input (VoiceInput.jsx) uses
# the browser's built-in Web Speech API, which Firefox and Safari don't
# implement. This gives those browsers a real, working voice input path
# instead of "type it instead" — the browser records audio with
# MediaRecorder (broadly supported, including Firefox/Safari) and posts the
# resulting clip here to be transcribed.
#
# Called via raw `requests` rather than the `elevenlabs` SDK client because
# the SDK version pinned in requirements.txt (1.8.0) predates the SDK's
# speech_to_text client method. This talks to the same documented REST
# endpoint the SDK itself would use.
# ---------------------------------------------------------------------------
STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
STT_MODEL_ID = "scribe_v1"


def transcribe_audio(audio_bytes: bytes, filename: str = "audio.webm", content_type: str = "audio/webm") -> str:
    if not api_key:
        raise ValueError("Missing ELEVENLABS_API_KEY — set it as an environment variable to enable voice transcription")
    if not audio_bytes:
        raise ValueError("Audio cannot be empty")

    try:
        resp = requests.post(
            STT_URL,
            headers={"xi-api-key": api_key},
            data={"model_id": STT_MODEL_ID},
            files={"file": (filename, audio_bytes, content_type)},
            timeout=60,
        )
        resp.raise_for_status()
        body = resp.json()
        text = body.get("text", "")
        return text.strip()
    except requests.HTTPError as e:
        detail = ""
        try:
            detail = e.response.text[:300]
        except Exception:
            pass
        raise Exception(f"ElevenLabs STT error: {e} {detail}")
    except requests.RequestException as e:
        raise Exception(f"ElevenLabs STT transport error: {e}")