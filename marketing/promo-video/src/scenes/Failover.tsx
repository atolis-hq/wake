import React from "react";
import {
  AbsoluteFill,
  interpolate,
  interpolateColors,
  useCurrentFrame,
} from "remotion";
import { Headline, Panel } from "../components/ui";
import { color, easeInOut, font, progress, useLayout } from "../theme";

const LIMIT_AT = 72;
const SWITCH_AT = 96;

const runners = ["codex", "claude", "cursor"] as const;

type Line = {
  readonly at: number;
  readonly text: string;
  readonly tone?: string;
};

const codexLines: readonly Line[] = [
  { at: 30, text: "$ codex exec  ·  implement #433", tone: color.accentLight },
  { at: 40, text: "  reading src/runs/history.ts" },
  { at: 50, text: "  planning cursor pagination" },
  { at: 60, text: "  writing src/runs/page.ts" },
  {
    at: LIMIT_AT,
    text: "error: usage limit reached · try again at 3:00 PM",
    tone: color.bad,
  },
];

const claudeLines: readonly Line[] = [
  {
    at: SWITCH_AT + 6,
    text: "$ claude -p  ·  implement #433",
    tone: color.accentLight,
  },
  { at: SWITCH_AT + 14, text: "  same activation, next runner" },
  { at: SWITCH_AT + 24, text: "  writing src/runs/page.ts" },
  { at: SWITCH_AT + 34, text: "  adding test/runs/page.test.ts" },
  { at: SWITCH_AT + 46, text: "  npm test · 42 passed", tone: color.good },
];

export const Failover: React.FC = () => {
  const frame = useCurrentFrame();
  const { u, portrait, width } = useLayout();

  const pool = portrait
    ? { x: 80 * u, y: 340 * u, w: width - 160 * u }
    : { x: 120 * u, y: 290 * u, w: 760 * u };
  const term = portrait
    ? { x: 80 * u, y: 800 * u, w: width - 160 * u, h: 400 * u }
    : { x: 940 * u, y: 290 * u, w: width - 1060 * u, h: 430 * u };
  const headerH = 84 * u;
  const rowH = 112 * u;

  const selectorIn = progress(frame, 20, 32);
  const selectorRow = interpolate(
    progress(frame, SWITCH_AT, SWITCH_AT + 18, easeInOut),
    [0, 1],
    [0, 1],
  );
  const flash = interpolate(
    frame,
    [LIMIT_AT, LIMIT_AT + 4, LIMIT_AT + 16],
    [0, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  const status = (i: number) => {
    if (i === 0) {
      if (frame >= LIMIT_AT + 8)
        return { text: "paused · resumes 15:00", tint: color.muted };
      if (frame >= 30) return { text: "running", tint: color.active };
    }
    if (i === 1 && frame >= SWITCH_AT + 12)
      return { text: "running", tint: color.active };
    return { text: "ready", tint: color.good };
  };

  const lines = frame < SWITCH_AT + 4 ? codexLines : claudeLines;
  const termSwap = progress(frame, SWITCH_AT - 4, SWITCH_AT + 4);

  return (
    <AbsoluteFill>
      <Headline
        kicker="05 · RUNNERS"
        lines={[
          { from: 0, text: "Hit a usage limit?" },
          { from: LIMIT_AT + 14, text: "Wake fails over to the next CLI." },
        ]}
      />

      <Panel
        style={{
          position: "absolute",
          left: pool.x,
          top: pool.y,
          width: pool.w,
          opacity: progress(frame, 0, 16),
          translate: `0px ${interpolate(progress(frame, 0, 16), [0, 1], [40 * u, 0])}px`,
        }}
      >
        <div
          style={{
            height: headerH,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: `0 ${30 * u}px`,
            borderBottom: `${1.5 * u}px solid ${color.border}`,
            fontFamily: font.mono,
            fontSize: 26 * u,
          }}
        >
          <span style={{ color: color.ink }}>
            runnerPool: <span style={{ color: color.accent }}>standard</span>
          </span>
          <span style={{ color: color.muted, fontSize: 20 * u }}>ordered</span>
        </div>
        <div style={{ position: "relative" }}>
          <div
            style={{
              position: "absolute",
              left: 12 * u,
              right: 12 * u,
              height: rowH - 16 * u,
              top: 8 * u + selectorRow * rowH,
              borderRadius: 14 * u,
              border: `${2.5 * u}px solid ${color.accent}`,
              background: "rgb(45 212 191 / 0.07)",
              opacity: selectorIn,
              boxShadow: `0 0 ${40 * u}px rgb(45 212 191 / 0.25)`,
            }}
          />
          {runners.map((name, i) => {
            const s = status(i);
            const benched = i === 0 && frame >= LIMIT_AT + 8;
            return (
              <div
                key={name}
                style={{
                  position: "relative",
                  height: rowH,
                  display: "flex",
                  alignItems: "center",
                  gap: 24 * u,
                  padding: `0 ${36 * u}px`,
                  background:
                    i === 0 ? `rgb(255 138 138 / ${flash * 0.25})` : undefined,
                  opacity: benched ? 0.55 : 1,
                }}
              >
                <span
                  style={{
                    fontFamily: font.mono,
                    fontSize: 24 * u,
                    color: color.muted,
                  }}
                >
                  {i + 1}
                </span>
                <div
                  style={{
                    width: 56 * u,
                    height: 56 * u,
                    borderRadius: 14 * u,
                    background: color.card,
                    display: "grid",
                    placeItems: "center",
                    fontFamily: font.mono,
                    fontWeight: 500,
                    fontSize: 28 * u,
                    color: color.ink,
                  }}
                >
                  ›_
                </div>
                <span
                  style={{
                    flex: 1,
                    fontFamily: font.sans,
                    fontWeight: 600,
                    fontSize: 34 * u,
                    color: color.ink,
                    textDecoration: benched ? "line-through" : undefined,
                    textDecorationThickness: 2 * u,
                  }}
                >
                  {name}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 10 * u,
                    fontFamily: font.mono,
                    fontSize: 21 * u,
                    color: s.tint,
                    padding: `${6 * u}px ${14 * u}px`,
                    borderRadius: 999,
                    border: `${1.5 * u}px solid ${s.tint}`,
                  }}
                >
                  <span
                    style={{
                      width: 10 * u,
                      height: 10 * u,
                      borderRadius: "50%",
                      background: s.tint,
                      opacity:
                        s.text === "running"
                          ? interpolate(Math.sin(frame / 3), [-1, 1], [0.35, 1])
                          : 1,
                    }}
                  />
                  {s.text}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel
        style={{
          position: "absolute",
          left: term.x,
          top: term.y,
          width: term.w,
          height: term.h,
          background: "#0e1013",
          opacity: progress(frame, 8, 24),
          borderColor: interpolateColors(
            flash,
            [0, 1],
            [color.border, color.bad],
          ),
        }}
      >
        <div
          style={{
            height: 56 * u,
            display: "flex",
            alignItems: "center",
            gap: 10 * u,
            padding: `0 ${22 * u}px`,
            borderBottom: `${1.5 * u}px solid ${color.border}`,
            fontFamily: font.mono,
            fontSize: 20 * u,
            color: color.muted,
          }}
        >
          {[0, 1, 2].map((d) => (
            <span
              key={d}
              style={{
                width: 14 * u,
                height: 14 * u,
                borderRadius: "50%",
                background: color.inset,
              }}
            />
          ))}
          <span style={{ marginLeft: 12 * u }}>
            sandbox · workspaces/wi-433 ·{" "}
            {frame < SWITCH_AT + 4 ? "codex" : "claude"}
          </span>
        </div>
        <div
          style={{
            padding: `${20 * u}px ${26 * u}px`,
            fontFamily: font.mono,
            fontSize: (portrait ? 23 : 24) * u,
            lineHeight: 1.7,
            opacity: frame < SWITCH_AT + 4 ? 1 - termSwap : 1,
          }}
        >
          {lines.map((l) => {
            const chars = Math.floor(
              interpolate(frame, [l.at, l.at + 8], [0, l.text.length], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            );
            if (frame < l.at) return null;
            return (
              <div
                key={l.text}
                style={{ color: l.tone ?? color.ink, whiteSpace: "pre" }}
              >
                {l.text.slice(0, chars)}
              </div>
            );
          })}
        </div>
      </Panel>
    </AbsoluteFill>
  );
};
