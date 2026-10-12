import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { IssueThread } from "../components/IssueThread";
import { Headline } from "../components/ui";
import { color, easeInOut, font, gh, progress, useLayout } from "../theme";

// The dark-factory issue whips out and the human-in-the-loop issue whips in here.
const HANDOFF = 150;
const NEVER = 1e6;

// Human-in-the-loop beats, relative to HANDOFF.
const ASK = 12;
const REPLY = 72;
const RESUME = 165;

export const Threads: React.FC = () => {
  const frame = useCurrentFrame();
  const { u, portrait, width, height } = useLayout();

  const frameRect = portrait
    ? { left: 80 * u, top: 320 * u, width: width - 160 * u, height: height - 420 * u }
    : { left: 360 * u, top: 250 * u, width: width - 720 * u, height: 800 * u };

  // Whip transition: fast ease with motion blur proportional to speed.
  const outA = progress(frame, HANDOFF - 12, HANDOFF + 4, easeInOut);
  const inB = progress(frame, HANDOFF - 6, HANDOFF + 12, easeInOut);
  const whip = (p: number) => Math.sin(p * Math.PI);
  const b = frame - HANDOFF;

  // Camera on B: push in on the question, follow the reply, then pull back out.
  const zoom =
    interpolate(b, [ASK + 10, ASK + 30], [1, 1.32], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: easeInOut,
    }) -
    interpolate(b, [REPLY + 44, REPLY + 64], [0, 0.32], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: easeInOut,
    });
  // Camera on A: push in as the second agent's review lands, pull out for the merge.
  const zoomA =
    interpolate(frame, [70, 90], [1, 1.22], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: easeInOut,
    }) -
    interpolate(frame, [104, 122], [0, 0.22], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: easeInOut,
    });
  const waiting =
    progress(frame, HANDOFF + ASK + 4, HANDOFF + ASK + 14) *
    (1 - progress(frame, HANDOFF + REPLY + 30, HANDOFF + REPLY + 42));
  const looped =
    progress(frame, HANDOFF + ASK + 22, HANDOFF + ASK + 34) *
    (1 - progress(frame, HANDOFF + REPLY + 40, HANDOFF + REPLY + 50));

  return (
    <AbsoluteFill>
      <Headline
        kicker={[
          { from: 0, text: "03 · DARK FACTORY" },
          { from: HANDOFF, text: "04 · HUMAN IN THE LOOP" },
        ]}
        lines={[
          { from: 0, text: "Unattended when it can be." },
          { from: 44, text: "Reviewed by a second agent." },
          { from: 100, text: "Merged when the gates pass." },
          { from: HANDOFF, text: "Humans looped in only when needed." },
          { from: HANDOFF + REPLY + 10, text: "Answer on the issue. Wake carries on." },
        ]}
      />

      {outA < 1 ? (
        <div
          style={{
            position: "absolute",
            ...frameRect,
            translate: `${-outA * width}px 0px`,
            filter: `blur(${whip(outA) * 14}px)`,
            overflow: "hidden",
            borderRadius: 22 * u,
          }}
        >
        <IssueThread
          number={418}
          title="Export audit log as CSV"
          workflow="dark-factory"
          closedAt={122}
          focus={1}
          waiting={0}
          style={{
            position: "absolute",
            inset: 0,
            scale: zoomA,
            transformOrigin: "4% 62%",
          }}
          labels={[
            { from: 0, text: "dark-factory", bg: "#0f766e", fg: "#ffffff" },
            { from: 0, to: 92, text: "wake:stage.implement" },
            { from: 40, to: 84, text: "wake:watching" },
            { from: 92, to: 122, text: "wake:stage.merge" },
            { from: 122, text: "wake:status.completed", bg: "#dafbe1", fg: gh.open },
          ]}
          statuses={[
            { from: 0, text: "working", tint: color.active },
            { from: 122, text: "completed", tint: color.good },
          ]}
          rail={[
            { name: "refine", activeAt: -1, doneAt: 0 },
            { name: "plan review", review: "codex", activeAt: -1, doneAt: 0 },
            { name: "implement", activeAt: 0, doneAt: 34 },
            { name: "PR review", review: "claude-opus", activeAt: 40, doneAt: 84 },
            { name: "merge", activeAt: 92, doneAt: 116 },
          ]}
          comments={[
            {
              at: -2,
              author: "human",
              verb: "opened this issue",
              body: "Admins need to export the audit log as CSV for compliance reviews.",
            },
            {
              at: 0,
              author: "wake",
              meta: "refine · codex",
              chip: { tone: "good", text: "Done" },
              body: "Plan: stream audit rows to CSV at /audit/export.",
            },
            {
              at: 34,
              author: "wake",
              meta: "implement · claude",
              chip: { tone: "good", text: "Done" },
              body: "Opened PR #422 · 4 files, tests added.",
            },
            {
              at: 84,
              author: "wake",
              meta: "pr-review · claude-opus",
              chip: { tone: "good", text: "Accepted" },
              body: "Independent review: edge cases covered, ready to merge.",
            },
          ]}
        />
        </div>
      ) : null}

      {inB > 0 ? (
        <div
          style={{
            position: "absolute",
            ...frameRect,
            translate: `${(1 - inB) * width}px 0px`,
            filter: `blur(${whip(inB) * 14}px)`,
            // Camera push happens inside a fixed frame so the headline stays clear.
            overflow: "hidden",
            borderRadius: 22 * u,
          }}
        >
          <IssueThread
            number={421}
            title="Rate-limit the public API"
            workflow="default"
            focus={1}
            waiting={waiting}
            style={{
              position: "absolute",
              inset: 0,
              scale: zoom,
              transformOrigin: "4% 30%",
            }}
            labels={[
              { from: 0, text: "wake:workflow.default" },
              { from: 0, text: "wake:stage.implement" },
            ]}
            statuses={[
              { from: 0, text: "working", tint: color.active },
              { from: HANDOFF + ASK + 3, text: "needs clarification", tint: color.accentLight },
              { from: HANDOFF + REPLY + 36, text: "working", tint: color.active },
            ]}
            rail={[
              { name: "refine", activeAt: -1, doneAt: 0 },
              { name: "implement", activeAt: 0, doneAt: NEVER },
              { name: "complete", activeAt: NEVER, doneAt: NEVER },
            ]}
            comments={[
              {
                at: -2,
                author: "human",
                verb: "opened this issue",
                body: "The public API needs rate limiting before launch.",
              },
              {
                at: HANDOFF + ASK,
                author: "wake",
                meta: "implement · claude",
                chip: { tone: "info", text: "Needs clarification" },
                body: "Should limits apply per tenant or globally?",
                footer: "Reply on this thread to continue.",
              },
              {
                at: HANDOFF + REPLY,
                author: "human",
                body: "Per tenant, 100 req/min.",
                typeFor: 22,
              },
              {
                at: HANDOFF + RESUME,
                author: "wake",
                meta: "implement · claude",
                chip: { tone: "good", text: "Done" },
                body: "Opened PR #423 with per-tenant limits.",
              },
            ]}
          />
          <LoopedIn amount={looped} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** Callout that names the moment a human is brought into the loop. */
const LoopedIn: React.FC<{ readonly amount: number }> = ({ amount }) => {
  const { u } = useLayout();
  if (amount <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        right: 28 * u,
        top: 28 * u,
        display: "flex",
        alignItems: "center",
        gap: 12 * u,
        padding: `${12 * u}px ${22 * u}px`,
        borderRadius: 999,
        background: color.accentLight,
        color: color.surface,
        fontFamily: font.sans,
        fontWeight: 700,
        fontSize: 28 * u,
        boxShadow: `0 ${16 * u}px ${40 * u}px rgb(0 0 0 / 0.45), 0 0 ${40 * u}px rgb(94 234 212 / 0.5)`,
        opacity: amount,
        scale: interpolate(amount, [0, 1], [0.7, 1]),
        translate: `0px ${interpolate(amount, [0, 1], [-16 * u, 0])}px`,
      }}
    >
      <svg
        width={30 * u}
        height={30 * u}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
      </svg>
      Human looped in
    </div>
  );
};
