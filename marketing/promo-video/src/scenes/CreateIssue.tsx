import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Logo } from "../components/Logo";
import { Headline } from "../components/ui";
import { easeInOut, font, gh, progress, useLayout } from "../theme";

// A GitHub-like "new issue" page, filmed close-up: type, assign Wake, label, create.
const TITLE = "Export audit log as CSV";
const BODY = "Admins need to export the audit log as CSV for compliance reviews.";

const T_TITLE = [10, 46] as const;
const T_BODY = [56, 80] as const;
const ASSIGN = 88;
const LABEL = 98;
const CLICK = 108;
const CREATED = 114;

// Page "world" in u-units.
const PAGE_W = 1400;
const PAGE_H = 860;
const SIDE_X = 1000;
const FORM_Y = 120;

const ease = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut } as const;

export const CreateIssue: React.FC = () => {
  const frame = useCurrentFrame();
  const { u, portrait, width, height } = useLayout();

  const win = portrait
    ? { left: 80 * u, top: 320 * u, width: width - 160 * u, height: height - 420 * u }
    : { left: 160 * u, top: 250 * u, width: width - 320 * u, height: 790 * u };
  const chromeH = 58 * u;
  const viewW = win.width;
  const viewH = win.height - chromeH;
  const fit = Math.min(viewW / (PAGE_W * u), viewH / (PAGE_H * u));
  const close = portrait ? 1.55 : 1.45;

  // Camera keyframes: [frame, focusX, focusY, scale] in page units.
  const keys: readonly (readonly [number, number, number, number])[] = [
    [0, 0, FORM_Y + 110, close * 1.12],
    [14, 0, FORM_Y + 110, close],
    [46, 0, FORM_Y + 110, close],
    [58, 0, FORM_Y + 300, close],
    [80, 300, FORM_Y + 300, close],
    [90, SIDE_X + 180, FORM_Y + 150, close],
    [102, SIDE_X + 180, FORM_Y + 150, close],
    [110, PAGE_W / 2, 0, fit],
  ];
  const at = (i: 1 | 2 | 3) =>
    interpolate(
      frame,
      keys.map((k) => k[0]),
      keys.map((k) => k[i]),
      ease,
    );
  const scale = at(3);
  // Clamp so the camera never shows past the page's left/top edges.
  const halfW = viewW / (2 * u * scale);
  const halfH = viewH / (2 * u * scale);
  const fx = PAGE_W < 2 * halfW ? PAGE_W / 2 : Math.min(Math.max(at(1), halfW), PAGE_W - halfW);
  const fy = Math.max(at(2), halfH);
  const tx = viewW / 2 - fx * u * scale;
  const ty = viewH / 2 - fy * u * scale;

  const titleTyped = TITLE.slice(0, Math.floor(interpolate(frame, T_TITLE, [0, TITLE.length], ease)));
  const bodyTyped = BODY.slice(0, Math.floor(interpolate(frame, T_BODY, [0, BODY.length], ease)));
  const typingTitle = frame >= T_TITLE[0] && frame < T_BODY[0] - 4;
  const typingBody = frame >= T_BODY[0] - 4 && frame < ASSIGN - 6;
  const caret = Math.floor(frame / 6) % 2 === 0;
  const created = progress(frame, CREATED, CREATED + 10);
  const press = interpolate(frame, [CLICK - 2, CLICK, CLICK + 4], [1, 0.94, 1], ease);

  // Cursor path in page units.
  const cursorKeys: readonly (readonly [number, number, number])[] = [
    [80, 760, FORM_Y + 420],
    [86, SIDE_X + 330, FORM_Y + 70],
    [92, SIDE_X + 330, FORM_Y + 70],
    [96, SIDE_X + 330, FORM_Y + 190],
    [104, SIDE_X + 330, FORM_Y + 190],
    [106, 870, FORM_Y + 520],
  ];
  const cx = interpolate(frame, cursorKeys.map((k) => k[0]), cursorKeys.map((k) => k[1]), ease);
  const cy = interpolate(frame, cursorKeys.map((k) => k[0]), cursorKeys.map((k) => k[2]), ease);
  const cursorOn = progress(frame, 78, 84) * (1 - created);

  const P = (v: number) => v * u;

  return (
    <AbsoluteFill>
      <Headline
        kicker="01 · START IN GITHUB"
        lines={[
          { from: 0, text: "It starts with an issue." },
          { from: ASSIGN - 10, text: "Assign Wake. Add a label." },
        ]}
      />
      <div
        style={{
          position: "absolute",
          ...win,
          borderRadius: 16 * u,
          overflow: "hidden",
          background: gh.canvas,
          border: `${1.5 * u}px solid ${gh.border}`,
          boxShadow: `0 ${30 * u}px ${80 * u}px rgb(0 0 0 / 0.5)`,
          opacity: progress(frame, 0, 12),
          scale: interpolate(progress(frame, 0, 16), [0, 1], [0.96, 1]),
          fontFamily: font.github,
          color: gh.ink,
        }}
      >
        <BrowserBar height={chromeH} url={`github.com/atolis-hq/wake/issues/${frame >= CREATED ? "418" : "new"}`} />
        <div style={{ position: "relative", width: viewW, height: viewH, overflow: "hidden" }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: P(PAGE_W),
              height: P(PAGE_H),
              transformOrigin: "0 0",
              translate: `${tx}px ${ty}px`,
              scale,
            }}
          >
            {/* Repo header */}
            <div style={{ position: "absolute", left: P(40), top: P(24), display: "flex", alignItems: "center", gap: P(10), fontSize: P(26) }}>
              <RepoIcon size={P(24)} />
              <span style={{ color: gh.link }}>atolis-hq</span>
              <span style={{ color: gh.muted }}>/</span>
              <b style={{ color: gh.link }}>wake</b>
            </div>
            <div style={{ position: "absolute", left: P(40), top: P(70), display: "flex", gap: P(30), fontSize: P(20), color: gh.ink }}>
              {["Code", "Issues", "Pull requests", "Actions"].map((t) => (
                <span
                  key={t}
                  style={{
                    paddingBottom: P(8),
                    borderBottom: t === "Issues" ? `${P(3)}px solid #fd8c73` : "none",
                    fontWeight: t === "Issues" ? 600 : 400,
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
            <div style={{ position: "absolute", left: 0, right: 0, top: P(108), height: P(1.5), background: gh.border }} />

            {created < 1 ? (
              <div style={{ opacity: 1 - created }}>
                <div style={{ position: "absolute", left: P(40), top: P(FORM_Y + 20), fontSize: P(34), fontWeight: 600 }}>
                  Create new issue
                </div>
                <div style={{ position: "absolute", left: P(40), top: P(FORM_Y + 76), fontSize: P(20), fontWeight: 600 }}>
                  Add a title <span style={{ color: "#d1242f" }}>*</span>
                </div>
                <Field x={40} y={FORM_Y + 108} w={920} h={60} active={typingTitle} u={u}>
                  <span style={{ fontSize: P(26) }}>
                    {titleTyped}
                    {typingTitle && caret ? <Caret h={P(28)} /> : null}
                  </span>
                </Field>
                <div style={{ position: "absolute", left: P(40), top: P(FORM_Y + 196), fontSize: P(20), fontWeight: 600 }}>
                  Add a description
                </div>
                <Field x={40} y={FORM_Y + 228} w={920} h={250} active={typingBody} u={u}>
                  <div style={{ display: "flex", gap: P(18), fontSize: P(18), color: gh.muted, marginBottom: P(14) }}>
                    <span style={{ color: gh.ink, fontWeight: 600 }}>Write</span>
                    <span>Preview</span>
                  </div>
                  <span style={{ fontSize: P(23), lineHeight: 1.4 }}>
                    {bodyTyped}
                    {typingBody && caret ? <Caret h={P(25)} /> : null}
                  </span>
                </Field>
                <div
                  style={{
                    position: "absolute",
                    left: P(820),
                    top: P(FORM_Y + 500),
                    width: P(140),
                    height: P(52),
                    borderRadius: P(8),
                    display: "grid",
                    placeItems: "center",
                    background: "#1f883d",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: P(21),
                    scale: press,
                    boxShadow: frame >= CLICK - 8 ? `0 0 0 ${P(4)}px rgb(31 136 61 / 0.3)` : undefined,
                  }}
                >
                  Create
                </div>

                <SideSection x={SIDE_X} y={FORM_Y + 56} title="Assignees" u={u} highlight={frame >= ASSIGN && frame < ASSIGN + 14}>
                  {frame >= ASSIGN ? (
                    <span style={{ display: "flex", alignItems: "center", gap: P(10), fontSize: P(20) }}>
                      <span style={{ width: P(28), height: P(28), borderRadius: "50%", background: "#14161a", display: "grid", placeItems: "center" }}>
                        <Logo size={P(22)} draw={1} />
                      </span>
                      <b>wake</b>
                      <span style={{ fontSize: P(14), color: gh.muted, border: `${P(1.2)}px solid ${gh.border}`, borderRadius: 999, padding: `0 ${P(7)}px` }}>
                        bot
                      </span>
                    </span>
                  ) : (
                    <span style={{ fontSize: P(19), color: gh.muted }}>No one - assign yourself</span>
                  )}
                </SideSection>
                <SideSection x={SIDE_X} y={FORM_Y + 176} title="Labels" u={u} highlight={frame >= LABEL && frame < LABEL + 14}>
                  {frame >= LABEL ? (
                    <span
                      style={{
                        fontSize: P(18),
                        fontWeight: 600,
                        padding: `${P(3)}px ${P(12)}px`,
                        borderRadius: 999,
                        background: "#0f766e",
                        color: "#fff",
                        scale: interpolate(progress(frame, LABEL, LABEL + 8), [0, 1], [0.7, 1]),
                        display: "inline-block",
                      }}
                    >
                      dark-factory
                    </span>
                  ) : (
                    <span style={{ fontSize: P(19), color: gh.muted }}>None yet</span>
                  )}
                </SideSection>
                <SideSection x={SIDE_X} y={FORM_Y + 296} title="Projects" u={u}>
                  <span style={{ fontSize: P(19), color: gh.muted }}>None yet</span>
                </SideSection>
                <SideSection x={SIDE_X} y={FORM_Y + 416} title="Milestone" u={u}>
                  <span style={{ fontSize: P(19), color: gh.muted }}>No milestone</span>
                </SideSection>
              </div>
            ) : null}

            {created > 0 ? (
              <div
                style={{
                  position: "absolute",
                  left: P(40),
                  top: P(FORM_Y + 30),
                  right: P(40),
                  opacity: created,
                  translate: `0px ${interpolate(created, [0, 1], [P(20), 0])}px`,
                }}
              >
                <div style={{ fontSize: P(44), fontWeight: 400 }}>
                  {TITLE} <span style={{ color: gh.muted }}>#418</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: P(14), marginTop: P(18), fontSize: P(20), color: gh.muted }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: P(8),
                      padding: `${P(6)}px ${P(16)}px`,
                      borderRadius: 999,
                      background: gh.open,
                      color: "#fff",
                      fontWeight: 600,
                    }}
                  >
                    Open
                  </span>
                  <b style={{ color: gh.ink }}>you</b> opened this issue now
                  <span
                    style={{
                      fontSize: P(18),
                      fontWeight: 600,
                      padding: `${P(3)}px ${P(12)}px`,
                      borderRadius: 999,
                      background: "#0f766e",
                      color: "#fff",
                    }}
                  >
                    dark-factory
                  </span>
                </div>
                <div style={{ marginTop: P(30), padding: P(24), border: `${P(1.5)}px solid ${gh.border}`, borderRadius: P(10), fontSize: P(24) }}>
                  {BODY}
                </div>
              </div>
            ) : null}

            {cursorOn > 0 ? <Cursor x={P(cx)} y={P(cy)} size={P(34)} opacity={cursorOn} /> : null}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const BrowserBar: React.FC<{ readonly height: number; readonly url: string }> = ({ height, url }) => {
  const { u } = useLayout();
  return (
    <div
      style={{
        height,
        display: "flex",
        alignItems: "center",
        gap: 14 * u,
        padding: `0 ${18 * u}px`,
        background: "#e9ecef",
        borderBottom: `${1.5 * u}px solid ${gh.border}`,
      }}
    >
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <span key={c} style={{ width: 14 * u, height: 14 * u, borderRadius: "50%", background: c }} />
      ))}
      <span
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 8 * u,
          marginLeft: 10 * u,
          padding: `${6 * u}px ${16 * u}px`,
          borderRadius: 999,
          background: "#fff",
          fontFamily: font.github,
          fontSize: 18 * u,
          color: gh.muted,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <svg width={14 * u} height={14 * u} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
        <span>
          <span style={{ color: gh.ink }}>github.com</span>
          {url.slice("github.com".length)}
        </span>
      </span>
    </div>
  );
};

const Field: React.FC<{
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly active: boolean;
  readonly u: number;
  readonly children: React.ReactNode;
}> = ({ x, y, w, h, active, u, children }) => (
  <div
    style={{
      position: "absolute",
      left: x * u,
      top: y * u,
      width: w * u,
      height: h * u,
      boxSizing: "border-box",
      padding: `${14 * u}px ${18 * u}px`,
      borderRadius: 8 * u,
      border: `${1.5 * u}px solid ${active ? gh.link : gh.border}`,
      boxShadow: active ? `0 0 0 ${3 * u}px rgb(9 105 218 / 0.25)` : undefined,
      background: gh.canvas,
    }}
  >
    {children}
  </div>
);

const SideSection: React.FC<{
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly u: number;
  readonly highlight?: boolean;
  readonly children: React.ReactNode;
}> = ({ x, y, title, u, highlight = false, children }) => (
  <div
    style={{
      position: "absolute",
      left: x * u,
      top: y * u,
      width: 360 * u,
      paddingBottom: 18 * u,
      borderBottom: `${1.5 * u}px solid ${gh.border}`,
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        fontSize: 18 * u,
        fontWeight: 600,
        color: highlight ? gh.link : gh.muted,
        marginBottom: 12 * u,
      }}
    >
      {title}
      <svg width={18 * u} height={18 * u} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" strokeLinecap="round" />
      </svg>
    </div>
    {children}
  </div>
);

const Caret: React.FC<{ readonly h: number }> = ({ h }) => (
  <span style={{ display: "inline-block", width: 2.5, height: h, marginLeft: 2, verticalAlign: "-0.2em", background: gh.ink }} />
);

const Cursor: React.FC<{ readonly x: number; readonly y: number; readonly size: number; readonly opacity: number }> = ({
  x,
  y,
  size,
  opacity,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    style={{ position: "absolute", left: x, top: y, opacity, filter: "drop-shadow(0 2px 3px rgb(0 0 0 / 0.35))" }}
  >
    <path d="M4 2l15 9.5-6.5 1.4 3.6 7.1-2.6 1.3-3.6-7.1L5 18.5z" fill="#111" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

const RepoIcon: React.FC<{ readonly size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={gh.muted} strokeWidth="1.3">
    <path d="M3 2.5h8.5v10H4.5A1.5 1.5 0 0 0 3 14V2.5z" strokeLinejoin="round" />
    <path d="M3 14a1.5 1.5 0 0 1 1.5-1.5h7" />
  </svg>
);
