import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { color, font, gh, progress, useLayout } from "../theme";
import { Logo } from "./Logo";
import { CheckIcon, Panel, QuestionIcon } from "./ui";

export type ThreadComment = {
  readonly at: number;
  readonly author: "wake" | "human";
  readonly meta?: string;
  readonly chip?: { readonly tone: "good" | "info"; readonly text: string };
  readonly body: string;
  /** Typewriter reveal over this many frames. */
  readonly typeFor?: number;
  readonly footer?: string;
  readonly verb?: string;
};

export type ThreadLabel = {
  readonly from: number;
  readonly to?: number;
  readonly text: string;
  readonly bg?: string;
  readonly fg?: string;
};

export type ThreadStatus = {
  readonly from: number;
  readonly text: string;
  readonly tint: string;
};

export type RailStep = {
  readonly name: string;
  /** Reviews are gates run by a separate agent, drawn distinctly from work stages. */
  readonly review?: string;
  readonly activeAt: number;
  readonly doneAt: number;
};

type Props = {
  readonly number: number;
  readonly title: string;
  readonly workflow: string;
  readonly closedAt?: number;
  readonly labels: readonly ThreadLabel[];
  readonly statuses: readonly ThreadStatus[];
  readonly rail: readonly RailStep[];
  readonly comments: readonly ThreadComment[];
  readonly focus: number;
  /** 0..1 mint pulse on the Wake strip while waiting on a human. */
  readonly waiting: number;
  readonly style: React.CSSProperties;
};

/** A GitHub-like issue (external system) with Wake's own workflow strip docked above it. */
export const IssueThread: React.FC<Props> = ({
  number,
  title,
  workflow,
  closedAt,
  labels,
  statuses,
  rail,
  comments,
  focus,
  waiting,
  style,
}) => {
  const frame = useCurrentFrame();
  const { u } = useLayout();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14 * u,
        opacity: interpolate(focus, [0, 1], [0.4, 1]),
        scale: interpolate(focus, [0, 1], [0.97, 1]),
        ...style,
      }}
    >
      <WakeStrip
        workflow={workflow}
        statuses={statuses}
        rail={rail}
        waiting={waiting}
      />
      <GitHubIssue
        number={number}
        title={title}
        closed={closedAt !== undefined && frame >= closedAt}
        labels={labels}
        comments={comments}
      />
    </div>
  );
};

const WakeStrip: React.FC<{
  readonly workflow: string;
  readonly statuses: readonly ThreadStatus[];
  readonly rail: readonly RailStep[];
  readonly waiting: number;
}> = ({ workflow, statuses, rail, waiting }) => {
  const frame = useCurrentFrame();
  const { u } = useLayout();
  const status =
    [...statuses].reverse().find((s) => frame >= s.from) ?? statuses[0]!;
  const breathe = interpolate(Math.sin(frame / 5), [-1, 1], [0.3, 1]);

  return (
    <Panel
      style={{
        flexShrink: 0,
        padding: `${16 * u}px ${24 * u}px ${14 * u}px`,
        borderColor:
          waiting > 0.01
            ? `rgb(94 234 212 / ${0.3 + waiting * breathe * 0.7})`
            : color.border,
        boxShadow: `0 ${20 * u}px ${50 * u}px rgb(0 0 0 / 0.45), 0 0 ${50 * u * waiting}px rgb(94 234 212 / ${0.3 * waiting})`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 * u }}>
        <Logo size={30 * u} draw={1} />
        <span
          style={{
            fontFamily: font.sans,
            fontWeight: 700,
            fontSize: 22 * u,
            color: color.ink,
          }}
        >
          Wake
        </span>
        <span
          style={{
            fontFamily: font.mono,
            fontSize: 19 * u,
            color: color.muted,
          }}
        >
          workflow: {workflow}
        </span>
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 10 * u,
            fontFamily: font.mono,
            fontSize: 20 * u,
            color: status.tint,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 12 * u,
              height: 12 * u,
              borderRadius: "50%",
              background: status.tint,
              opacity: status.text === "working" ? breathe : 1,
            }}
          />
          {status.text}
        </span>
      </div>
      <Rail steps={rail} />
    </Panel>
  );
};

const GitHubIssue: React.FC<{
  readonly number: number;
  readonly title: string;
  readonly closed: boolean;
  readonly labels: readonly ThreadLabel[];
  readonly comments: readonly ThreadComment[];
}> = ({ number, title, closed, labels, comments }) => {
  const frame = useCurrentFrame();
  const { u, portrait } = useLayout();

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: gh.canvas,
        borderRadius: 12 * u,
        border: `${1.5 * u}px solid ${gh.border}`,
        boxShadow: `0 ${30 * u}px ${80 * u}px rgb(0 0 0 / 0.5)`,
        overflow: "hidden",
        fontFamily: font.github,
        color: gh.ink,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8 * u,
          padding: `${7 * u}px ${18 * u}px`,
          background: "#e9ecef",
          borderBottom: `${1.5 * u}px solid ${gh.border}`,
          fontSize: 15 * u,
          color: gh.muted,
          whiteSpace: "nowrap",
        }}
      >
        <svg width={12 * u} height={12 * u} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
        <span>
          <span style={{ color: gh.ink }}>github.com</span>/atolis-hq/wake/issues/{number}
        </span>
      </div>
      <div
        style={{
          padding: `${18 * u}px ${24 * u}px ${14 * u}px`,
          borderBottom: `${1.5 * u}px solid ${gh.border}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 * u }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8 * u,
              padding: `${5 * u}px ${14 * u}px`,
              borderRadius: 999,
              background: closed ? gh.closed : gh.open,
              color: "#fff",
              fontWeight: 600,
              fontSize: 19 * u,
              flexShrink: 0,
            }}
          >
            <svg
              width={18 * u}
              height={18 * u}
              viewBox="0 0 16 16"
              fill="none"
              stroke="#fff"
              strokeWidth="1.6"
            >
              <circle cx="8" cy="8" r="6.2" />
              {closed ? (
                <path d="M5.2 8.2l2 2 3.6-3.8" strokeLinecap="round" />
              ) : (
                <circle cx="8" cy="8" r="1.3" fill="#fff" />
              )}
            </svg>
            {closed ? "Closed" : "Open"}
          </span>
          <span
            style={{
              fontWeight: 600,
              fontSize: (portrait ? 27 : 30) * u,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}{" "}
            <span style={{ color: gh.muted, fontWeight: 400 }}>#{number}</span>
          </span>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8 * u,
            marginTop: 12 * u,
          }}
        >
          {labels
            .filter(
              (l) => frame >= l.from && (l.to === undefined || frame < l.to),
            )
            .map((l) => {
              const p = l.from === 0 ? 1 : progress(frame, l.from, l.from + 10);
              return (
                <span
                  key={l.text}
                  style={{
                    fontSize: 17 * u,
                    fontWeight: 600,
                    padding: `${3 * u}px ${12 * u}px`,
                    borderRadius: 999,
                    background: l.bg ?? "#eaeef2",
                    color: l.fg ?? gh.ink,
                    opacity: p,
                    scale: interpolate(p, [0, 1], [0.8, 1]),
                    whiteSpace: "nowrap",
                  }}
                >
                  {l.text}
                </span>
              );
            })}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
          overflow: "hidden",
          padding: `0 ${24 * u}px ${20 * u}px`,
        }}
      >
        {comments.map((c) => (
          <GitHubComment key={c.at} comment={c} />
        ))}
      </div>
    </div>
  );
};

const GitHubComment: React.FC<{ readonly comment: ThreadComment }> = ({
  comment: c,
}) => {
  const frame = useCurrentFrame();
  const { u, portrait } = useLayout();
  if (frame < c.at) return null;
  const p = c.at <= 0 ? 1 : progress(frame, c.at, c.at + 14);
  const bodySize = (portrait ? 23 : 25) * u;
  const typed =
    c.typeFor === undefined
      ? c.body
      : c.body.slice(
          0,
          Math.floor(
            interpolate(
              frame,
              [c.at + 6, c.at + 6 + c.typeFor],
              [0, c.body.length],
              {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              },
            ),
          ),
        );
  const wake = c.author === "wake";

  return (
    <div
      style={{
        display: "flex",
        gap: 14 * u,
        marginTop: 16 * u,
        maxHeight: interpolate(p, [0, 1], [0, 420 * u]),
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [20 * u, 0])}px`,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 44 * u,
          height: 44 * u,
          borderRadius: "50%",
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          background: wake ? color.surface : "#d8dee4",
          color: gh.ink,
          fontWeight: 700,
          fontSize: 20 * u,
        }}
      >
        {wake ? <Logo size={32 * u} draw={1} /> : "Y"}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          border: `${1.5 * u}px solid ${gh.border}`,
          borderRadius: 10 * u,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: gh.subtle,
            borderBottom: `${1.5 * u}px solid ${gh.border}`,
            padding: `${7 * u}px ${16 * u}px`,
            fontSize: 18 * u,
            color: gh.muted,
            display: "flex",
            alignItems: "center",
            gap: 8 * u,
            whiteSpace: "nowrap",
          }}
        >
          <b style={{ color: gh.ink }}>{wake ? "wake" : "you"}</b>
          {wake ? (
            <span
              style={{
                border: `${1.2 * u}px solid ${gh.border}`,
                borderRadius: 999,
                padding: `0 ${8 * u}px`,
                fontSize: 14 * u,
              }}
            >
              bot
            </span>
          ) : null}
          {c.verb ?? "commented now"}
          {c.chip ? <GitHubOutcome tone={c.chip.tone} text={c.chip.text} /> : null}
          {c.meta ? (
            <span
              style={{
                marginLeft: "auto",
                fontFamily: font.mono,
                fontSize: 15 * u,
              }}
            >
              {c.meta}
            </span>
          ) : null}
        </div>
        <div style={{ padding: `${10 * u}px ${16 * u}px ${12 * u}px` }}>
          <div style={{ fontSize: bodySize, lineHeight: 1.35 }}>
            {typed}
            {c.typeFor !== undefined && typed.length < c.body.length ? (
              <span
                style={{
                  display: "inline-block",
                  width: 3 * u,
                  height: bodySize,
                  marginLeft: 3 * u,
                  verticalAlign: "-0.15em",
                  background: gh.link,
                  opacity: Math.floor(frame / 4) % 2,
                }}
              />
            ) : null}
          </div>
          {c.footer ? (
            <div
              style={{
                fontStyle: "italic",
                fontSize: 18 * u,
                color: gh.muted,
                marginTop: 6 * u,
              }}
            >
              {c.footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/** Wake's outcome line as it renders inside a GitHub comment. */
const GitHubOutcome: React.FC<{
  readonly tone: "good" | "info";
  readonly text: string;
}> = ({ tone, text }) => {
  const { u } = useLayout();
  const fg = tone === "good" ? gh.open : gh.wakeBadge;
  const bg = tone === "good" ? "#dafbe1" : "#d5f5f0";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6 * u,
        fontWeight: 600,
        fontSize: 18 * u,
        padding: `${2 * u}px ${10 * u}px`,
        borderRadius: 999,
        color: fg,
        background: bg,
        border: `${1.2 * u}px solid ${fg}`,
        whiteSpace: "nowrap",
      }}
    >
      {tone === "info" ? (
        <QuestionIcon size={18 * u} />
      ) : (
        <CheckIcon size={16 * u} />
      )}
      {text}
    </span>
  );
};

export const Rail: React.FC<{ readonly steps: readonly RailStep[] }> = ({
  steps,
}) => {
  const frame = useCurrentFrame();
  const { u, portrait } = useLayout();
  return (
    <div
      style={{ display: "flex", alignItems: "flex-start", marginTop: 14 * u }}
    >
      {steps.map((step, i) => {
        const done = frame >= step.doneAt;
        const active = !done && frame >= step.activeAt;
        const review = step.review !== undefined;
        const tint = done
          ? color.good
          : active
            ? review
              ? color.accentLight
              : color.active
            : color.muted;
        const fill = progress(frame, step.doneAt, step.doneAt + 8);
        const pulse = active
          ? interpolate(Math.sin(frame / 4), [-1, 1], [0.4, 1])
          : 1;
        return (
          <React.Fragment key={step.name}>
            {i > 0 ? (
              <div
                style={{
                  flex: 1,
                  height: 2 * u,
                  marginTop: 12 * u,
                  minWidth: 12 * u,
                  background:
                    frame >= step.activeAt ? color.good : color.border,
                }}
              />
            ) : null}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 5 * u,
              }}
            >
              <div
                style={{
                  width: 26 * u,
                  height: 26 * u,
                  boxSizing: "border-box",
                  // Review gates are diamonds; work stages are circles.
                  borderRadius: review ? 5 * u : "50%",
                  rotate: review ? "45deg" : "0deg",
                  scale: review ? 0.82 : 1,
                  border: `${2.5 * u}px solid ${tint}`,
                  background: done
                    ? `rgb(127 227 163 / ${fill})`
                    : "transparent",
                  opacity: pulse,
                  boxShadow: active ? `0 0 ${18 * u}px ${tint}` : undefined,
                }}
              />
              <span
                style={{
                  fontFamily: font.mono,
                  fontSize: (portrait ? 16 : 18) * u,
                  color: done || active ? color.ink : color.muted,
                  whiteSpace: "nowrap",
                }}
              >
                {step.name}
              </span>
              {step.review ? (
                <span
                  style={{
                    fontFamily: font.mono,
                    fontSize: (portrait ? 14 : 15) * u,
                    color: color.accentLight,
                    whiteSpace: "nowrap",
                    marginTop: -3 * u,
                  }}
                >
                  {step.review}
                </span>
              ) : null}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};
