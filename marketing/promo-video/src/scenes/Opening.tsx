import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Logo } from "../components/Logo";
import { color, font, progress, useLayout } from "../theme";

// Frame 0 matches the Outro's last frame, so the loop seam is invisible.
export const LOGO_SIZE = 300;

export const Opening: React.FC = () => {
  const frame = useCurrentFrame();
  const { u, portrait } = useLayout();
  const lift = progress(frame, 8, 30);
  const wake = progress(frame, 14, 28);
  const never = progress(frame, 28, 42);
  const pulse = interpolate(Math.sin(frame / 6), [-1, 1], [0, 1]);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          translate: `0px ${-lift * (portrait ? 190 : 150) * u}px`,
          scale: interpolate(lift, [0, 1], [1, 0.72]),
        }}
      >
        <Logo size={LOGO_SIZE * u} draw={1} glow={pulse * lift} />
      </div>
      <div
        style={{
          position: "absolute",
          top: "50%",
          translate: `0px ${(portrait ? 20 : 0) * u}px`,
          textAlign: "center",
          fontFamily: font.sans,
          letterSpacing: "-0.035em",
          lineHeight: 1,
        }}
      >
        <div
          style={{
            fontWeight: 800,
            fontSize: 170 * u,
            color: color.accent,
            opacity: wake,
            scale: interpolate(wake, [0, 1], [1.35, 1]),
            filter: `blur(${(1 - wake) * 14}px)`,
          }}
        >
          Wake
        </div>
        <div
          style={{
            fontWeight: 700,
            fontSize: 104 * u,
            color: color.ink,
            marginTop: 10 * u,
            opacity: never,
            translate: `0px ${interpolate(never, [0, 1], [50 * u, 0])}px`,
            clipPath: `inset(0 0 ${(1 - never) * 100}% 0)`,
          }}
        >
          never sleeps.
        </div>
      </div>
    </AbsoluteFill>
  );
};
