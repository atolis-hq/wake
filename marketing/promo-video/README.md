# Wake promo video

A 30-second looping promo built with [Remotion](https://www.remotion.dev/).
This is a standalone project with its own dependencies; it is not part of the
Wake npm workspace and is excluded from Wake's lint, format, and build.

```bash
npm install
npm run dev          # Remotion Studio preview
npm run render       # out/wake-promo-4x5.mp4 and out/wake-promo-16x9.mp4
npx remotion still Promo-4x5 out/frame.png --frame=60   # single frame
```

## Music

The soundtrack is "Fun Life" by FASSounds from Pixabay (Pixabay Content
License: free for commercial use, no attribution required, but the file must not be
redistributed on its own). It is therefore not committed. Before rendering, download it:

```bash
mkdir -p public/music
curl -L -o public/music/fun-life.mp3 \
  "https://cdn.pixabay.com/download/audio/2022/05/27/audio_ed655fa73a.mp3?filename=fassounds-fun-life-upbeat-commercial-hiphop-112188.mp3"
```

Render a silent version with `--props='{"music":false}'`.

## Repo README media

The Wake README embeds a GIF preview linking to the full MP4, both in
`docs/media/` (GitHub strips `<video>` tags from READMEs, and only web-uploaded
attachments get a player). Regenerate them after changing the video:

```bash
npx remotion render Promo-16x9 ../../docs/media/wake-promo.mp4
npx remotion render Promo-16x9 ../../docs/media/wake-promo-preview.gif \
  --codec=gif --every-nth-frame=3 --scale=0.5 --props='{"music":false,"ambient":false}'
```

`ambient: false` freezes the backdrop pulse and drift so the GIF stays around 8 MB.

## Compositions

| ID | Size | Use |
| --- | --- | --- |
| `Promo-4x5` | 1080x1350 | LinkedIn and Reddit feeds (primary) |
| `Promo-16x9` | 1920x1080 | Reddit desktop, README, website |
| `Scenes/*` | 1080x1350 | Individual scenes for editing in isolation |

Both promo compositions share the same scenes; layout switches on aspect ratio.
The last frame matches the first so the picture loops seamlessly (the music restarts). For a clean
closing card on platforms that do not loop, use frame 60 (logo and tagline).

## Beats (30fps, ~34.8s)

Scene cuts are timed to the music's beat grid (125.66 BPM, first beat at 0.399s;
see `DURATIONS` and `beatPulse` in `src/Promo.tsx`), and the backdrop pulses on
each beat. Changing the track means re-measuring the grid and retiming `DURATIONS`.

1. Opening: "Wake never sleeps." (logo, loop seam)
2. 01 Start in GitHub: create an issue, assign Wake, add the `dark-factory` label
3. 02 Routing: issues match workflow selectors and queue into their workflows
4. 03 Dark factory: refine, plan review, implement, PR review, merge, all on the issue
5. 04 Human in the loop: Wake asks on the issue, a human replies, Wake carries on
6. 05 Runners: a CLI hits its usage limit and the activation fails over within the pool
7. 06 Control plane: the board, with work items moving between columns
8. Outro: converges back to the logo

## Conventions

- Colours mirror `src/surfaces/web/src/styles/tokens.css`; Wake surfaces are dark.
- External systems (the GitHub-like issues) use a distinct light theme and font so
  they read as "not Wake".
- Fonts load with the Latin subset only; avoid emoji and symbol glyphs (they crash
  or render as tofu in headless Chrome). Draw icons as inline SVG.
- Content should stay accurate to Wake's behaviour: stage names, labels, runner
  pools, and comment wording come from the running config and
  `src/integrations/github/application/agent-run-comment.ts`.
- Remotion is free for individuals and companies of up to 3 people; larger
  companies need a company licence.

Agent skills for this project are not committed; restore them with
`npx remotion skills add` (versions pinned in `skills-lock.json`).
