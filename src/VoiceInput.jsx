import React, { useEffect, useRef, useState } from "react";

// Same-origin by default; see App.jsx for the reasoning.
const API_BASE = (import.meta.env?.VITE_API_BASE || "").replace(/\/$/, "");

export default function VoiceInput({ onFinalText, onStatusChange, isDark }) {
  const recognitionRef = useRef(null);
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  // "webspeech" | "recorder" | "typed" — which path this browser gets.
  // Starts null until we've checked both browser support AND whether the
  // backend actually has STT configured (no point offering "record audio"
  // if there's no ELEVENLABS_API_KEY to transcribe it with).
  const [mode, setMode] = useState(null);
  const [manualText, setManualText] = useState("");

  // ---- Recorder-path state (Firefox/Safari fallback) ----
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const streamRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const submitManualText = (event) => {
    event?.preventDefault();
    const value = manualText.trim();
    if (!value) return;
    onFinalText?.(value);
    setManualText("");
    onStatusChange?.("Text added to conversation");
  };

  // Decide which voice path this browser/deployment actually supports.
  useEffect(() => {
    let cancelled = false;
    const hasWebSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const hasRecorder = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

    if (hasWebSpeech) {
      // Chrome/Edge: use the fast, free, built-in path. No backend call needed.
      setMode("webspeech");
      return;
    }

    if (!hasRecorder) {
      setMode("typed");
      onStatusChange?.("Voice input isn't available in this browser — type your message instead");
      return;
    }

    // Firefox/Safari: MediaRecorder is supported, but we still need the
    // backend to actually have STT configured before offering it —
    // otherwise every recording would just fail with a config error.
    fetch(`${API_BASE}/api/config`)
      .then((r) => (r.ok ? r.json() : { stt_enabled: false }))
      .then((cfg) => {
        if (cancelled) return;
        if (cfg.stt_enabled) {
          setMode("recorder");
          onStatusChange?.("Tap the mic to record, tap again to transcribe");
        } else {
          setMode("typed");
          onStatusChange?.(
            "This browser doesn't support live speech recognition, and voice transcription isn't configured on the server — type your message instead"
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMode("typed");
          onStatusChange?.("Couldn't reach the server to check voice support — type your message instead");
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Web Speech API path (Chrome/Edge) ----
  const isListeningRef = useRef(false);

  useEffect(() => {
    if (mode !== "webspeech") return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setIsListening(true);
      onStatusChange?.("Listening…");
    };

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          onFinalText?.(transcript.trim());
        } else {
          interim += transcript;
        }
      }
      setInterimText(interim);
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        onStatusChange?.("Microphone access denied");
      } else if (event.error === "no-speech") {
        // benign, keep listening
      } else {
        onStatusChange?.(`Mic error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      // auto-restart if we were still supposed to be listening (browser stops after silence)
      if (isListeningRef.current) {
        try {
          recognition.start();
        } catch {
          // already started, ignore
        }
      } else {
        onStatusChange?.("Mic paused — click Start to resume");
      }
    };

    recognitionRef.current = recognition;

    return () => {
      isListeningRef.current = false;
      try {
        recognition.stop();
      } catch {
        // ignore: recognition may already be stopped
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  const toggleListening = () => {
    if (!recognitionRef.current) return;

    if (isListening) {
      isListeningRef.current = false;
      setIsListening(false);
      recognitionRef.current.stop();
      setInterimText("");
      onStatusChange?.("Mic stopped");
    } else {
      isListeningRef.current = true;
      try {
        recognitionRef.current.start();
      } catch {
        // ignore "already started" errors
      }
    }
  };

  // ---- MediaRecorder + backend STT path (Firefox/Safari) ----
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recordedChunksRef.current = [];

      // Let the browser pick a mimeType it actually supports; Chrome/Firefox
      // default to webm/opus, Safari to mp4 — the backend accepts either.
      const options = MediaRecorder.isTypeSupported("audio/webm")
        ? { mimeType: "audio/webm" }
        : {};
      const recorder = new MediaRecorder(stream, options);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        if (blob.size === 0) {
          onStatusChange?.("No audio captured — try again");
          return;
        }

        setIsTranscribing(true);
        onStatusChange?.("Transcribing…");
        try {
          const formData = new FormData();
          const ext = (recorder.mimeType || "audio/webm").includes("mp4") ? "mp4" : "webm";
          formData.append("audio", blob, `recording.${ext}`);

          const response = await fetch(`${API_BASE}/api/transcribe`, {
            method: "POST",
            body: formData,
          });

          if (!response.ok) {
            let message = `Transcription failed (${response.status})`;
            try {
              const body = await response.json();
              if (body?.error) message = body.error;
            } catch {
              // ignore, use default message
            }
            throw new Error(message);
          }

          const { text } = await response.json();
          if (text && text.trim()) {
            onFinalText?.(text.trim());
            onStatusChange?.("Tap the mic to record another message");
          } else {
            onStatusChange?.("Didn't catch that — try again, or type it below");
          }
        } catch (err) {
          console.error("Transcription error:", err);
          onStatusChange?.(`${err.message} — you can type your message instead`);
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      onStatusChange?.("Recording… tap again to stop and transcribe");
    } catch (err) {
      console.error("Microphone error:", err);
      onStatusChange?.("Microphone access denied");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ---- Render ----

  if (mode === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={isDark ? "text-purple-200/60 text-sm" : "text-slate-400 text-sm"}>
          Checking voice input support…
        </p>
      </div>
    );
  }

  if (mode === "typed") {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-4">
        <p className={isDark ? "text-purple-200/70" : "text-slate-500"}>
          Live voice input isn't available right now in this browser/deployment.
          Type the spoken message below instead.
        </p>
        <form onSubmit={submitManualText} className="w-full max-w-md flex gap-2">
          <input
            value={manualText}
            onChange={(event) => setManualText(event.target.value)}
            placeholder="Type the spoken message…"
            aria-label="Type spoken message"
            className={
              "flex-1 rounded-xl px-3 py-2 border outline-none " +
              (isDark
                ? "bg-[#1a1028] border-purple-500/50 text-purple-50"
                : "bg-white border-purple-300 text-slate-900")
            }
          />
          <button
            type="submit"
            disabled={!manualText.trim()}
            className="rounded-xl px-4 py-2 bg-purple-600 text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    );
  }

  if (mode === "recorder") {
    const active = isRecording || isTranscribing;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
        <button
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isTranscribing}
          className={
            "h-24 w-24 rounded-full flex items-center justify-center text-4xl transition-all border-4 disabled:opacity-60 " +
            (active
              ? "bg-purple-500/30 border-purple-400 shadow-[0_0_30px_rgba(168,85,247,0.7)] animate-pulse"
              : isDark
              ? "bg-[#2a1b3d] border-[#4c1d95] hover:bg-purple-500/20"
              : "bg-purple-50 border-purple-300 hover:bg-purple-100")
          }
          aria-label={isRecording ? "Stop recording" : "Start recording"}
        >
          {isTranscribing ? "⏳" : "🎤"}
        </button>
        <p className={"text-sm font-medium " + (isDark ? "text-purple-200" : "text-purple-700")}>
          {isTranscribing
            ? "Transcribing…"
            : isRecording
            ? "Recording… tap to stop"
            : "Tap the mic to record"}
        </p>
        <p className={"text-xs text-center max-w-xs " + (isDark ? "text-purple-300/50" : "text-slate-400")}>
          This browser doesn't support live speech recognition, so this
          records a short clip and transcribes it after you stop.
        </p>
      </div>
    );
  }

  // mode === "webspeech"
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
      <button
        type="button"
        onClick={toggleListening}
        className={
          "h-24 w-24 rounded-full flex items-center justify-center text-4xl transition-all border-4 " +
          (isListening
            ? "bg-purple-500/30 border-purple-400 shadow-[0_0_30px_rgba(168,85,247,0.7)] animate-pulse"
            : isDark
            ? "bg-[#2a1b3d] border-[#4c1d95] hover:bg-purple-500/20"
            : "bg-purple-50 border-purple-300 hover:bg-purple-100")
        }
        aria-label={isListening ? "Stop listening" : "Start listening"}
      >
        🎤
      </button>

      <p className={"text-sm font-medium " + (isDark ? "text-purple-200" : "text-purple-700")}>
        {isListening ? "Listening… tap to stop" : "Tap the mic to start speaking"}
      </p>

      {interimText && (
        <p className={"text-xs italic text-center max-w-xs " + (isDark ? "text-purple-300/60" : "text-slate-400")}>
          "{interimText}"
        </p>
      )}
    </div>
  );
}
