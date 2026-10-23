import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Logo } from "../components/Logo";
import { Headline, QuestionIcon } from "../components/ui";
import { color, easeInOut, font, progress, useLayout } from "../theme";

// Recreates the web UI's board (src/surfaces/web/src/features/board) and app shell.
const columns = ["Ready", "Active", "Needs input", "Error", "Finished"] as const;
const BORDER_STRONG = "#3b414c";

type Move = readonly [frame: number, column: number, slot: number];
type Card = {
  readonly ref: string;
  readonly title: string;
  readonly workflow: string;
  readonly stage: string;
  readonly stats: string;
  /** Active-run row shown while the card sits in Active. */
  readonly run?: readonly [action: string, runner: string];
  readonly clarification?: boolean;
  readonly moves: readonly Move[];
};

const cards: readonly Card[] = [
  { ref: "#436", title: "Add OpenAPI docs for /audit", workflow: "dark-factory", stage: "refine", stats: "0 runs · no runs yet", moves: [[0, 0, 0]] },
  {
    ref: "#433",
    title: "Paginate run history",
    workflow: "dark-factory",
    stage: "implement",
    stats: "1 run · last run 3m ago",
    run: ["implement running", "claude · 1m"],
    moves: [[0, 0, 1], [72, 1, 2]],
  },
  {
    ref: "#418",
    title: "Export audit log as CSV",
    workflow: "dark-factory",
    stage: "merge",
    stats: "4 runs · 31m total",
    run: ["merge running", "pr.merge · 8s"],
    moves: [[0, 1, 0], [26, 4, 0]],
  },
  {
    ref: "#424",
    title: "Retry failed webhook deliveries",
    workflow: "dark-factory",
    stage: "implement",
    stats: "3 runs · last run 1m ago",
    run: ["PR review running", "claude-opus · 2m"],
    moves: [[0, 1, 1], [30, 1, 0]],
  },
  {
    ref: "#421",
    title: "Rate-limit the public API",
    workflow: "default",
    stage: "implement",
    stats: "2 runs · last run 6m ago",
    run: ["implement running", "claude · 12s"],
    clarification: true,
    moves: [[0, 2, 0], [50, 1, 1]],
  },
  { ref: "#412", title: "Bump Node to 24", workflow: "dark-factory", stage: "complete-issue", stats: "5 runs · 44m total", moves: [[0, 4, 0], [26, 4, 1]] },
  { ref: "#409", title: "Cache provider polling", workflow: "default", stage: "complete-issue", stats: "6 runs · 1h 2m total", moves: [[0, 4, 1], [26, 4, 2]] },
];

const MOVE = 16;

const place = (frame: number, moves: readonly Move[]) => {
  let col = moves[0]![1];
  let slot = moves[0]![2];
  for (const [at, c, s] of moves.slice(1)) {
    const t = progress(frame, at, at + MOVE, easeInOut);
    col = interpolate(t, [0, 1], [col, c]);
    slot = interpolate(t, [0, 1], [slot, s]);
  }
  return { col, slot };
};

const columnAt = (frame: number, moves: readonly Move[]) =>
  [...moves].reverse().find(([at]) => frame >= at + MOVE / 2)?.[1] ?? moves[0]![1];

export const ControlPlane: React.FC = () => {
  const frame = useCurrentFrame();
  const { u, portrait, width, height } = useLayout();
  const enter = progress(frame, 0, 18);

  const win = portrait
    ? { left: 80 * u, top: 320 * u, width: width - 160 * u, height: height - 420 * u }
    : { left: 120 * u, top: 250 * u, width: width - 240 * u, height: 760 * u };
  const headerH = 64 * u;
  const sidebarW = portrait ? 0 : 290 * u;
  const pad = 22 * u;
  const viewW = win.width - sidebarW - 2 * pad;

  const colW = 290 * u;
  const gap = 12 * u;
  const worldW = columns.length * colW + (columns.length - 1) * gap;
  const colHeadH = 46 * u;
  const cardH = 150 * u;
  const cardGap = 10 * u;
  const colX = (c: number) => c * (colW + gap);

  // Camera follows each move, then pulls back to the whole board.
  const s0 = viewW / worldW;
  const ease = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut } as const;
  const center = (c: number) => colX(c) + colW / 2;
  const followScale = portrait ? 1.0 : 1.3;
  const follow = interpolate(frame, [0, 16, 96, 116], [s0, followScale, followScale, s0], ease);
  // Focus: #418 to Finished, #421 out of Needs input, #433 into Active.
  const focusX = interpolate(
    frame,
    [0, 16, 24, 40, 46, 58, 66, 78, 96, 116],
    [worldW / 2, center(1.5), center(1.5), center(3.2), center(3.2), center(1.5), center(1.5), center(0.8), center(0.8), worldW / 2],
    ease,
  );
  const scale = follow;
  const tx = viewW / 2 - focusX * scale;

  return (
    <AbsoluteFill>
      <Headline kicker="06 · CONTROL PLANE" lines={[{ from: 0, text: "Every work item, live on one board." }]} />

      <div
        style={{
          position: "absolute",
          ...win,
          opacity: enter,
          scale: interpolate(enter, [0, 1], [0.95, 1]),
          borderRadius: 18 * u,
          overflow: "hidden",
          background: color.surface,
          border: `${1.5 * u}px solid ${color.border}`,
          boxShadow: `0 ${30 * u}px ${80 * u}px rgb(0 0 0 / 0.5)`,
          display: "flex",
          flexDirection: "column",
          fontFamily: font.sans,
        }}
      >
        <AppHeader height={headerH} />
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {portrait ? null : <Sidebar width={sidebarW} frame={frame} />}
          <div style={{ flex: 1, minWidth: 0, position: "relative", overflow: "hidden", padding: pad }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 * u }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10 * u,
                  fontSize: 17 * u,
                  color: color.muted,
                }}
              >
                Group by
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8 * u,
                    padding: `${4 * u}px ${10 * u}px`,
                    border: `${1.5 * u}px solid ${color.border}`,
                    borderRadius: 6 * u,
                    color: color.ink,
                    background: color.panel,
                  }}
                >
                  None
                  <svg width={12 * u} height={12 * u} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M3 4.5l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </span>
            </div>
            <div
              style={{
                position: "absolute",
                left: pad,
                top: pad + 46 * u,
                width: worldW,
                height: 2000 * u,
                transformOrigin: "0 0",
                translate: `${tx}px 0px`,
                scale,
              }}
            >
              {columns.map((name, c) => {
                const count = cards.filter((card) => columnAt(frame, card.moves) === c).length;
                return (
                  <div
                    key={name}
                    style={{
                      position: "absolute",
                      left: colX(c),
                      top: 0,
                      width: colW,
                      height: 1100 * u,
                      background: color.panel,
                      borderRadius: 10 * u,
                    }}
                  >
                    <div
                      style={{
                        height: colHeadH,
                        display: "flex",
                        alignItems: "center",
                        padding: `0 ${14 * u}px`,
                        fontSize: 15 * u,
                        fontWeight: 600,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        color: color.muted,
                      }}
                    >
                      {name} ({count})
                    </div>
                  </div>
                );
              })}
              {cards.map((card) => {
                const { col, slot } = place(frame, card.moves);
                const inColumn = columnAt(frame, card.moves);
                const moving = card.moves.some(([at]) => frame >= at && frame < at + MOVE);
                return (
                  <BoardCard
                    key={card.ref}
                    card={card}
                    active={inColumn === 1}
                    lifted={moving}
                    style={{
                      position: "absolute",
                      left: colX(col) + 8 * u,
                      top: colHeadH + slot * (cardH + cardGap),
                      width: colW - 16 * u,
                      height: cardH,
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const AppHeader: React.FC<{ readonly height: number }> = ({ height }) => {
  const { u } = useLayout();
  return (
    <div
      style={{
        height,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 16 * u,
        padding: `0 ${22 * u}px`,
        background: color.brand,
        borderBottom: `${1.5 * u}px solid ${color.border}`,
        color: "#fff",
      }}
    >
      <svg width={22 * u} height={22 * u} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
      </svg>
      <span style={{ display: "flex", alignItems: "center", gap: 10 * u, fontWeight: 700, fontSize: 24 * u }}>
        <Logo size={34 * u} draw={1} />
        Wake
      </span>
      <span style={{ fontSize: 15 * u, opacity: 0.8 }}>0.1.0</span>
      <span
        style={{
          marginLeft: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 8 * u,
          fontSize: 17 * u,
          padding: `${4 * u}px ${12 * u}px`,
          borderRadius: 999,
          background: "rgb(0 0 0 / 0.18)",
        }}
      >
        <span style={{ width: 10 * u, height: 10 * u, borderRadius: "50%", background: color.good }} />
        Dispatch active
      </span>
    </div>
  );
};

const Sidebar: React.FC<{ readonly width: number; readonly frame: number }> = ({ width, frame }) => {
  const { u } = useLayout();
  const groups = ["Active", "Needs input", "Ready", "Finished"].map((label) => ({
    label,
    count: cards.filter((card) => columns[columnAt(frame, card.moves)] === label).length,
  }));
  const link = (label: string, current = false) => (
    <div
      key={label}
      style={{
        padding: `${8 * u}px ${12 * u}px`,
        borderRadius: 6 * u,
        fontSize: 18 * u,
        color: current ? color.accentLight : color.muted,
        background: current ? "rgb(45 212 191 / 0.1)" : undefined,
        boxShadow: current ? `inset ${2 * u}px 0 ${color.accent}` : undefined,
      }}
    >
      {label}
    </div>
  );
  return (
    <div
      style={{
        width,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: color.panel,
        borderRight: `${1.5 * u}px solid ${color.border}`,
      }}
    >
      <div style={{ padding: 14 * u, display: "grid", gap: 4 * u, borderBottom: `${1.5 * u}px solid ${color.border}` }}>
        {link("Board", true)}
        {link("Work items")}
        {link("Runs")}
      </div>
      <div style={{ padding: `${14 * u}px ${18 * u}px`, display: "grid", gap: 10 * u, fontSize: 17 * u, color: color.muted }}>
        <div style={{ fontSize: 14 * u, letterSpacing: "0.06em", textTransform: "uppercase" }}>Work items</div>
        {groups.map((g) => (
          <div key={g.label} style={{ display: "flex", alignItems: "center", gap: 8 * u }}>
            <svg width={10 * u} height={10 * u} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3.5 2l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {g.label}
            <span style={{ marginLeft: "auto", color: color.ink }}>{g.count}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: "auto", padding: 14 * u, display: "grid", gap: 4 * u, borderTop: `${1.5 * u}px solid ${color.border}` }}>
        {["Events", "Analytics", "Config", "Health"].map((l) => link(l))}
      </div>
    </div>
  );
};

const OutlineChip: React.FC<{ readonly children: React.ReactNode; readonly tint?: string }> = ({
  children,
  tint = color.muted,
}) => {
  const { u } = useLayout();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5 * u,
        fontSize: 14 * u,
        padding: `${2 * u}px ${8 * u}px`,
        borderRadius: 6 * u,
        border: `${1.2 * u}px solid ${tint}`,
        color: tint,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
};

const BoardCard: React.FC<{
  readonly card: Card;
  readonly active: boolean;
  readonly lifted: boolean;
  readonly style: React.CSSProperties;
}> = ({ card, active, lifted, style }) => {
  const frame = useCurrentFrame();
  const { u } = useLayout();
  const showRun = active && card.run !== undefined;
  const pulse = interpolate(Math.sin(frame / 4), [-1, 1], [0.3, 1]);
  return (
    <div
      style={{
        ...style,
        boxSizing: "border-box",
        padding: 10 * u,
        background: color.card,
        border: `${1.2 * u}px solid ${lifted ? color.accent : color.border}`,
        borderLeft: `${3 * u}px solid ${lifted ? color.accent : BORDER_STRONG}`,
        borderRadius: 8 * u,
        overflow: "hidden",
        boxShadow: lifted ? `0 ${18 * u}px ${40 * u}px rgb(0 0 0 / 0.5)` : undefined,
        scale: lifted ? 1.04 : 1,
        zIndex: lifted ? 2 : 1,
      }}
    >
      <div style={{ fontFamily: font.mono, fontSize: 14 * u, color: color.muted }}>atolis-hq/wake{card.ref}</div>
      <div
        style={{
          fontWeight: 600,
          fontSize: 19 * u,
          color: color.ink,
          margin: `${3 * u}px 0 ${6 * u}px`,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {card.title}
      </div>
      <div style={{ display: "flex", gap: 5 * u, flexWrap: "wrap" }}>
        {card.clarification && !active ? (
          <OutlineChip tint={color.accentLight}>
            <QuestionIcon size={14 * u} />
            needs clarification
          </OutlineChip>
        ) : null}
        <OutlineChip>{card.workflow}</OutlineChip>
        <OutlineChip>{card.stage}</OutlineChip>
      </div>
      {showRun ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8 * u,
            marginTop: 8 * u,
            padding: `${5 * u}px ${8 * u}px`,
            borderRadius: 6 * u,
            background: color.inset,
            border: `${1.2 * u}px solid ${color.border}`,
            fontSize: 14 * u,
            color: color.muted,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 10 * u,
              height: 10 * u,
              borderRadius: "50%",
              background: color.good,
              boxShadow: `0 0 ${10 * u}px rgb(134 239 172 / ${pulse})`,
              flexShrink: 0,
            }}
          />
          <span style={{ color: color.ink }}>{card.run![0]}</span>
          {card.run![1]}
        </div>
      ) : (
        <div style={{ marginTop: 10 * u, fontSize: 13 * u, color: color.muted, whiteSpace: "nowrap" }}>{card.stats}</div>
      )}
    </div>
  );
};
