import React, { useEffect, useRef, useState } from "react";
import { Hands } from "@mediapipe/hands";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import { classifyHandShape } from "./gestureClassifier";

// Same-origin by default (see App.jsx for the reasoning); only overridden
// for split-origin hosting via VITE_API_BASE.
const API_BASE = (import.meta.env?.VITE_API_BASE || "").replace(/\/$/, "");

const HOLD_MS_BEFORE_RECOGNIZE = 350; // how long a pose must stay still before we call it "held"
// How long the hand must be out of frame before a pause counts as "done
// signing this sentence" and gets committed as one transcript message,
// rather than just a brief gap between two signs in the same sentence.
const SENTENCE_COMMIT_IDLE_MS = 1500;
// A pose has to stay held this much longer than HOLD_MS_BEFORE_RECOGNIZE
// before we bother asking the cloud fallback about it. This avoids firing
// a network request for every brief unrecognized shape a hand passes
// through on its way to a real pose (e.g. mid-transition blur).
const CLOUD_FALLBACK_HOLD_MS = 700;
const CLOUD_FALLBACK_COOLDOWN_MS = 2500; // don't hammer the backend while a pose sits unrecognized

// ---- New motion-gating constants ----
const MOTION_STILL_THRESH = 0.006;   // ~0.6% of frame diagonal
const MOTION_MOVE_THRESH  = 0.012;   // ~1.2% of frame diagonal (hysteresis)
const STABLE_FRAMES_REQUIRED = 3;    // need N consecutive “still” frames
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
];

// Parses one SSE `data:` line from /api/stream/frame-sse into a normalized
// { gloss, confidence, error } shape. The backend already normalizes
// whatever the NeuralSeek agent sends into this JSON contract (see
// server/neuralseek_client.py), so this is mostly just JSON.parse with a
// safety net in case a proxy or agent misconfiguration sends something else.
function parseNeuralSeekEvent(raw) {
  try {
    const obj = JSON.parse(raw);
    return {
      gloss: typeof obj.gloss === "string" ? obj.gloss : null,
      confidence: typeof obj.confidence === "number" ? obj.confidence : null,
      error: typeof obj.error === "string" ? obj.error : null,
    };
  } catch {
    return { gloss: null, confidence: null, error: "unparseable event" };
  }
}

export default function CameraFeed({ onGesturesChange, canvasClassName, onRecognizedText }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handsRef = useRef(null);
  const requestRef = useRef(null);

  const [, setGestures] = useState("Starting camera...");

  // ---- Hybrid recognition: local classifier first, cloud fallback second ----
  // A ref (not state) because it's read inside the onResults closure set up
  // once below — using state here would require re-running the whole
  // camera/MediaPipe setup effect just to pick up this one flag.
  const cloudFallbackEnabledRef = useRef(false);
  const unrecognizedHoldStartRef = useRef(null);   // when an *unrecognized* pose started being held
  const noHandsTimerRef = useRef(null);            // pending "commit the sentence" timeout, see the no-hands branch below
  const cloudRequestInFlightRef = useRef(false);
  const lastCloudAttemptTimeRef = useRef(0);
  const lastCloudAttemptHoldRef = useRef(null);    // identity token for "this specific hold" so we only try once per hold

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/config`)
      .then((r) => (r.ok ? r.json() : { neuralseek_enabled: false }))
      .then((cfg) => {
        if (!cancelled) cloudFallbackEnabledRef.current = !!cfg.neuralseek_enabled;
      })
      .catch(() => {
        if (!cancelled) cloudFallbackEnabledRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Motion tracking state ----
  const prevLandmarksRef = useRef(null);      // [{x,y,z}[] per hand] from prior frame
  const stableRunRef = useRef(0);             // consecutive still frames
  const isCurrentlyStillRef = useRef(false);  // hysteresis state

  const lastRecognizedRef = useRef(null);   // last label we emitted, to avoid instant repeats
  const lastRecognizeTimeRef = useRef(0);
  const holdStartRef = useRef(null);        // timestamp when stillness began
  // Tracks whether the CURRENT continuous hold has already produced an
  // emission. Without this, a single held pose fires again every time the
  // cooldown window elapses (every ~900ms) for as long as the hand stays
  // still, flooding the transcript with duplicate entries of the same sign.
  const holdAlreadyEmittedRef = useRef(false);

  // Shared by both recognition paths so local and cloud results end up in
  // the transcript identically — this is the "normalized { gloss,
  // confidence } result" boundary: everything downstream of this function
  // doesn't know or care whether the label came from the local classifier
  // or NeuralSeek.
  //
  // IMPORTANT: this APPENDS to a running sentence buffer — it does not
  // commit a message. Signing "HELLO", then "GOOD", then "I LOVE YOU" in
  // sequence builds one buffer ("HELLO GOOD I LOVE YOU"), which only
  // becomes an actual transcript message when the hand pauses (see the
  // idle-commit logic in the "no hands" branch below) or the user taps
  // "Send" in the UI. This is what actually lets someone sign more than
  // one word before it turns into a message — an earlier version of this
  // function committed every single recognized sign as its own message
  // immediately, which is why sentences weren't possible before.
  const emitRecognition = (label, confidence, source) => {
    const isNewSign = label !== lastRecognizedRef.current;
    if (isNewSign || !holdAlreadyEmittedRef.current) {
      lastRecognizedRef.current = label;
      lastRecognizeTimeRef.current = performance.now();
      holdAlreadyEmittedRef.current = true;

      const confPct = confidence != null ? `${Math.round(confidence * 100)}%` : "?%";
      const tag = source === "cloud" ? " ☁️" : "";
      // Full detail (confidence, source) goes to the transient status line
      // and console — baking "(85%) ☁️" into every word of an actual
      // sentence would make it unreadable as a sentence. The status line
      // is just feedback about what was just recognized; the sentence
      // buffer stays clean words only.
      const statusMsg = `Recognized: ${label} (${confPct})${tag}`;
      setGestures(statusMsg);
      onGesturesChange?.(statusMsg);

      onRecognizedText?.((prev) => (prev ? prev + " " : "") + label);
      return true;
    }
    return false;
  };

  // Returns true if a static pose was recognized locally, false otherwise
  // (so the caller knows whether it's worth trying the cloud fallback).
  const recognizeLocally = (landmarks) => {
    const { label, confidence } = classifyHandShape(landmarks);

    if (!label) {
      return false;
    }

    emitRecognition(label, confidence, "local");
    return true;
  };

  // Captures the current video frame, sends it to /api/stream/frame-sse,
  // and emits whatever gloss NeuralSeek returns through the same
  // emitRecognition path local recognition uses. Only called when the
  // local classifier didn't recognize a held pose AND the backend has
  // confirmed NeuralSeek is actually configured (see the /api/config
  // fetch above) — so this never fires doomed requests against an
  // unconfigured backend.
  const recognizeViaCloud = async () => {
    if (cloudRequestInFlightRef.current) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    cloudRequestInFlightRef.current = true;
    try {
      const captureCanvas = document.createElement("canvas");
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
      const cctx = captureCanvas.getContext("2d");
      // Deliberately NOT mirrored here (unlike the preview canvas) — send
      // the raw camera frame, since mirroring is purely a display choice.
      cctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

      const blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/png"));
      if (!blob) return;

      const formData = new FormData();
      formData.append("frame", blob, "frame.png");
      formData.append("prior_hypothesis", lastRecognizedRef.current || "");

      const response = await fetch(`${API_BASE}/api/stream/frame-sse`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;

          const { gloss, confidence, error } = parseNeuralSeekEvent(dataLine.slice(5).trim());
          if (error) {
            console.warn("NeuralSeek fallback:", error);
            continue;
          }
          if (gloss) {
            emitRecognition(gloss, confidence, "cloud");
          }
        }
      }
    } catch (err) {
      console.warn("NeuralSeek fallback request failed:", err);
    } finally {
      cloudRequestInFlightRef.current = false;
    }
  };

  // ---- Compute normalized motion between frames ----
  function computeMotionMagnitude(landmarksPerHand, width, height) {
    // If no previous landmarks, seed and return high motion to avoid sending immediately
    if (!prevLandmarksRef.current) {
      prevLandmarksRef.current = landmarksPerHand?.map(hand => hand.map(p => ({ x: p.x, y: p.y, z: p.z ?? 0 }))) || null;
      return Infinity;
    }

    const prev = prevLandmarksRef.current;
    // Match by index (MediaPipe keeps consistent ordering for hands within a session reasonably well)
    const handCount = Math.min(prev.length, landmarksPerHand.length);
    if (handCount === 0) {
      prevLandmarksRef.current = null;
      return Infinity;
    }

    const diag = Math.hypot(width, height) || 1; // normalize to frame diagonal
    let accum = 0;
    let points = 0;

    for (let h = 0; h < handCount; h++) {
      const A = prev[h];
      const B = landmarksPerHand[h];
      const n = Math.min(A.length, B.length);
      for (let i = 0; i < n; i++) {
        const dx = (B[i].x - A[i].x) * width;
        const dy = (B[i].y - A[i].y) * height;
        const d = Math.hypot(dx, dy) / diag; // normalized 0..~1
        accum += d;
        points += 1;
      }
    }

    // Update previous for next round (copy by value)
    prevLandmarksRef.current = landmarksPerHand.map(hand => hand.map(p => ({ x: p.x, y: p.y, z: p.z ?? 0 })));

    return points ? (accum / points) : Infinity; // average normalized displacement per landmark
  }

  useEffect(() => {
    handsRef.current = new Hands({
      // Served from /public/mediapipe/hands (copied from the
      // @mediapipe/hands npm package) instead of the jsDelivr CDN. This
      // removes a runtime dependency on a third-party CDN being
      // reachable/unblocked wherever this app is deployed. If you'd rather
      // use the CDN (smaller repo, but requires cdn.jsdelivr.net to be
      // reachable), swap this back to
      // `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`.
      locateFile: (file) => `/mediapipe/hands/${file}`,
    });

    handsRef.current.setOptions({
      // Sign classification only ever looks at the first detected hand (see
      // recognizeLocally below), so we cap detection at one hand too.
      // Detecting a second hand without ever classifying it was misleading
      // (drew a tracked skeleton for it) and cost extra inference time for
      // no benefit. If you want real two-hand signs, both the tracking
      // limit AND gestureClassifier.js need to change together.
      maxNumHands: 1,
      // 0 = lite model. The full model (1) is meaningfully slower per
      // frame for landmark precision this app doesn't need — the
      // classifier only reasons about which fingers are extended and
      // rough joint angles, not sub-pixel accuracy. Combined with the
      // COOP/COEP headers in server/main.py (which let the browser use
      // MediaPipe's fast multi-threaded WASM path instead of silently
      // falling back to single-threaded), this is the main fix for
      // "the camera hangs" on real deployments.
      modelComplexity: 0,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.5,
    });

    handsRef.current.onResults((results) => {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      const video = videoRef.current;
      if (!video) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      ctx.save();
      ctx.scale(-1, 1);
      ctx.translate(-canvas.width, 0);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

      if (results.multiHandLandmarks?.length > 0) {
        // A hand is visible again: cancel any pending "commit the sentence"
        // timer (see the no-hands branch below). Brief pauses between
        // signs (repositioning the hand, blinking, etc.) shouldn't end the
        // sentence — only an actual sustained pause should.
        if (noHandsTimerRef.current != null) {
          clearTimeout(noHandsTimerRef.current);
          noHandsTimerRef.current = null;
        }

        results.multiHandLandmarks.forEach((lm, idx) => {
          drawConnectors(ctx, lm, HAND_CONNECTIONS, { color: "#00FF88", lineWidth: 4 });
          drawLandmarks(ctx, lm, { color: "#FF3355", lineWidth: 2 });

          if (results.multiHandedness && results.multiHandedness[idx]) {
            const confidence = results.multiHandedness[idx].score;
            const xs = lm.map(p => p.x * canvas.width);
            const ys = lm.map(p => p.y * canvas.height);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);

            ctx.strokeStyle = "yellow";
            ctx.lineWidth = 2;
            ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

            const barWidth = (maxX - minX) * confidence;
            const barHeight = 6;

            ctx.fillStyle = "rgba(0,0,0,0.5)";
            ctx.fillRect(minX, minY - barHeight - 2, maxX - minX, barHeight);

            ctx.fillStyle = "yellow";
            ctx.fillRect(minX, minY - barHeight - 2, barWidth, barHeight);

            const visualLeft = canvas.width - maxX;
            const textX = visualLeft + 4;
            const textY = minY - barHeight - 6;
            const text = `${(confidence * 100).toFixed(1)}%`;

            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = "white";
            ctx.font = "12px Arial";
            ctx.fillText(text, textX, textY);
            ctx.restore();
          }
        });

        const msg = `Detected Hands: ${results.multiHandLandmarks.length}`;
        setGestures(msg);
        onGesturesChange?.(msg);

        // ---- Motion gating logic ----
        const motion = computeMotionMagnitude(
          results.multiHandLandmarks,
          canvas.width,
          canvas.height
        );

        // Hysteresis: once still, allow a bit more motion before flipping back to "moving"
        if (isCurrentlyStillRef.current) {
          if (motion > MOTION_MOVE_THRESH) {
            isCurrentlyStillRef.current = false;
            stableRunRef.current = 0;
            holdAlreadyEmittedRef.current = false; // hand moved: next hold can emit again
            unrecognizedHoldStartRef.current = null;
            lastCloudAttemptHoldRef.current = null;
          } else {
            // still remains still
            stableRunRef.current = Math.min(STABLE_FRAMES_REQUIRED, stableRunRef.current + 1);
          }
        } else {
          if (motion <= MOTION_STILL_THRESH) {
            // candidate still
            stableRunRef.current += 1;
            if (stableRunRef.current >= STABLE_FRAMES_REQUIRED) {
              isCurrentlyStillRef.current = true;
            }
          } else {
            stableRunRef.current = 0;
          }
        }

        // Only recognize once the pose has been held still long enough
        const now = performance.now();
        if (isCurrentlyStillRef.current) {
          if (holdStartRef.current == null) holdStartRef.current = now;
          const heldFor = now - holdStartRef.current;
          if (heldFor >= HOLD_MS_BEFORE_RECOGNIZE) {
            const recognized = recognizeLocally(results.multiHandLandmarks[0]);

            // Hybrid fallback: the local classifier only knows a small,
            // fixed vocabulary (see gestureClassifier.js). If it can't
            // name this held pose, and the backend has confirmed
            // NeuralSeek is actually configured, ask it — after giving
            // the pose a bit longer to settle (CLOUD_FALLBACK_HOLD_MS) so
            // we're not uploading a frame for every fleeting unknown
            // shape, and with a cooldown so a single unrecognized hold
            // doesn't spam requests.
            if (!recognized && cloudFallbackEnabledRef.current) {
              if (unrecognizedHoldStartRef.current == null) {
                unrecognizedHoldStartRef.current = now;
              }
              const unrecognizedHeldFor = now - unrecognizedHoldStartRef.current;
              const cooledDown =
                now - lastCloudAttemptTimeRef.current > CLOUD_FALLBACK_COOLDOWN_MS;
              const alreadyTriedThisHold =
                lastCloudAttemptHoldRef.current === unrecognizedHoldStartRef.current;

              if (
                unrecognizedHeldFor >= CLOUD_FALLBACK_HOLD_MS &&
                (cooledDown || !alreadyTriedThisHold)
              ) {
                lastCloudAttemptTimeRef.current = now;
                lastCloudAttemptHoldRef.current = unrecognizedHoldStartRef.current;
                recognizeViaCloud();
              }
            } else if (recognized) {
              unrecognizedHoldStartRef.current = null;
            }
          }
        } else {
          holdStartRef.current = null;
        }

      } else {
        // No hands
        prevLandmarksRef.current = null;     // reset motion baseline
        stableRunRef.current = 0;
        isCurrentlyStillRef.current = false;
        holdStartRef.current = null;
        lastRecognizedRef.current = null;    // allow the same sign to be recognized again next time
        holdAlreadyEmittedRef.current = false;
        unrecognizedHoldStartRef.current = null;
        lastCloudAttemptHoldRef.current = null;

        // Treat a sustained pause (hand out of frame for
        // SENTENCE_COMMIT_IDLE_MS) as "done signing this sentence" and
        // commit whatever's in the buffer as one transcript message. Only
        // start the timer once per pause (don't restart it every single
        // frame the hand stays away) — it's cancelled above the moment a
        // hand reappears.
        if (noHandsTimerRef.current == null) {
          noHandsTimerRef.current = setTimeout(() => {
            onRecognizedText?.(""); // App.jsx: commits the buffered sentence, then clears it
            noHandsTimerRef.current = null;
          }, SENTENCE_COMMIT_IDLE_MS);
        }

        const msg = "No hands detected";
        setGestures(msg);
        onGesturesChange?.(msg);
      }

      ctx.restore();
    });

    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        // getUserMedia is only available in secure contexts (https://, or
        // localhost). On a plain http:// deployment the browser will not
        // even expose the API, which otherwise looks like a silent failure.
        const msg = window.isSecureContext
          ? "Camera API not available in this browser"
          : "Camera requires HTTPS (or localhost) — this page is loaded over an insecure connection";
        console.error(msg);
        setGestures(msg);
        onGesturesChange?.(msg);
        return;
      }
      try {
        // Unconstrained getUserMedia can hand back very high resolutions
        // (1080p+) on many webcams/phones, multiplying MediaPipe's
        // per-frame inference cost for no benefit — hand-shape
        // classification doesn't need more than a few hundred pixels.
        // `ideal` (not `min`/`exact`) lets the browser pick the closest
        // supported mode instead of failing outright on cameras that
        // don't offer exactly this resolution.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24, max: 30 },
          },
          audio: false,
        });
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play();
          let consecutiveFailures = 0;

          const loop = async () => {
            try {
              await handsRef.current.send({ image: videoRef.current });
              consecutiveFailures = 0;
            } catch (err) {
              // CRITICAL: without this catch, a single failed inference
              // call (a transient WASM error, a frame grabbed a tick
              // before the video was actually ready, etc.) throws inside
              // this async function, which means the line below —
              // requestAnimationFrame(loop) — never runs, and the loop
              // simply stops. Because the visible feed IS this canvas
              // (the raw <video> element is hidden — see the JSX below),
              // that means the ENTIRE picture freezes on whatever frame
              // was last drawn, with no error shown to the user. That is
              // exactly what "the camera hangs" looks like from outside,
              // and it only takes one bad frame to trigger it.
              consecutiveFailures += 1;
              console.warn(
                `MediaPipe frame processing error (recovered, ${consecutiveFailures} in a row):`,
                err
              );
              if (consecutiveFailures === 5) {
                const msg = "Recognition is having trouble — still trying in the background";
                setGestures(msg);
                onGesturesChange?.(msg);
              }
            }
            requestRef.current = requestAnimationFrame(loop);
          };
          requestRef.current = requestAnimationFrame(loop);
        };
      } catch (err) {
        console.error("Camera error:", err);
        const msg = "Camera access denied";
        setGestures(msg);
        onGesturesChange?.(msg);
      }
    })();

    return () => {
      cancelAnimationFrame(requestRef.current);
      videoRef.current?.srcObject?.getTracks().forEach((t) => t.stop());
      if (noHandsTimerRef.current != null) clearTimeout(noHandsTimerRef.current);
    };
  }, [onGesturesChange, onRecognizedText]);

  return (
    <div>
      <video ref={videoRef} autoPlay playsInline muted style={{ display: "none" }} />
      <canvas
        ref={canvasRef}
        className={canvasClassName}
        style={{
          width: "640px",
          borderRadius: "12px",
          backgroundColor: "#1e1e1e",
          boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
        }}
      />
    </div>
  );
}
