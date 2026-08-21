/**
 * Eight reusable, anonymous football poses.
 *
 * The whole point of this file is that 1,771 cards need eight pieces of art, not
 * 1,771. Nothing here identifies a person: no face, no facial features, no name,
 * no crest, no kit number. A pose is pure geometry with no paint attributes, so the
 * caller decides the colours — which is what lets one pose serve every nation.
 *
 * Geometry is authored in a 300×300 box with the figure inside y ∈ [30, 250]. The
 * bottom 50px stays clear because the tile lays a name over it; a pictogram whose
 * legs disappear under a caption looks broken rather than cropped.
 *
 * Each pose is emitted twice by `figureSvg`: once fatter in a rim colour, once in
 * the ink colour. That is how a flat figure keeps an edge over Croatia's checks or
 * Paraguay's stripes — a single flat fill has no edge anywhere the field changes.
 */

import { createHash } from 'node:crypto';
import { TRACED_POSES, TRACED_AVAILABLE, type TracedPose } from './poses-art.js';

export type PoseName =
  | 'standing' | 'walking' | 'running' | 'striking'
  | 'celebrating' | 'sliding' | 'diving' | 'heading';

export const POSE_NAMES: PoseName[] = [
  'standing', 'walking', 'running', 'striking',
  'celebrating', 'sliding', 'diving', 'heading',
];

/** Human label, for the UI and for `/api/poses`. */
export const POSE_LABELS: Record<PoseName, string> = {
  standing: 'Standing',
  walking: 'Walking',
  running: 'Running',
  striking: 'Striking a ball',
  celebrating: 'Celebrating',
  sliding: 'Sliding tackle',
  diving: 'Goalkeeper dive',
  heading: 'Heading',
};

/**
 * Geometry only — no fill, no stroke, no colour. `head` is drawn as a disc and the
 * `lines` are drawn as thick round-capped strokes, so one description works for both
 * the rim pass and the ink pass.
 */
interface Pose {
  head: { cx: number; cy: number; r: number };
  lines: string[];
  /** A ball, when the pose is about one. */
  ball?: { cx: number; cy: number; r: number };
}

const POSES: Record<PoseName, Pose> = {
  // Neutral default. Used whenever the position is unknown — it asserts nothing.
  standing: {
    head: { cx: 150, cy: 74, r: 21 },
    lines: [
      'M150 102 V 178',
      'M150 120 L 114 166', 'M150 120 L 186 166',
      'M150 178 L 130 246', 'M150 178 L 170 246',
    ],
  },

  walking: {
    head: { cx: 152, cy: 74, r: 21 },
    lines: [
      'M150 102 V 176',
      'M150 120 L 118 156', 'M150 120 L 182 170',
      'M150 176 L 132 210 L 114 240',
      'M150 176 L 176 214 L 196 234',
    ],
  },

  running: {
    head: { cx: 168, cy: 70, r: 21 },
    lines: [
      'M164 98 L 146 174',
      'M162 116 L 122 98',            // lead arm, up and forward
      'M162 116 L 196 146',           // trailing arm, back
      'M146 174 L 186 196 L 176 236', // lead leg, knee up
      'M146 174 L 112 204 L 128 240', // trailing leg, pushing off
    ],
  },

  striking: {
    head: { cx: 132, cy: 76, r: 21 },
    lines: [
      'M132 104 L 142 176',
      'M134 122 L 96 108', 'M134 122 L 172 144',
      'M142 176 L 132 246',           // planted leg
      'M142 176 L 190 202 L 228 194', // striking leg
    ],
    ball: { cx: 252, cy: 194, r: 15 },
  },

  celebrating: {
    // Hands have to clear the head with daylight between them. Ending the arms at
    // head height merges hands and head into one blob.
    head: { cx: 150, cy: 88, r: 21 },
    lines: [
      'M150 116 V 182',
      'M150 130 L 100 48', 'M150 130 L 200 48',
      'M150 182 L 126 248', 'M150 182 L 174 248',
    ],
  },

  sliding: {
    // No ball in this one. With one, the extended boot and the ball merge into a
    // single lump at this size and the pose stops reading as a tackle at all.
    head: { cx: 70, cy: 136, r: 21 },
    lines: [
      'M96 148 L 168 180',            // torso, low and angled
      'M104 150 L 126 104',           // arm up for balance, clear of the head
      'M168 180 L 254 166',           // leg extended through the tackle
      'M168 180 L 198 220 L 240 224', // trailing leg tucked under
    ],
  },

  diving: {
    head: { cx: 122, cy: 128, r: 21 },
    lines: [
      'M142 144 L 198 194',
      'M142 144 L 106 100',           // both arms toward the ball
      'M142 144 L 166 92',
      'M198 194 L 250 214',
      'M198 194 L 212 244',
    ],
    ball: { cx: 190, cy: 50, r: 16 },
  },

  heading: {
    // The ball sits off to one side: directly above the head it reads as a second
    // head, which is the sort of thing you only see once it is on screen.
    head: { cx: 138, cy: 84, r: 21 },
    lines: [
      'M140 112 V 178',
      'M140 128 L 96 142', 'M140 128 L 186 118',
      'M140 178 L 118 246',
      'M140 178 L 174 212 L 198 234',
    ],
    ball: { cx: 196, cy: 56, r: 15 },
  },
};

/**
 * Map a position to a pose.
 *
 * Deliberately conservative: an unrecognised or missing position gives `standing`
 * rather than a guess. A defender drawn diving looks like a bug, and inventing a
 * position from a name would be worse than showing a neutral figure.
 */
export function poseForPosition(position?: string | null): PoseName {
  const p = (position ?? '').toLowerCase();
  if (!p) return 'standing';
  if (/goal\s?keep|keeper|\bgk\b|portero|gardien/.test(p)) return 'diving';
  if (/forward|striker|centre[- ]forward|center[- ]forward|attacker|second striker/.test(p)) return 'striking';
  if (/winger|wing[- ]?forward|\bwing\b/.test(p)) return 'running';
  if (/midfield/.test(p)) return 'walking';
  if (/back|defender|sweeper|libero/.test(p)) return 'sliding';
  return 'standing';
}

/** Every position string we recognise, for the docs and for tests. */
export const POSITION_EXAMPLES = [
  'goalkeeper', 'centre-back', 'left-back', 'right-back', 'defender',
  'defensive midfielder', 'midfielder', 'attacking midfielder',
  'winger', 'forward', 'centre-forward', 'striker',
] as const;

/**
 * Which art family draws the figures.
 *
 *   'geometry'  the hand-authored pictograms in this file — thick round-capped strokes
 *   'traced'    silhouettes traced from a generated pose sheet (src/media/poses-art.ts)
 *
 * Both live in the same 300x300 band with the same pose names, so this is a one-word
 * switch and nothing downstream changes. `POSE_ART=geometry` in the environment picks
 * the built-ins back up.
 */
export type PoseFamily = 'geometry' | 'traced';
export const DEFAULT_FAMILY: PoseFamily =
  (process.env.POSE_ART as PoseFamily) === 'geometry' ? 'geometry'
  : TRACED_AVAILABLE.length ? 'traced' : 'geometry';

/**
 * A traced silhouette, painted with the same rim-underneath trick as the geometry: the
 * outline is the same path drawn fatter beneath the fill. Without it the figure vanishes
 * wherever a two-tone kit changes colour.
 */
function tracedSvg(t: TracedPose, ink: string, rim: string, opacity: number): string {
  // The path is emitted once and referenced twice. Inlining it twice doubled the biggest
  // string in the file, and with 318 avatars inlined side by side in the offline preview
  // that was most of a megabyte for no visual difference.
  const id = 'p' + createHash('sha1').update(t.d).digest('hex').slice(0, 8);
  return `<g opacity="${opacity}" transform="${t.transform}">`
    + `<defs><path id="${id}" d="${t.d}"/></defs>`
    + `<use href="#${id}" fill="${rim}" stroke="${rim}" stroke-width="34"`
    + ` stroke-linejoin="round" stroke-linecap="round"/>`
    + `<use href="#${id}" fill="${ink}"/>`
    + `</g>`;
}

/**
 * One pose, painted.
 *
 * @param ink   figure colour
 * @param rim   outline colour, drawn underneath as a fatter copy
 * @param width limb thickness
 */
export function figureSvg(
  pose: PoseName,
  ink: string,
  rim: string,
  opts: { width?: number; opacity?: number; family?: PoseFamily } = {},
): string {
  const family = opts.family ?? DEFAULT_FAMILY;
  if (family === 'traced') {
    const traced = TRACED_POSES[pose];
    // Falls through to the built-in geometry when a traced pose is missing, so a partial
    // import degrades to the hand-authored figure rather than to an empty tile.
    if (traced) return tracedSvg(traced, ink, rim, opts.opacity ?? 0.58);
  }
  const p = POSES[pose] ?? POSES.standing;
  const w = opts.width ?? 21;
  const opacity = opts.opacity ?? 0.58;

  const geom = (grow: number) => {
    const parts = [
      `<circle cx="${p.head.cx}" cy="${p.head.cy}" r="${p.head.r + grow / 2}"/>`,
      ...p.lines.map((d) => `<path d="${d}"/>`),
    ];
    if (p.ball) parts.push(`<circle cx="${p.ball.cx}" cy="${p.ball.cy}" r="${p.ball.r + grow / 2}"/>`);
    return parts.join('');
  };

  // The rim pass is the same geometry, fatter, underneath. Cheaper and more reliable
  // than stroking each shape: a stroke on a stroked limb is not a thing.
  //
  // Both passes are opaque and the transparency is applied once to the pair. Fading
  // each pass separately lets the rim show through the ink, which turns every head
  // and ball into a ring — obvious on screen, invisible in the code.
  const pass = (colour: string, grow: number) =>
    `<g fill="${colour}" stroke="${colour}" stroke-width="${w + grow}"` +
    ` stroke-linecap="round" stroke-linejoin="round">${geom(grow)}</g>`;
  return `<g opacity="${opacity}">${pass(rim, 8)}${pass(ink, 0)}</g>`;
}
