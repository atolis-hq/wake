import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { color, font, progress, useLayout } from "../theme";

/** Scene headline: a mono kicker plus a large line that can swap mid-scene. */
export const Headline: React.FC<{
  readonly kicker: string | readonly { readonly from: number; readonly text: string }[];
  readonly lines: readonly { readonly from: number; readonly text: string }[];
}> = ({ kicker, lines }) => {
  const frame = useCurrentFrame();
  const { u, portrait } = useLayout();
  const kickers = typeof kicker === "string" ? [{ from: 0, text: kicker }] : kicker;
  const current = [...kickers].reverse().find((k) => frame >= k.from) ?? kickers[0]!;
  const kickerIn = progress(frame, current.from, current.from + 14);

  return (
    <div
      style={{
        position: "absolute",
        left: (portrait ? 80 : 120) * u,
        right: (portrait ? 80 : 120) * u,
        top: (portrait ? 96 : 80) * u,
      }}
    >
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 26 * u,
          letterSpacing: "0.18em",
          color: color.accent,
          opacity: kickerIn,
          translate: `${interpolate(kickerIn, [0, 1], [-20 * u, 0])}px 0px`,
          marginBottom: 18 * u,
        }}
      >
        {current.text}
      </div>
      <div style={{ position: "relative", height: (portrait ? 140 : 80) * u }}>
        {lines.map((line, i) => {
          const next = lines[i + 1];
          const enter = progress(frame, line.from, line.from + 16);
          const exit =
            next === undefined ? 0 : progress(frame, next.from, next.from + 10);
          return (
            <div
              key={line.text}
              style={{
                position: "absolute",
                inset: 0,
                fontFamily: font.sans,
                fontWeight: 700,
                fontSize: (portrait ? 64 : 72) * u,
                lineHeight: 1.08,
                letterSpacing: "-0.02em",
                color: color.ink,
                textWrap: "balance",
                opacity: enter * (1 - exit),
                translate: `0px ${interpolate(enter, [0, 1], [36 * u, 0]) - exit * 30 * u}px`,
                filter: `blur(${(1 - enter) * 10 + exit * 8}px)`,
              }}
            >
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const CheckIcon: React.FC<{
  readonly size: number;
  readonly draw?: number;
}> = ({ size, draw = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path
      d="M5 12.5l4.5 4.5L19 7.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - draw}
    />
  </svg>
);

export const QuestionIcon: React.FC<{ readonly size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <circle
      cx="12"
      cy="12"
      r="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M9.2 9.3a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <circle cx="12" cy="17.6" r="1.2" fill="currentColor" />
  </svg>
);

/** Card surface shared by issue threads, the runner pool, and the app window. */
export const Panel: React.FC<{
  readonly children: React.ReactNode;
  readonly style?: React.CSSProperties;
}> = ({ children, style }) => {
  const { u } = useLayout();
  return (
    <div
      style={{
        background: color.panel,
        border: `${1.5 * u}px solid ${color.border}`,
        borderRadius: 22 * u,
        boxShadow: `0 ${30 * u}px ${80 * u}px rgb(0 0 0 / 0.45)`,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
};
