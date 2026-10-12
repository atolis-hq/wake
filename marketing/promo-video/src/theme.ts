import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadNoto } from "@remotion/google-fonts/NotoSans";
import { Easing, interpolate, useVideoConfig } from "remotion";

// Mirrors src/surfaces/web/src/styles/tokens.css so the promo matches the UI.
export const color = {
  surface: "#14161a",
  panel: "#1a1d23",
  card: "#22262e",
  inset: "#2c313a",
  border: "#2c313a",
  ink: "#e8e8e8",
  muted: "#9aa0a8",
  brand: "#0f766e",
  accent: "#2dd4bf",
  accentLight: "#5eead4",
  good: "#7fe3a3",
  active: "#c79bff",
  bad: "#ff8a8a",
} as const;

// External systems use a GitHub-like light theme so they read as "not Wake".
export const gh = {
  canvas: "#ffffff",
  subtle: "#f6f8fa",
  border: "#d0d7de",
  ink: "#1f2328",
  muted: "#656d76",
  link: "#0969da",
  open: "#1a7f37",
  closed: "#8250df",
  wakeBadge: "#0f766e",
} as const;

export const font = {
  github: loadNoto("normal", {
    weights: ["400", "600", "700"],
    subsets: ["latin"],
  }).fontFamily,
  sans: loadInter("normal", {
    weights: ["400", "500", "600", "700", "800"],
    subsets: ["latin"],
  }).fontFamily,
  mono: loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] })
    .fontFamily,
};

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** 0→1 progress between two frames with an expressive ease-out. */
export const progress = (
  frame: number,
  start: number,
  end: number,
  easing = easeOut,
) =>
  interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

/** Layout helper: both formats share a 1080px short edge, so units stay 1:1. */
export const useLayout = () => {
  const { width, height } = useVideoConfig();
  const portrait = height >= width;
  return { width, height, portrait, u: Math.min(width, height) / 1080 };
};
