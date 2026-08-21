import { createHash } from 'node:crypto';

/**
 * Per-player composition, derived from the name.
 *
 * The problem this solves: pose comes from position and colour comes from nation, so
 * every Brazilian midfielder was rendering identically. In a grid of 180 that reads as
 * a bug, not as a system.
 *
 * The line this does NOT cross: nothing here invents an attribute of a real person. No
 * skin tone, no build, no hair, no face — those would be fabricated claims about
 * identifiable people, which is the whole reason the art is anonymous in the first
 * place. What varies instead is *staging*: the light behind the figure, which way they
 * face, how large they sit in the frame, an accent colour, the motion. Two players in
 * the same kit and position end up with visibly different tiles and neither tile says
 * anything untrue about either of them.
 *
 * Everything is a pure function of the name, so a player's tile is stable across
 * sessions and across installs — a picture that changes every reload is worse than a
 * repeated one, because you stop being able to recognise your own collection.
 */

export type Backdrop = 'spotlight' | 'rays' | 'arc' | 'band' | 'halo' | 'grid';

export interface AvatarStyle {
  backdrop: Backdrop;
  /** Accent hue for the backdrop, as a hex string. */
  accent: string;
  /** Face the other way. Doubles the apparent variety for free. */
  mirror: boolean;
  /** 0.92-1.06 — how large the figure sits in the frame. */
  scale: number;
  /** Small vertical offset, so heads do not all line up in a grid. */
  offsetY: number;
  /** Motion speed multiplier, so a row of tiles does not pulse in lockstep. */
  tempo: number;
  /** Animation phase offset in seconds, same reason. */
  delay: number;
  /** The marquee treatment: rays, a warm rim, a slightly larger figure. */
  iconic: boolean;
}

/**
 * Accent palette. Deliberately low-chroma: these sit *behind* a kit-coloured field and
 * must not fight it, or the nation stops being readable — which is the one thing the
 * avatar has to communicate.
 */
const ACCENTS = [
  '#ffffff', '#ffe9b0', '#cfe8ff', '#ffd9e2', '#d8ffe4', '#e6dcff', '#fff2cc', '#d6f4ff',
];

const BACKDROPS: Backdrop[] = ['spotlight', 'rays', 'arc', 'band', 'halo', 'grid'];

/** Stable 32-bit-ish digest of a name, so every field below is deterministic. */
function digest(name: string): number[] {
  const h = createHash('sha1').update(name.trim().toLowerCase()).digest();
  return [...h];
}

export function avatarStyle(name: string, opts: { iconic?: boolean } = {}): AvatarStyle {
  const d = digest(name || 'unknown');
  const at = (i: number) => d[i % d.length]!;

  const iconic = opts.iconic === true;
  return {
    // An icon always gets rays; everyone else gets one of the six.
    backdrop: iconic ? 'rays' : BACKDROPS[at(0) % BACKDROPS.length]!,
    accent: iconic ? '#ffe9b0' : ACCENTS[at(1) % ACCENTS.length]!,
    mirror: at(2) % 2 === 0,
    scale: (iconic ? 1.04 : 0.94) + (at(3) % 9) / 100,
    offsetY: (at(4) % 13) - 6,
    tempo: 0.82 + (at(5) % 45) / 100,
    // Spread the phase across three seconds. Without this a scrolled grid breathes in
    // unison, which looks mechanical rather than alive.
    delay: -((at(6) % 30) / 10),
    iconic,
  };
}

/**
 * The backdrop, drawn between the kit field and the figure.
 *
 * All six are built from two or three shapes at low opacity. They have to survive being
 * 96px wide in a dense grid, so nothing here is fine detail.
 */
export function backdropSvg(s: AvatarStyle, uid: string): string {
  const a = s.accent;
  switch (s.backdrop) {
    case 'rays': {
      const rays = Array.from({ length: 12 }, (_, i) => {
        const ang = (i * 30) + (s.mirror ? 15 : 0);
        return `<rect x="148" y="-160" width="4.5" height="320" fill="${a}" fill-opacity="0.5"
                  transform="rotate(${ang} 150 130)"/>`;
      }).join('');
      return `<g opacity="0.22" class="bd${uid}">${rays}</g>`
        + `<circle cx="150" cy="130" r="52" fill="${a}" fill-opacity="0.14"/>`;
    }
    case 'spotlight':
      return `<ellipse cx="150" cy="118" rx="118" ry="104" fill="${a}" fill-opacity="0.15"/>`
        + `<ellipse cx="150" cy="262" rx="96" ry="16" fill="#000" fill-opacity="0.18"/>`;
    case 'arc':
      return `<circle cx="150" cy="176" r="104" fill="none" stroke="${a}"
                stroke-opacity="0.28" stroke-width="12"/>`
        + `<circle cx="150" cy="176" r="132" fill="none" stroke="${a}"
                stroke-opacity="0.12" stroke-width="6"/>`;
    case 'band':
      return `<g transform="rotate(${s.mirror ? -18 : 18} 150 150)">
                <rect x="-60" y="112" width="420" height="46" fill="${a}" fill-opacity="0.16"/>
                <rect x="-60" y="168" width="420" height="14" fill="${a}" fill-opacity="0.10"/>
              </g>`;
    case 'halo':
      return `<circle cx="150" cy="104" r="66" fill="${a}" fill-opacity="0.17"/>`
        + `<circle cx="150" cy="104" r="66" fill="none" stroke="${a}" stroke-opacity="0.3" stroke-width="3"/>`;
    case 'grid': {
      const lines = Array.from({ length: 7 }, (_, i) =>
        `<rect x="0" y="${28 + i * 38}" width="300" height="2" fill="${a}" fill-opacity="0.13"/>`).join('');
      return `<g>${lines}</g>`;
    }
  }
}

/**
 * Idle motion, per pose, expressed as whole-figure transforms.
 *
 * Only the whole figure moves, because there is one silhouette path per pose — no
 * rigging, no joints. That constraint is doing real work: a bob, a lean, a glide read as
 * life at 96px, where a fake articulated limb would read as broken.
 *
 * The CSS lives INSIDE the SVG. That matters because these are served to `<img>` tags,
 * where a stylesheet from the page cannot reach them, but a `<style>` element within the
 * document can — and the reduced-motion query inside it is still honoured by the
 * browser, so the accessibility switch works without any page co-operation.
 */
export function motionCss(pose: string, s: AvatarStyle, uid: string): string {
  const dur = (base: number) => (base / s.tempo).toFixed(2);
  const K: Record<string, { frames: string; dur: string }> = {
    standing:    { frames: '0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}', dur: dur(3.4) },
    walking:     { frames: '0%,100%{transform:translate(-3px,0) rotate(-1deg)}50%{transform:translate(3px,-4px) rotate(1deg)}', dur: dur(2.4) },
    running:     { frames: '0%,100%{transform:translate(-6px,1px) rotate(-2.5deg)}50%{transform:translate(6px,-5px) rotate(2deg)}', dur: dur(1.5) },
    striking:    { frames: '0%,72%,100%{transform:rotate(0)}84%{transform:rotate(-7deg)}', dur: dur(2.6) },
    celebrating: { frames: '0%,100%{transform:scale(1) translateY(0)}45%{transform:scale(1.045) translateY(-8px)}', dur: dur(2.2) },
    sliding:     { frames: '0%{transform:translateX(-16px)}70%,100%{transform:translateX(10px)}', dur: dur(3) },
    diving:      { frames: '0%{transform:translate(-14px,10px) rotate(4deg)}65%,100%{transform:translate(8px,-6px) rotate(-2deg)}', dur: dur(2.8) },
    heading:     { frames: '0%,100%{transform:translateY(0) rotate(0)}40%{transform:translateY(-7px) rotate(-2deg)}', dur: dur(2.6) },
  };
  const k = K[pose] ?? K.standing!;
  return `<style>
    @keyframes f${uid}{${k.frames}}
    .fg${uid}{animation:f${uid} ${k.dur}s ease-in-out ${s.delay}s infinite;
      transform-origin:150px 210px;transform-box:view-box}
    @keyframes r${uid}{to{transform:rotate(360deg)}}
    .bd${uid}{animation:r${uid} ${(46 / s.tempo).toFixed(0)}s linear infinite;
      transform-origin:150px 130px;transform-box:view-box}
    @media (prefers-reduced-motion:reduce){
      .fg${uid},.bd${uid}{animation:none}
    }
  </style>`;
}
