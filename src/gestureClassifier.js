// Rule-based static ASL sign classifier.
// Works entirely client-side on MediaPipe hand landmarks — no API, no cost.
//
// Landmark index reference (MediaPipe Hands):
//   0  wrist
//   1-4   thumb   (CMC, MCP, IP, TIP)
//   5-8   index   (MCP, PIP, DIP, TIP)
//   9-12  middle  (MCP, PIP, DIP, TIP)
//   13-16 ring    (MCP, PIP, DIP, TIP)
//   17-20 pinky   (MCP, PIP, DIP, TIP)
//
// NOTE: This only recognizes STATIC hand shapes (a held pose), not motion-based
// signs (like J or Z, which require tracing a path). It's a small fixed
// vocabulary, not full ASL — see the accompanying docs for scope/limitations.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

// Returns true if a finger is "extended" (straightened away from the palm)
// by comparing how far the tip sits from the wrist vs. the middle joint (PIP).
// This is orientation-tolerant enough for a hand held up toward the camera.
function isExtended(landmarks, mcpIdx, pipIdx, tipIdx, wristIdx = 0, margin = 1.05) {
  const wrist = landmarks[wristIdx];
  const pip = landmarks[pipIdx];
  const tip = landmarks[tipIdx];
  return dist(wrist, tip) > dist(wrist, pip) * margin;
}

function getFingerState(landmarks) {
  return {
    thumb: isExtended(landmarks, 2, 3, 4, 0, 1.03),
    index: isExtended(landmarks, 5, 6, 8, 0, 1.05),
    middle: isExtended(landmarks, 9, 10, 12, 0, 1.05),
    ring: isExtended(landmarks, 13, 14, 16, 0, 1.05),
    pinky: isExtended(landmarks, 17, 18, 20, 0, 1.05),
  };
}

// Angle (degrees) between two vectors, used to tell U (fingers together)
// from V (fingers spread) apart when both index+middle are extended.
function angleBetween(v1, v2) {
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return 0;
  const cos = Math.min(1, Math.max(-1, dot / (mag1 * mag2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// Ordered rules — first match wins. Each rule checks a finger-state pattern
// (true = extended, false = curled) and any extra geometric checks it needs.
export function classifyHandShape(landmarks) {
  if (!landmarks || landmarks.length < 21) {
    return { label: null, confidence: 0 };
  }

  const f = getFingerState(landmarks);
  const extendedCount = Object.values(f).filter(Boolean).length;

  // Index/middle spread angle, used for U vs V
  const indexVec = {
    x: landmarks[8].x - landmarks[5].x,
    y: landmarks[8].y - landmarks[5].y,
  };
  const middleVec = {
    x: landmarks[12].x - landmarks[9].x,
    y: landmarks[12].y - landmarks[9].y,
  };
  const spreadAngle = angleBetween(indexVec, middleVec);

  // Hand-size reference (wrist to middle-finger knuckle), used to turn
  // absolute pixel-ish distances into something scale-independent — a
  // hand close to the camera and one far away should both register the
  // same "pinch" the same way.
  const handScale = dist(landmarks[0], landmarks[9]) || 1;
  const thumbIndexPinchDist = dist(landmarks[4], landmarks[8]) / handScale;

  // --- HELLO / open palm: all five fingers extended ---
  if (f.thumb && f.index && f.middle && f.ring && f.pinky) {
    return { label: "HELLO", confidence: 0.85 };
  }

  // --- F: thumb and index tip pinched together, other three extended.
  // This is a deliberate distance check (not just the extended/curled
  // booleans above) because a pinched index finger doesn't reliably read
  // as "curled" by the wrist-to-tip heuristic — checking the actual
  // tip-to-tip distance is the honest way to detect this shape. ---
  if (f.middle && f.ring && f.pinky && thumbIndexPinchDist < 0.4) {
    return { label: "F", confidence: 0.75 };
  }

  // --- FIST / A: everything curled ---
  if (!f.thumb && !f.index && !f.middle && !f.ring && !f.pinky) {
    return { label: "A", confidence: 0.8 };
  }

  // --- I LOVE YOU: thumb + index + pinky extended, middle + ring curled ---
  if (f.thumb && f.index && !f.middle && !f.ring && f.pinky) {
    return { label: "I LOVE YOU", confidence: 0.9 };
  }

  // --- Y: thumb + pinky extended only ("hang loose") ---
  if (f.thumb && !f.index && !f.middle && !f.ring && f.pinky) {
    return { label: "Y", confidence: 0.85 };
  }

  // --- L: thumb + index extended only, forming an L ---
  if (f.thumb && f.index && !f.middle && !f.ring && !f.pinky) {
    return { label: "L", confidence: 0.85 };
  }

  // --- THREE (ASL number 3): thumb + index + middle extended, ring/pinky curled ---
  if (f.thumb && f.index && f.middle && !f.ring && !f.pinky) {
    return { label: "THREE", confidence: 0.75 };
  }

  // --- W: index + middle + ring extended, thumb + pinky curled ---
  if (!f.thumb && f.index && f.middle && f.ring && !f.pinky) {
    return { label: "W", confidence: 0.8 };
  }

  // --- U vs V: index + middle extended only, thumb/ring/pinky curled ---
  if (!f.thumb && f.index && f.middle && !f.ring && !f.pinky) {
    if (spreadAngle > 22) {
      return { label: "V", confidence: 0.8 };
    }
    return { label: "U", confidence: 0.75 };
  }

  // --- D: index extended only ---
  if (!f.thumb && f.index && !f.middle && !f.ring && !f.pinky) {
    return { label: "D", confidence: 0.75 };
  }

  // --- I: pinky extended only ---
  if (!f.thumb && !f.index && !f.middle && !f.ring && f.pinky) {
    return { label: "I", confidence: 0.8 };
  }

  // --- B: four fingers extended, thumb curled across palm ---
  if (!f.thumb && f.index && f.middle && f.ring && f.pinky) {
    return { label: "B", confidence: 0.8 };
  }

  // --- Thumb only extended: distinguish up vs down by comparing the
  // thumb tip's vertical position to the wrist. This uses MediaPipe's raw
  // landmark coordinates (normalized image space, y grows downward),
  // which are unaffected by the canvas mirroring Camera.jsx applies only
  // for on-screen display — so this check is accurate regardless of how
  // the preview is drawn. It's a reasonable approximation, not a
  // wrist-rotation-aware 3D check, so an unusually tilted hand can still
  // fool it. ---
  if (f.thumb && !f.index && !f.middle && !f.ring && !f.pinky) {
    const thumbUp = landmarks[4].y < landmarks[0].y;
    return thumbUp
      ? { label: "GOOD (👍)", confidence: 0.7 }
      : { label: "BAD (👎)", confidence: 0.65 };
  }

  return { label: null, confidence: 0, extendedCount };
}

// Supported vocabulary, exported for display / docs purposes.
export const SUPPORTED_SIGNS = [
  "A", "B", "D", "F", "I", "L", "U", "V", "W", "Y",
  "HELLO", "I LOVE YOU", "THREE", "GOOD (👍)", "BAD (👎)",
];
