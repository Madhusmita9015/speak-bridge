import { useState, useMemo, useRef } from "react";
import CameraFeed from "./Camera";
import VoiceInput from "./VoiceInput";

const SQUARE_COUNT = 80;
// Same-origin is the safe default. In local development Vite proxies /api
// to FastAPI; in the recommended production deployment FastAPI serves the
// built frontend too. VITE_API_BASE is only needed for split-origin hosting.
const API_BASE = (import.meta.env?.VITE_API_BASE || "").replace(/\/$/, "");

const PURPLE_COLORS = [
  "#a855f7",
  "#7c3aed",
  "#c4b5fd",
  "#d8b4fe",
  "#4c1d95",
];

let messageIdCounter = 0;
const nextMessageId = () => {
  messageIdCounter += 1;
  return messageIdCounter;
};

function App() {
  const [mode, setMode] = useState("sign"); // "sign" | "voice"

  const [handStatus, setHandStatus] = useState("Waiting for hand signs…");
  const [voiceStatus, setVoiceStatus] = useState("Tap the mic to start speaking");

  // Live buffer for the sign-language recognizer (streams token-by-token per gesture)
  const [liveSignText, setLiveSignText] = useState("");

  // Full conversation transcript: [{ id, sender: 'sign' | 'voice', text }]
  const [messages, setMessages] = useState([]);

  const [theme, setTheme] = useState("dark");
  const [speakingId, setSpeakingId] = useState(null);
  const isDark = theme === "dark";
  const audioRef = useRef(new Audio());

  const addMessage = (sender, text, typed = false) => {
    if (!text || !text.trim()) return;
    setMessages((prev) => [
      ...prev,
      { id: nextMessageId(), sender, text: text.trim(), typed },
    ]);
  };

  // Manual fallback: sign recognition only knows ~12 poses, and voice
  // recognition only works in Chromium browsers. Rather than let either
  // limitation actually block a conversation, either side can always just
  // type what they meant to say — attributed to whichever side is
  // currently active, and visibly marked "typed" so it's clear it wasn't
  // auto-recognized.
  const [typedInput, setTypedInput] = useState("");
  const submitTypedMessage = (e) => {
    e.preventDefault();
    if (!typedInput.trim()) return;
    addMessage(mode, typedInput, true);
    setTypedInput("");
  };

  // Camera.jsx calls this with either a plain string (to clear/reset the
  // live buffer) or a functional update (to append streamed tokens).
  // We intercept the "clear" call to finalize whatever was just recognized
  // into the conversation transcript before resetting.
  const handleRecognizedText = (update) => {
    setLiveSignText((prev) => {
      if (typeof update === "function") {
        return update(prev);
      }
      // update is a plain string, used by Camera.jsx to reset the buffer
      if (update === "" && prev) {
        addMessage("sign", prev);
      }
      return update;
    });
  };

  const handleFinalVoiceText = (text) => {
    addMessage("voice", text);
  };

  // Function to request speech from backend for a given message
  const playSpeech = async (id, text) => {
    if (!text || speakingId) return;

    try {
      setSpeakingId(id);

      const formData = new FormData();
      formData.append("text", text);

      const response = await fetch(`${API_BASE}/api/speak`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let message = `Server error (${response.status})`;
        try {
          const errBody = await response.json();
          if (errBody?.error) message = errBody.error;
        } catch {
          const errText = await response.text().catch(() => "");
          if (errText) message = errText;
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const audioURL = URL.createObjectURL(blob);

      if (audioRef.current.src) {
        URL.revokeObjectURL(audioRef.current.src);
      }

      audioRef.current.src = audioURL;
      audioRef.current.onended = () => {
        setSpeakingId(null);
        URL.revokeObjectURL(audioURL);
      };
      audioRef.current.onerror = () => {
        setSpeakingId(null);
        URL.revokeObjectURL(audioURL);
      };

      await audioRef.current.play();
    } catch (err) {
      console.error("Speech error:", err);
      alert(`Speech Error: ${err.message}`);
      setSpeakingId(null);
    }
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const switchMode = (newMode) => {
    if (newMode === mode) return;
    setMode(newMode);
    setLiveSignText("");
  };

  const squares = useMemo(() => {
    return Array.from({ length: SQUARE_COUNT }).map((_, i) => {
      const left = Math.random() * 100;
      const size = 10 + Math.random() * 20;
      const delay = Math.random() * 8;
      const duration = 6 + Math.random() * 6;
      const color =
        PURPLE_COLORS[Math.floor(Math.random() * PURPLE_COLORS.length)];

      return { id: i, left, size, delay, duration, color };
    });
  }, []);

  const inputStatus = mode === "sign" ? handStatus : voiceStatus;

  return (
    <div
      className={
        "relative min-h-screen flex items-center justify-center px-4 md:px-6 py-6 overflow-hidden " +
        (isDark ? "text-[#f3e9ff]" : "text-slate-900")
      }
    >
      <div
        className={
          "absolute inset-0 -z-20 " +
          (isDark ? "bg-[#050012]" : "bg-slate-100")
        }
      />

      <div className="pointer-events-none absolute inset-0 -z-10 purple-fire">
        {squares.map((sq) => (
          <span
            key={sq.id}
            style={{
              left: `${sq.left}%`,
              width: `${sq.size}px`,
              height: `${sq.size}px`,
              backgroundColor: sq.color,
              animationDelay: `${sq.delay}s`,
              animationDuration: `${sq.duration}s`,
            }}
          />
        ))}
      </div>

      <div
        className={
          "w-full max-w-6xl overflow-hidden flex flex-col backdrop-blur-sm rounded-2xl border " +
          (isDark
            ? "bg-[#1a1028]/80 border-[#3c1361] shadow-[0_20px_60px_rgba(64,0,128,0.6)]"
            : "bg-white/90 border-purple-200 shadow-none")
        }
      >
        <header
          className={
            "flex items-center justify-between px-4 md:px-6 py-1.5 border-b bg-transparent mt-0 gap-3 flex-wrap " +
            (isDark ? "border-[#3c1361]" : "border-purple-200")
          }
        >
          <div className="flex items-center gap-2 py-1">
            <img
              src="/src/assets/logo.png"
              alt="SpeakBridge Logo"
              className={
                "h-10 w-10 rounded-xl " +
                (isDark
                  ? "shadow-[0_0_10px_rgba(147,51,234,0.8)]"
                  : "shadow-none")
              }
            />
            <h1
              className={
                "m-0 text-xl md:text-2xl font-bold leading-none " +
                (isDark ? "text-purple-200" : "text-purple-700")
              }
            >
              SpeakBridge
            </h1>
          </div>

          <div className="flex items-center gap-2">
            {/* Mode switch: who is "speaking" right now */}
            <div
              className={
                "flex items-center rounded-full border p-0.5 text-xs md:text-sm " +
                (isDark ? "border-purple-400/70" : "border-purple-400/70")
              }
            >
              <button
                type="button"
                onClick={() => switchMode("sign")}
                className={
                  "px-3 py-1 rounded-full transition " +
                  (mode === "sign"
                    ? isDark
                      ? "bg-purple-500/40 text-purple-50"
                      : "bg-purple-600 text-white"
                    : isDark
                    ? "text-purple-200/70 hover:bg-purple-500/10"
                    : "text-purple-700 hover:bg-purple-100")
                }
              >
                🤟 Sign
              </button>
              <button
                type="button"
                onClick={() => switchMode("voice")}
                className={
                  "px-3 py-1 rounded-full transition " +
                  (mode === "voice"
                    ? isDark
                      ? "bg-purple-500/40 text-purple-50"
                      : "bg-purple-600 text-white"
                    : isDark
                    ? "text-purple-200/70 hover:bg-purple-500/10"
                    : "text-purple-700 hover:bg-purple-100")
                }
              >
                🎤 Voice
              </button>
            </div>

            <button
              type="button"
              onClick={toggleTheme}
              className={
                "text-xs md:text-sm px-3 py-1 rounded-full border transition " +
                (isDark
                  ? "border-purple-400/70 bg-purple-500/20 text-purple-100 hover:bg-purple-500/30"
                  : "border-purple-400/70 bg-purple-100 text-purple-900 hover:bg-purple-200")
              }
            >
              {isDark ? "Light Mode" : "Dark Mode"}
            </button>
          </div>
        </header>

        <main
          className={
            "px-4 md:px-6 py-3 min-h-0 flex-1 " +
            (isDark ? "bg-[#1a1028]/80" : "bg-white/80")
          }
        >
          <div className="grid md:grid-cols-2 gap-4">
            {/* LEFT: Input zone (camera or mic depending on mode) */}
            <div className="flex flex-col gap-2">
              <div
                className={
                  "rounded-xl overflow-hidden border " +
                  (isDark
                    ? "bg-[#2a1b3d] border-[#4c1d95]"
                    : "bg-white border-purple-200 shadow-none")
                }
              >
                <div
                  className={
                    "flex items-center justify-between px-3 py-1.5 border-b text-[0.7rem] " +
                    (isDark
                      ? "border-[#4c1d95]/50 text-purple-200/70"
                      : "border-purple-200 text-purple-700/80 font-medium")
                  }
                >
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-purple-400" />
                    {mode === "sign" ? "Live Camera Feed" : "Live Microphone"}
                  </span>
                  <span
                    className={
                      "uppercase tracking-wide " +
                      (isDark
                        ? "text-purple-300/70"
                        : "text-purple-600 font-semibold")
                    }
                  >
                    Input Zone
                  </span>
                </div>

                <div className="aspect-[4/3] bg-black/60 flex items-center justify-center">
                  {mode === "sign" ? (
                    <CameraFeed
                      onGesturesChange={setHandStatus}
                      onRecognizedText={handleRecognizedText}
                      canvasClassName="w-full h-full rounded-none"
                    />
                  ) : (
                    <VoiceInput
                      onFinalText={handleFinalVoiceText}
                      onStatusChange={setVoiceStatus}
                      isDark={isDark}
                    />
                  )}
                </div>
              </div>

              <div
                className={
                  "rounded-lg px-3 py-2 text-sm flex items-center justify-between gap-2 border " +
                  (isDark
                    ? "bg-[#2a1b3d] border-[#4c1d95] text-purple-100"
                    : "bg-purple-50 border-purple-200 text-purple-900 shadow-none")
                }
              >
                <span className="truncate">{inputStatus}</span>

                <span
                  className={
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide whitespace-nowrap " +
                    (isDark
                      ? "border-purple-400/60 bg-purple-500/20 text-purple-200"
                      : "border-purple-300 bg-purple-50 text-purple-700")
                  }
                >
                  <span
                    className={
                      "h-2 w-2 rounded-full animate-pulse " +
                      (isDark ? "bg-purple-300" : "bg-purple-700")
                    }
                  />
                  {mode === "sign" ? "Camera Active" : "Mic Mode"}
                </span>
              </div>
            </div>

            {/* RIGHT: Conversation transcript */}
            <div
              className={
                "rounded-xl flex flex-col border " +
                (isDark
                  ? "bg-[#2a1b3d] border-[#4c1d95] shadow-[0_0_20px_rgba(147,51,234,0.25)]"
                  : "bg-white border-purple-200 shadow-none")
              }
            >
              <div
                className={
                  "flex items-center justify-between px-3 py-1.5 border-b text-[0.7rem] " +
                  (isDark
                    ? "border-[#4c1d95]/50 text-purple-200/70"
                    : "border-purple-200 text-purple-700/80 font-medium")
                }
              >
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-purple-400" />
                  Conversation
                </span>
                <span
                  className={
                    "uppercase tracking-wide " +
                    (isDark
                      ? "text-purple-300/70"
                      : "text-purple-600 font-semibold")
                  }
                >
                  🤟 Sign · 🎤 Voice
                </span>
              </div>

              <div className="px-3 py-3 flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
                {messages.length === 0 && !liveSignText ? (
                  <p
                    className={
                      "text-sm md:text-base leading-relaxed opacity-60 " +
                      (isDark ? "text-purple-100" : "text-slate-900")
                    }
                  >
                    No conversation yet. Sign into the camera or tap the mic
                    and start speaking — messages from both sides will show up
                    here.
                  </p>
                ) : (
                  messages.map((msg) => {
                    const isSign = msg.sender === "sign";
                    return (
                      <div
                        key={msg.id}
                        className={
                          "max-w-[85%] rounded-2xl px-3 py-2 text-sm md:text-base leading-relaxed flex flex-col gap-1 " +
                          (isSign ? "self-start" : "self-end") +
                          " " +
                          (isSign
                            ? isDark
                              ? "bg-purple-500/20 border border-purple-400/40 text-purple-50"
                              : "bg-purple-100 border border-purple-300 text-purple-900"
                            : isDark
                            ? "bg-fuchsia-500/15 border border-fuchsia-400/30 text-fuchsia-50"
                            : "bg-fuchsia-50 border border-fuchsia-200 text-fuchsia-900")
                        }
                      >
                        <span
                          className={
                            "text-[0.65rem] uppercase tracking-wide opacity-70 flex items-center gap-2 " +
                            (isSign ? "" : "justify-end")
                          }
                        >
                          {isSign ? "🤟 Sign" : "🎤 Voice"}
                          {msg.typed && <span className="opacity-80">· ⌨️ typed</span>}
                        </span>
                        <div className="flex items-end gap-2">
                          <span className="whitespace-pre-line">{msg.text}</span>
                          <button
                            onClick={() => playSpeech(msg.id, msg.text)}
                            disabled={speakingId !== null}
                            title="Hear this message aloud"
                            className={
                              "shrink-0 rounded-full p-1 transition text-xs " +
                              (isDark
                                ? "hover:bg-purple-500/20 disabled:opacity-40"
                                : "hover:bg-purple-100 disabled:opacity-40")
                            }
                          >
                            {speakingId === msg.id ? "🔊" : "🔈"}
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}

                {/* live in-progress sign recognition buffer */}
                {liveSignText && (
                  <div
                    className={
                      "max-w-[85%] self-start rounded-2xl px-3 py-2 text-sm md:text-base leading-relaxed border border-dashed opacity-90 flex items-end gap-2 " +
                      (isDark
                        ? "border-purple-400/40 text-purple-100"
                        : "border-purple-300 text-purple-900")
                    }
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-[0.65rem] uppercase tracking-wide opacity-70">
                        🤟 Sign (building sentence — pause with hand away, or send now)
                      </span>
                      <div className="whitespace-pre-line">{liveSignText}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        addMessage("sign", liveSignText);
                        setLiveSignText("");
                      }}
                      className={
                        "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition " +
                        (isDark
                          ? "bg-purple-600 hover:bg-purple-500 text-white"
                          : "bg-purple-600 hover:bg-purple-700 text-white")
                      }
                    >
                      Send now
                    </button>
                  </div>
                )}
              </div>

              <form
                onSubmit={submitTypedMessage}
                className={
                  "flex items-center gap-2 px-3 py-2 border-t " +
                  (isDark ? "border-[#4c1d95]/50" : "border-purple-200")
                }
              >
                <input
                  type="text"
                  value={typedInput}
                  onChange={(e) => setTypedInput(e.target.value)}
                  placeholder={
                    mode === "sign"
                      ? "Sign not recognized? Type it instead…"
                      : "Voice not working? Type it instead…"
                  }
                  className={
                    "flex-1 min-w-0 rounded-full px-3 py-1.5 text-sm outline-none border " +
                    (isDark
                      ? "bg-[#1a1028] border-purple-400/40 text-purple-50 placeholder:text-purple-300/50 focus:border-purple-300"
                      : "bg-white border-purple-200 text-slate-900 placeholder:text-slate-400 focus:border-purple-400")
                  }
                />
                <button
                  type="submit"
                  disabled={!typedInput.trim()}
                  className={
                    "shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 " +
                    (isDark
                      ? "bg-purple-600 hover:bg-purple-500 text-white"
                      : "bg-purple-600 hover:bg-purple-700 text-white")
                  }
                >
                  Send
                </button>
              </form>
            </div>
          </div>
        </main>

        <footer
          className={
            "px-4 md:px-6 py-2 border-t text-[0.75rem] text-center bg-transparent " +
            (isDark
              ? "border-[#3c1361] text-purple-100/90"
              : "border-purple-200 text-slate-600 font-medium")
          }
        >
          <p>Built by Madhusmita • built with 0 sleep, 100% rizz</p>
        </footer>
      </div>
    </div>
  );
}

export default App;
