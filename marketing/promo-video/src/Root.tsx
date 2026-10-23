import React from "react";
import { Composition, Folder } from "remotion";
import { Promo, PROMO_FRAMES, withBackdrop } from "./Promo";
import { ControlPlane } from "./scenes/ControlPlane";
import { CreateIssue } from "./scenes/CreateIssue";
import { Failover } from "./scenes/Failover";
import { Opening } from "./scenes/Opening";
import { Outro } from "./scenes/Outro";
import { Signals } from "./scenes/Signals";
import { Threads } from "./scenes/Threads";

const FPS = 30;
// 4:5 is the main feed format for LinkedIn and Reddit mobile; 16:9 for desktop, README, and site.
const PORTRAIT = { width: 1080, height: 1350 };
const LANDSCAPE = { width: 1920, height: 1080 };

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Promo-4x5"
        component={Promo}
        durationInFrames={PROMO_FRAMES}
        fps={FPS}
        {...PORTRAIT}
      />
      <Composition
        id="Promo-16x9"
        component={Promo}
        durationInFrames={PROMO_FRAMES}
        fps={FPS}
        {...LANDSCAPE}
      />
      <Folder name="Scenes">
        <Composition id="CreateIssue" component={withBackdrop(CreateIssue)} durationInFrames={154} fps={FPS} {...PORTRAIT} />
        <Composition
          id="Opening"
          component={withBackdrop(Opening)}
          durationInFrames={74}
          fps={FPS}
          {...PORTRAIT}
        />
        <Composition
          id="Signals"
          component={withBackdrop(Signals)}
          durationInFrames={138}
          fps={FPS}
          {...PORTRAIT}
        />
        <Composition
          id="Failover"
          component={withBackdrop(Failover)}
          durationInFrames={153}
          fps={FPS}
          {...PORTRAIT}
        />
        <Composition
          id="Threads"
          component={withBackdrop(Threads)}
          durationInFrames={369}
          fps={FPS}
          {...PORTRAIT}
        />
        <Composition
          id="ControlPlane"
          component={withBackdrop(ControlPlane)}
          durationInFrames={124}
          fps={FPS}
          {...PORTRAIT}
        />
        <Composition
          id="Outro"
          component={withBackdrop(Outro)}
          durationInFrames={91}
          fps={FPS}
          {...PORTRAIT}
        />
      </Folder>
    </>
  );
};
