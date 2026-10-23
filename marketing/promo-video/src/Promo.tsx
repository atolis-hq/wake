import React from "react";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Audio } from "@remotion/media";
import { AbsoluteFill, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ControlPlane } from "./scenes/ControlPlane";
import { CreateIssue } from "./scenes/CreateIssue";
import { Failover } from "./scenes/Failover";
import { Opening } from "./scenes/Opening";
import { Outro } from "./scenes/Outro";
import { Signals } from "./scenes/Signals";
import { Threads } from "./scenes/Threads";
import { color, font } from "./theme";

const FADE = 10;

type Durations = {
  readonly opening: number;
  readonly create: number;
  readonly signals: number;
  readonly threads: number;
  readonly failover: number;
  readonly controlPlane: number;
  readonly outro: number;
};

// Beat grid of "Fun Life" (measured: 125.66 BPM, first beat at 0.399s).
const BEAT = (30 * 60) / 125.66;
const FIRST_BEAT = 0.399 * 30;

// Cuts (scene start + half the crossfade) land on beats; section changes on bar downbeats.
const DURATIONS: Durations = {
  opening: 74,
  create: 154,
  signals: 138,
  threads: 369,
  failover: 153,
  controlPlane: 124,
  outro: 91,
};

const total = (d: Durations) =>
  d.opening + d.create + d.signals + d.threads + d.failover + d.controlPlane + d.outro - 6 * FADE;

export const PROMO_FRAMES = total(DURATIONS);

/** 1 on each beat decaying to 0; downbeats hit harder. */
const beatPulse = (frame: number) => {
  if (frame < FIRST_BEAT) return 0;
  const n = Math.floor((frame - FIRST_BEAT) / BEAT);
  const since = frame - FIRST_BEAT - n * BEAT;
  return Math.exp(-since / 4) * (n % 4 === 0 ? 1 : 0.55);
};

/** Constant backdrop under every scene so crossfades never flash. */
const Backdrop: React.FC<{ readonly length: number; readonly pulse?: number; readonly still?: boolean }> = ({
  length,
  pulse = 0,
  still = false,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const drift = still ? 0 : interpolate(frame, [0, length], [0, 1]);
  return (
    <AbsoluteFill style={{ background: color.surface }}>
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(rgb(255 255 255 / ${0.05 + pulse * 0.05}) ${1.5 * u}px, transparent ${1.5 * u}px)`,
          backgroundSize: `${36 * u}px ${36 * u}px`,
        }}
      />
      <AbsoluteFill
        style={{
          // Drift resolves back to the start position so the loop seam is clean.
          background: `radial-gradient(60% 45% at ${50 + Math.sin(drift * Math.PI * 2) * 18}% ${45 + Math.cos(drift * Math.PI * 2) * 8}%, rgb(15 118 110 / ${0.28 + pulse * 0.22}), transparent 70%)`,
        }}
      />
    </AbsoluteFill>
  );
};

// Pixabay "Fun Life" by FASSounds; not committed, see README.
const MUSIC = "music/fun-life.mp3";

// `ambient: false` freezes the backdrop so GIF previews compress well.
export const Promo: React.FC<{ readonly music?: boolean; readonly ambient?: boolean }> = ({
  music = true,
  ambient = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const d = DURATIONS;
  const length = PROMO_FRAMES;
  const pulse = ambient ? beatPulse(frame) : 0;
  const downbeat = pulse > 0.9 ? pulse : 0;
  const transition = (
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />
  );
  return (
    <AbsoluteFill style={{ fontFamily: font.sans }}>
      <Backdrop length={length} pulse={pulse} still={!ambient} />
      {music ? (
        <Audio
          src={staticFile(MUSIC)}
          volume={(f) =>
            interpolate(f, [0, 6, length - 45, length - 1], [0, 0.85, 0.85, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          }
        />
      ) : null}
      {/* A small bump on each bar's downbeat. */}
      <AbsoluteFill style={{ scale: 1 + downbeat * 0.006 }}>
        <TransitionSeries>
          <TransitionSeries.Sequence name="Opening" durationInFrames={d.opening} premountFor={fps}>
            <Opening />
          </TransitionSeries.Sequence>
          {transition}
          <TransitionSeries.Sequence name="Create issue" durationInFrames={d.create} premountFor={fps}>
            <CreateIssue />
          </TransitionSeries.Sequence>
          {transition}
          <TransitionSeries.Sequence name="Signals" durationInFrames={d.signals} premountFor={fps}>
            <Signals />
          </TransitionSeries.Sequence>
          {transition}
          <TransitionSeries.Sequence name="Threads" durationInFrames={d.threads} premountFor={fps}>
            <Threads />
          </TransitionSeries.Sequence>
          {transition}
          <TransitionSeries.Sequence name="Failover" durationInFrames={d.failover} premountFor={fps}>
            <Failover />
          </TransitionSeries.Sequence>
          {transition}
          <TransitionSeries.Sequence name="Control plane" durationInFrames={d.controlPlane} premountFor={fps}>
            <ControlPlane />
          </TransitionSeries.Sequence>
          {transition}
          <TransitionSeries.Sequence name="Outro" durationInFrames={d.outro} premountFor={fps}>
            <Outro />
          </TransitionSeries.Sequence>
        </TransitionSeries>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Single scene on the shared backdrop, for previewing scenes in isolation. */
export const withBackdrop = (Scene: React.FC): React.FC => {
  const Wrapped: React.FC = () => (
    <AbsoluteFill style={{ fontFamily: font.sans }}>
      <Backdrop length={PROMO_FRAMES} />
      <Scene />
    </AbsoluteFill>
  );
  return Wrapped;
};
