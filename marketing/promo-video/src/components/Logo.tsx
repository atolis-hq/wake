import React from "react";
import { color } from "../theme";

type Props = {
  readonly size: number;
  /** 0 = nothing drawn, 1 = full mark. Arcs sweep, then the wake line draws. */
  readonly draw: number;
  /** 0..1 extra halo intensity for the centre rings. */
  readonly glow?: number;
  readonly style?: React.CSSProperties;
};

const clamp = (v: number) => Math.max(0, Math.min(1, v));

// Geometry copied from assets/wake-logo.svg.
export const Logo: React.FC<Props> = ({ size, draw, glow = 0, style }) => {
  const sweep = clamp(draw / 0.7);
  const minor = clamp((draw - 0.25) / 0.45);
  const wake = clamp((draw - 0.45) / 0.55);
  const dash = (p: number) => ({
    pathLength: 1,
    strokeDasharray: 1,
    strokeDashoffset: 1 - p,
  });

  return (
    <svg
      viewBox="0 0 110 110"
      width={size}
      height={size}
      style={{ overflow: "visible", ...style }}
    >
      <g transform="translate(55 55)">
        <circle r="54" fill="none" stroke={color.brand} opacity={0.1 * sweep} />
        <path
          d="M-42.5-11.5 A44 44 0 1 0 42.5-11.5"
          fill="none"
          stroke={color.accent}
          strokeWidth="7.5"
          strokeLinecap="round"
          {...dash(sweep)}
          opacity={sweep > 0 ? 1 : 0}
        />
        <path
          d="M-36-25.2 A44 44 0 0 1-25.2-36"
          fill="none"
          stroke={color.accentLight}
          strokeWidth="7.5"
          strokeLinecap="round"
          {...dash(minor)}
          opacity={minor > 0 ? 1 : 0}
        />
        <path
          d="M25.2-36 A44 44 0 0 1 36-25.2"
          fill="none"
          stroke={color.accentLight}
          strokeWidth="7.5"
          strokeLinecap="round"
          {...dash(minor)}
          opacity={minor > 0 ? 1 : 0}
        />
        <circle
          r={25 + glow * 6}
          fill={color.accent}
          opacity={(0.08 + glow * 0.1) * wake}
        />
        <circle r="11" fill={color.accent} opacity={0.25 * wake} />
        <path
          d="M-18 23 C-9 22 -8 2 0-2 C8 2 9 22 18 23"
          fill="none"
          stroke={color.accent}
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          {...dash(wake)}
          opacity={wake > 0 ? 1 : 0}
        />
      </g>
    </svg>
  );
};
