import React from "react";
import { AbsoluteFill, interpolate, interpolateColors, useCurrentFrame } from "remotion";
import { Logo } from "../components/Logo";
import { Headline, Panel } from "../components/ui";
import { color, easeInOut, font, gh, progress, useLayout } from "../theme";

// One issue at a time: it shows, its matching selector lights, then it morphs into
// a chip and drops into that workflow's queue.
type Item = {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly lane: 0 | 1;
  /** Frame the card appears. */
  readonly at: number;
  /** Quick follow-up items skip the card and arrive as chips. */
  readonly chipOnly?: boolean;
};

const items: readonly Item[] = [
  { id: "#418", title: "Export audit log as CSV", tag: "dark-factory", lane: 0, at: 4 },
  { id: "#421", title: "Rate-limit the public API", tag: "issue", lane: 1, at: 58 },
  { id: "#424", title: "", tag: "", lane: 0, at: 100, chipOnly: true },
  { id: "#427", title: "", tag: "", lane: 1, at: 106, chipOnly: true },
  { id: "#430", title: "", tag: "", lane: 0, at: 112, chipOnly: true },
];

// Card timing relative to its `at`.
const SHOW = 14;
const MATCH = 20;
const FLY = 34;
const LAND = 54;

const lanes = [
  {
    name: "dark-factory",
    match: "tags: [dark-factory]",
    steps: [
      { name: "refine" },
      { name: "plan review", review: true },
      { name: "implement" },
      { name: "PR review", review: true },
      { name: "merge" },
    ],
  },
  {
    name: "default",
    match: "kind: issue",
    steps: [{ name: "refine" }, { name: "implement" }, { name: "complete" }],
  },
] as const;

export const Signals: React.FC = () => {
  const frame = useCurrentFrame();
  const { u, portrait, width, height } = useLayout();

  const source = portrait
    ? { x: 160 * u, y: 330 * u, w: width - 320 * u, h: 150 * u }
    : { x: 120 * u, y: 470 * u, w: 620 * u, h: 150 * u };
  const hub = portrait
    ? { x: 80 * u, y: 540 * u, w: width - 160 * u, h: height - 640 * u }
    : { x: 840 * u, y: 280 * u, w: width - 960 * u, h: 690 * u };
  const headerH = 70 * u;
  const laneH = (hub.h - headerH) / 2;
  const queueW = (portrait ? 250 : 270) * u;
  const chipW = 86 * u;
  const chipH = 40 * u;
  const railY = (lane: number) => hub.y + headerH + lane * laneH + laneH * 0.58;
  const railX0 = hub.x + queueW;
  const railX1 = hub.x + hub.w - 50 * u;
  const nodeX = (lane: number, i: number) =>
    railX0 + (i * (railX1 - railX0)) / (lanes[lane]!.steps.length - 1);

  // First item in a lane sits on the entry node; later ones queue behind it.
  const slotOf = (item: Item) => items.filter((o) => o.lane === item.lane && o.at < item.at).length;
  const chipTarget = (item: Item) => {
    const slot = slotOf(item);
    const x = slot === 0 ? nodeX(item.lane, 0) - chipW / 2 : railX0 - 40 * u - slot * (chipW + 12 * u);
    return { x, y: railY(item.lane) - chipH / 2 };
  };

  const matchGlow = (lane: number) =>
    Math.max(
      0,
      ...items
        .filter((i) => i.lane === lane && !i.chipOnly)
        .map((i) =>
          interpolate(frame, [i.at + MATCH, i.at + MATCH + 6, i.at + LAND + 6], [0, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        ),
    );
  const trigger = (at: number) =>
    interpolate(frame, [at, at + 5, at + 24], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const webhook = trigger(108);
  const schedule = trigger(118);
  const hubIn = progress(frame, 0, 14);

  return (
    <AbsoluteFill>
      <Headline kicker="02 · ROUTING" lines={[{ from: 0, text: "Every item finds its workflow." }]} />

      <Panel
        style={{
          position: "absolute",
          left: hub.x,
          top: hub.y,
          width: hub.w,
          height: hub.h,
          opacity: hubIn,
        }}
      >
        <div
          style={{
            height: headerH,
            display: "flex",
            alignItems: "center",
            gap: 12 * u,
            padding: `0 ${26 * u}px`,
            borderBottom: `${1.5 * u}px solid ${color.border}`,
            fontFamily: font.sans,
            fontWeight: 700,
            fontSize: 24 * u,
            color: color.ink,
          }}
        >
          <Logo size={34 * u} draw={1} glow={Math.max(webhook, schedule)} />
          Wake
          <span style={{ fontFamily: font.mono, fontWeight: 400, fontSize: 19 * u, color: color.muted }}>
            workflows
          </span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 10 * u }}>
            <Trigger label="webhook" pulse={webhook} icon="webhook" />
            <Trigger label="schedule" pulse={schedule} icon="schedule" />
          </span>
        </div>
      </Panel>

      {lanes.map((lane, li) => {
        const glow = matchGlow(li);
        const top = hub.y + headerH + li * laneH;
        return (
          <React.Fragment key={lane.name}>
            {li === 1 ? (
              <div
                style={{
                  position: "absolute",
                  left: hub.x,
                  width: hub.w,
                  top,
                  height: 1.5 * u,
                  background: color.border,
                  opacity: hubIn,
                }}
              />
            ) : null}
            <div
              style={{
                position: "absolute",
                left: hub.x + 26 * u,
                top: top + laneH * 0.14,
                display: "flex",
                alignItems: "center",
                gap: 14 * u,
                opacity: hubIn,
              }}
            >
              <span style={{ fontFamily: font.mono, fontSize: 28 * u, color: color.accent }}>{lane.name}</span>
              <span
                style={{
                  fontFamily: font.mono,
                  fontSize: 18 * u,
                  padding: `${4 * u}px ${12 * u}px`,
                  borderRadius: 8 * u,
                  color: interpolateColors(glow, [0, 1], [color.muted, color.surface]),
                  background: `rgb(94 234 212 / ${glow})`,
                  boxShadow: `0 0 ${30 * u * glow}px rgb(94 234 212 / ${0.6 * glow})`,
                }}
              >
                match {lane.match}
              </span>
            </div>
            <div
              style={{
                position: "absolute",
                left: hub.x + 26 * u,
                top: railY(li) + 30 * u,
                fontFamily: font.mono,
                fontSize: 15 * u,
                letterSpacing: "0.14em",
                color: color.muted,
                opacity: hubIn * 0.8,
              }}
            >
              QUEUE
            </div>
            <div
              style={{
                position: "absolute",
                left: railX0,
                width: railX1 - railX0,
                top: railY(li) - 1 * u,
                height: 2 * u,
                background: color.border,
                opacity: hubIn,
              }}
            />
            {lane.steps.map((s, si) => {
              const review = "review" in s;
              return (
                <React.Fragment key={s.name}>
                  <div
                    style={{
                      position: "absolute",
                      left: nodeX(li, si) - 13 * u,
                      top: railY(li) - 13 * u,
                      width: 26 * u,
                      height: 26 * u,
                      boxSizing: "border-box",
                      borderRadius: review ? 5 * u : "50%",
                      rotate: review ? "45deg" : "0deg",
                      scale: review ? 0.82 : 1,
                      border: `${2.5 * u}px solid ${review ? color.accentLight : color.muted}`,
                      background: color.panel,
                      opacity: hubIn,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: nodeX(li, si),
                      top: railY(li) + 30 * u,
                      translate: "-50% 0px",
                      fontFamily: font.mono,
                      fontSize: (portrait ? 15 : 17) * u,
                      color: review ? color.accentLight : color.muted,
                      whiteSpace: "nowrap",
                      opacity: hubIn,
                    }}
                  >
                    {s.name}
                  </div>
                </React.Fragment>
              );
            })}
          </React.Fragment>
        );
      })}

      {items.map((item) => {
        const target = chipTarget(item);
        const queued = slotOf(item) > 0;
        if (item.chipOnly) {
          if (frame < item.at) return null;
          const t = progress(frame, item.at, item.at + 20, easeInOut);
          const from = { x: source.x + source.w / 2 - chipW / 2, y: source.y + source.h / 2 - chipH / 2 };
          return (
            <Chip
              key={item.id}
              id={item.id}
              x={interpolate(t, [0, 1], [from.x, target.x])}
              y={interpolate(t, [0, 1], [from.y, target.y]) - Math.sin(t * Math.PI) * 60 * u}
              w={chipW}
              h={chipH}
              queued={queued}
              opacity={progress(frame, item.at, item.at + 6)}
            />
          );
        }
        if (frame < item.at) return null;
        const show = progress(frame, item.at, item.at + SHOW);
        const fly = progress(frame, item.at + FLY, item.at + LAND, easeInOut);
        const match = progress(frame, item.at + MATCH, item.at + MATCH + 6);
        if (fly >= 1)
          return (
            <Chip key={item.id} id={item.id} x={target.x} y={target.y} w={chipW} h={chipH} queued={queued} opacity={1} />
          );
        // The card morphs into a chip while it flies.
        const cardOpacity = 1 - progress(frame, item.at + FLY, item.at + FLY + 8);
        return (
          <div
            key={item.id}
            style={{
              position: "absolute",
              left: interpolate(fly, [0, 1], [source.x, target.x]),
              top: interpolate(fly, [0, 1], [source.y, target.y]),
              width: interpolate(fly, [0, 1], [source.w, chipW]),
              height: interpolate(fly, [0, 1], [source.h, chipH]),
              borderRadius: interpolate(fly, [0, 1], [12 * u, 40 * u]),
              background: interpolateColors(fly, [0, 1], [gh.canvas, color.accentLight]),
              border: `${1.5 * u}px solid ${interpolateColors(fly, [0, 1], [gh.border, color.accentLight])}`,
              boxShadow: `0 ${20 * u}px ${50 * u}px rgb(0 0 0 / 0.45)`,
              opacity: show,
              translate: `0px ${interpolate(show, [0, 1], [30 * u, 0])}px`,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: source.w,
                height: source.h,
                boxSizing: "border-box",
                padding: `${24 * u}px ${28 * u}px`,
                display: "flex",
                flexDirection: "column",
                gap: 16 * u,
                fontFamily: font.github,
                color: gh.ink,
                opacity: cardOpacity,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12 * u,
                  fontWeight: 600,
                  fontSize: 28 * u,
                  whiteSpace: "nowrap",
                }}
              >
                <IssueIcon size={28 * u} />
                {item.title} <span style={{ color: gh.muted, fontWeight: 400 }}>{item.id}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 * u }}>
                <span
                  style={{
                    fontSize: 19 * u,
                    fontWeight: 600,
                    padding: `${3 * u}px ${12 * u}px`,
                    borderRadius: 999,
                    background: item.tag === "dark-factory" ? "#0f766e" : "#eaeef2",
                    color: item.tag === "dark-factory" ? "#fff" : gh.ink,
                    boxShadow: `0 0 0 ${4 * u * match}px rgb(94 234 212 / ${0.8 * match})`,
                  }}
                >
                  {item.tag}
                </span>
                <span style={{ fontFamily: font.mono, fontSize: 19 * u, color: gh.wakeBadge, opacity: match }}>
                  › {lanes[item.lane]!.name}
                </span>
              </div>
            </div>
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                fontFamily: font.mono,
                fontSize: 20 * u,
                color: color.surface,
                opacity: progress(frame, item.at + FLY + 8, item.at + LAND),
              }}
            >
              {item.id}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const Chip: React.FC<{
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly queued: boolean;
  readonly opacity: number;
}> = ({ id, x, y, w, h, queued, opacity }) => {
  const frame = useCurrentFrame();
  const { u } = useLayout();
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        boxSizing: "border-box",
        borderRadius: 999,
        display: "grid",
        placeItems: "center",
        fontFamily: font.mono,
        fontSize: 20 * u,
        color: queued ? color.ink : color.surface,
        background: queued ? color.card : color.accentLight,
        border: `${1.5 * u}px solid ${queued ? color.muted : color.accentLight}`,
        boxShadow: queued
          ? undefined
          : `0 0 ${24 * u}px rgb(94 234 212 / ${interpolate(Math.sin(frame / 5), [-1, 1], [0.2, 0.6])})`,
        opacity,
      }}
    >
      {id}
    </div>
  );
};

const Trigger: React.FC<{
  readonly label: string;
  readonly pulse: number;
  readonly icon: "webhook" | "schedule";
}> = ({ label, pulse, icon }) => {
  const { u } = useLayout();
  const tint = interpolateColors(pulse, [0, 1], [color.muted, color.accentLight]);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6 * u,
        fontFamily: font.mono,
        fontWeight: 400,
        fontSize: 17 * u,
        color: tint,
        padding: `${4 * u}px ${10 * u}px`,
        borderRadius: 999,
        border: `${1.5 * u}px solid ${tint}`,
        boxShadow: `0 0 ${20 * u * pulse}px rgb(94 234 212 / ${0.5 * pulse})`,
      }}
    >
      <svg
        width={18 * u}
        height={18 * u}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon === "webhook" ? (
          <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </>
        )}
      </svg>
      {label}
    </span>
  );
};

const IssueIcon: React.FC<{ readonly size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={gh.open} strokeWidth="2">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="1.6" fill={gh.open} />
  </svg>
);
