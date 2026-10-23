import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import { Logo } from "../components/Logo";
import { color, easeInOut, progress, useLayout } from "../theme";
import { LOGO_SIZE } from "./Opening";

const PARTICLES = 28;

// Ends on exactly the Opening's first frame so the video loops seamlessly.
export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { u, width, height } = useLayout();
  const draw = progress(frame, 14, 58, easeInOut);
  const ring = progress(frame, 18, 40);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {Array.from({ length: PARTICLES }, (_, i) => {
        const angle = random(`a${i}`) * Math.PI * 2;
        const dist = Math.hypot(width, height) * (0.35 + random(`d${i}`) * 0.3);
        const start = random(`s${i}`) * 8;
        const t = progress(frame, start, start + 20, easeInOut);
        const r = dist * (1 - t);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: width / 2 + Math.cos(angle) * r - 6 * u,
              top: height / 2 + Math.sin(angle) * r - 6 * u,
              width: 12 * u,
              height: 12 * u,
              borderRadius: "50%",
              background: i % 3 === 0 ? color.accentLight : color.accent,
              opacity: interpolate(t, [0, 0.1, 0.9, 1], [0, 1, 1, 0]),
              boxShadow: `0 0 ${16 * u}px rgb(45 212 191 / 0.6)`,
            }}
          />
        );
      })}
      <div
        style={{
          position: "absolute",
          width: LOGO_SIZE * u,
          height: LOGO_SIZE * u,
          borderRadius: "50%",
          border: `${3 * u}px solid ${color.accent}`,
          scale: interpolate(ring, [0, 1], [0.4, 2.2]),
          opacity: interpolate(ring, [0, 0.2, 1], [0, 0.6, 0]),
        }}
      />
      <Logo size={LOGO_SIZE * u} draw={draw} />
    </AbsoluteFill>
  );
};
