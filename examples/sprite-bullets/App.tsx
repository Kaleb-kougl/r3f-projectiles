/**
 * Sprite bullets — pixel-art projectiles that point where they fly, with a
 * dark outline for readability. No binary assets: every texture is drawn into
 * a 16×16 canvas at startup.
 *
 * Three fields, one per look (one field, one material):
 *
 * - **Arrows** — `bulletGeometry.quad()` + an alpha-tested sprite texture,
 *   `orient="velocity"`, and an outline that dilates the sprite's own alpha
 *   (`'alpha'` mode, picked automatically because the material has a `map`
 *   and `alphaTest`). The texture is white, so `mod.color` tints it.
 * - **Shards** — `bulletGeometry.diamond()`, flat-shaded, `orient="velocity"`,
 *   outlined by extruding the shape's mitred edges (`'extrude'` mode).
 * - **Orbs** — a round sprite on a quad with `orient="camera"`: billboards
 *   that face the camera, outlined like the arrows.
 *
 * The camera is the one a top-down pixel-art ARPG would use: orthographic,
 * 45° yaw, 55° pitch, rendering into a 480×270 buffer scaled up with
 * nearest-neighbour filtering.
 *
 * ```bash
 * npm run dev:sprites
 * ```
 */

import { useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { CanvasTexture, NearestFilter, SRGBColorSpace, type Texture } from 'three';
import {
  BulletField,
  Emitter,
  bulletGeometry,
  gen,
  mod,
  compose,
} from '@k9kbdev/r3f-projectiles';

// ---------------------------------------------------------------------------
// Generated pixel-art textures
// ---------------------------------------------------------------------------

/**
 * Paint a 16×16 sprite from a character map: `#` is the white core, `+` a
 * light-grey shade (so the tint has some depth), anything else transparent.
 * Art points RIGHT — `+X`, the bullet's forward — per the geometry convention.
 */
function spriteTexture(rows: string[]): Texture {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '#') ctx.fillStyle = '#ffffff';
      else if (ch === '+') ctx.fillStyle = '#b8b8b8';
      else return;
      ctx.fillRect(x, y, 1, 1);
    });
  });
  const tex = new CanvasTexture(canvas);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

const ARROW = [
  '................',
  '................',
  '................',
  '..........#.....',
  '..........##....',
  '..........###...',
  '.+........####..',
  '.+++++++++#####.',
  '.+++++++++#####.',
  '.+........####..',
  '..........###...',
  '..........##....',
  '..........#.....',
  '................',
  '................',
  '................',
];

const ORB = [
  '................',
  '................',
  '................',
  '................',
  '......####......',
  '.....######.....',
  '....###++###....',
  '....##++++##....',
  '....##++++##....',
  '....###++###....',
  '.....######.....',
  '......####......',
  '................',
  '................',
  '................',
  '................',
];

// ---------------------------------------------------------------------------
// Patterns — headings sweep a little every shot, so trajectories fan out
// ---------------------------------------------------------------------------

const MAGENTA = 0xff2bd6;
const ORANGE = 0xff8a1f;
const AMBER = 0xffc23a;

let arrowHeading = 0;
const arrowVolley = () => {
  arrowHeading += 0.35;
  return compose(gen.arc(7, Math.PI / 2, 3.2, arrowHeading), mod.color(MAGENTA));
};

let shardHeading = Math.PI;
const shardSpiral = () => {
  shardHeading -= 0.22;
  return compose(gen.arc(5, Math.PI / 3, 2.4, shardHeading), mod.color(ORANGE));
};

const orbRing = () => compose(gen.ring(10, 1.4), mod.color(AMBER), mod.scale(1.2));

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

/** The outline every field shares: GDD — hot cores, dark rim. */
const OUTLINE = { color: 0x1a0612, width: 0.07 } as const;

function Bullets() {
  // Geometry and textures are OURS, not the field's: built once, disposed here.
  const quad = useMemo(() => bulletGeometry.quad(), []);
  const shard = useMemo(() => bulletGeometry.diamond({ width: 0.38 }), []);
  const arrowTex = useMemo(() => spriteTexture(ARROW), []);
  const orbTex = useMemo(() => spriteTexture(ORB), []);
  useEffect(
    () => () => {
      quad.dispose();
      shard.dispose();
      arrowTex.dispose();
      orbTex.dispose();
    },
    [quad, shard, arrowTex, orbTex],
  );

  return (
    <>
      <BulletField
        maxBullets={600}
        bulletRadius={0.42}
        fadeTime={0.3}
        geometry={quad}
        orient="velocity"
        outline={OUTLINE}
        material={<meshBasicMaterial map={arrowTex} alphaTest={0.5} transparent={false} fog={false} />}
      >
        <Emitter pattern={arrowVolley} fireRate={3} spawnCenterY={0.3} rotationSpeed={0.9} />
      </BulletField>

      <BulletField
        maxBullets={600}
        bulletRadius={0.3}
        fadeTime={0.3}
        geometry={shard}
        orient="velocity"
        outline={OUTLINE}
      >
        <Emitter pattern={shardSpiral} fireRate={4} spawnCenterY={0.25} rotationSpeed={-0.7} />
      </BulletField>

      <BulletField
        maxBullets={300}
        bulletRadius={0.3}
        fadeTime={0.4}
        geometry={quad}
        orient="camera"
        outline={OUTLINE}
        material={<meshBasicMaterial map={orbTex} alphaTest={0.5} fog={false} />}
      >
        <Emitter pattern={orbRing} fireRate={0.8} spawnCenterY={0.6} rotationSpeed={0} />
      </BulletField>
    </>
  );
}

/** 45° yaw, 55° pitch, looking at the origin. */
const YAW = Math.PI / 4;
const PITCH = (55 * Math.PI) / 180;
const DIST = 20;
const CAMERA_POSITION: [number, number, number] = [
  Math.sin(YAW) * Math.cos(PITCH) * DIST,
  Math.sin(PITCH) * DIST,
  Math.cos(YAW) * Math.cos(PITCH) * DIST,
];

export default function App() {
  return (
    <div style={{ width: 960, height: 540, margin: '0 auto', background: '#000' }}>
      <Canvas
        orthographic
        dpr={0.5}
        gl={{ antialias: false }}
        style={{ imageRendering: 'pixelated' }}
        camera={{ position: CAMERA_POSITION, zoom: 60, near: 0.1, far: 100 }}
        onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
      >
        <color attach="background" args={['#14121c']} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
          <planeGeometry args={[40, 40]} />
          <meshBasicMaterial color="#2a2f3a" />
        </mesh>
        <gridHelper args={[40, 40, '#3b4352', '#323946']} />
        <Bullets />
      </Canvas>
    </div>
  );
}
