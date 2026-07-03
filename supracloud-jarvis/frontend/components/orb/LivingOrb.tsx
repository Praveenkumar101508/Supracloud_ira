"use client";

/**
 * LivingOrb — IRA's signature element: one living, audio-reactive orb.
 *
 * Construction (all custom GLSL, rendered through react-three-fiber):
 *   - Surface   : icosphere displaced by 3-octave simplex FBM in the vertex
 *                 shader; fresnel rim + drifting internal scan lines in the
 *                 fragment shader. Audio energy feeds both displacement and
 *                 rim brightness.
 *   - Core      : additive inner sphere whose brightness/scale breathe with
 *                 the state and the live audio level.
 *   - Halo      : back-face fresnel shell that gives bloom something soft to
 *                 pick up beyond the silhouette.
 *   - Tendrils  : one GPU particle system (a single draw call). Particles are
 *                 grouped into coherent "streams" — beaded comet trains that a
 *                 `uFlow` uniform morphs between three behaviours: orbiting
 *                 shell (idle/thinking), accelerating inward streams
 *                 (listening) and erupting outward streams (speaking).
 *   - Post      : EffectComposer + mipmap-blur Bloom whose intensity lerps
 *                 per state for the cinematic glow.
 *
 * Every visual parameter lerps toward per-state targets each frame, so state
 * transitions are continuous — the orb never snaps.
 *
 * Fallbacks: prefers-reduced-motion or missing WebGL renders a static CSS
 * glow instead of the Three.js scene. All GPU resources are created in
 * useMemo and disposed in effect cleanups.
 */

import React, { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";

// ── Public API ────────────────────────────────────────────────────────────────

export type OrbState =
  | "idle" // slow breathing, faint internal glow
  | "listening" // tendrils stream inward, surface rides the waveform
  | "thinking" // tight fast orbit, denser internal structure
  | "speaking" // energy streams outward
  | "success" // calm emerald flash
  | "warning" // amber permission/attention pulse
  | "error"; // soft rose pulse — calm, never strobing

export interface LivingOrbProps {
  /** Behavioural state — drives colour, motion, particle flow. */
  state: OrbState;
  /** Optional external loudness 0..1 (merged with `analyser` if both given). */
  audioLevel?: number;
  /** Live analyser to sample every frame — the highest-quality drive. */
  analyser?: AnalyserNode | null;
  /** Square canvas size in CSS pixels. */
  size?: number;
  /** When false the orb dims toward dormancy without unmounting. */
  isActive?: boolean;
  /** "high" enables bloom + full particle count; "low" halves both. */
  quality?: "high" | "low";
  className?: string;
  onClick?: () => void;
  /** Accessible label; defaults to the current state. */
  ariaLabel?: string;
}

// ── Per-state visual targets (everything lerps toward these) ─────────────────

interface OrbVisualTarget {
  colorA: string; // deep body colour
  colorB: string; // rim / energy colour
  noiseAmp: number; // surface displacement amplitude
  noiseFreq: number; // surface displacement frequency
  timeScale: number; // how fast the surface evolves
  glow: number; // core + surface emissive drive
  scan: number; // internal scan-line intensity
  flow: number; // particles: -1 inward, 0 orbit, +1 outward
  flowSpeed: number; // travel rate along a stream during flow
  spread: number; // particle shell thickness / travel span
  ring: number; // 0 = spherical orbit shell, 1 = flattened equatorial band
  particleAlpha: number;
  bloom: number; // post-processing bloom intensity
  pulseSpeed: number; // breathing rate (rad/s)
  pulseDepth: number; // breathing amplitude (scale units)
}

const STATE_VISUALS: Record<OrbState, OrbVisualTarget> = {
  idle: {
    colorA: "#083344", colorB: "#22d3ee",
    noiseAmp: 0.055, noiseFreq: 2.4, timeScale: 0.35,
    glow: 0.4, scan: 0.22, flow: 0.0, flowSpeed: 0.5, spread: 0.55, ring: 0.3,
    particleAlpha: 0.34, bloom: 0.85, pulseSpeed: 1.4, pulseDepth: 0.02,
  },
  listening: {
    colorA: "#0a3947", colorB: "#67e8f9",
    noiseAmp: 0.085, noiseFreq: 3.0, timeScale: 0.8,
    glow: 0.85, scan: 0.42, flow: -1.0, flowSpeed: 1.3, spread: 1.0, ring: 0.0,
    particleAlpha: 1.0, bloom: 1.25, pulseSpeed: 2.2, pulseDepth: 0.02,
  },
  thinking: {
    colorA: "#241a4d", colorB: "#a78bfa",
    noiseAmp: 0.12, noiseFreq: 4.6, timeScale: 1.5,
    glow: 0.75, scan: 0.9, flow: 0.0, flowSpeed: 1.6, spread: 0.22, ring: 0.85,
    particleAlpha: 0.9, bloom: 1.15, pulseSpeed: 4.2, pulseDepth: 0.014,
  },
  speaking: {
    colorA: "#064e3b", colorB: "#5eead4",
    noiseAmp: 0.1, noiseFreq: 3.2, timeScale: 1.1,
    glow: 1.0, scan: 0.5, flow: 1.0, flowSpeed: 1.4, spread: 1.0, ring: 0.0,
    particleAlpha: 1.0, bloom: 1.5, pulseSpeed: 2.6, pulseDepth: 0.03,
  },
  success: {
    colorA: "#065f46", colorB: "#34d399",
    noiseAmp: 0.03, noiseFreq: 2.0, timeScale: 0.55,
    glow: 1.35, scan: 0.3, flow: 1.0, flowSpeed: 1.1, spread: 1.25, ring: 0.15,
    particleAlpha: 0.9, bloom: 1.75, pulseSpeed: 1.2, pulseDepth: 0.012,
  },
  warning: {
    colorA: "#492c05", colorB: "#fbbf24",
    noiseAmp: 0.07, noiseFreq: 3.4, timeScale: 0.9,
    glow: 0.85, scan: 0.6, flow: 0.0, flowSpeed: 0.8, spread: 0.35, ring: 0.5,
    particleAlpha: 0.6, bloom: 1.15, pulseSpeed: 3.4, pulseDepth: 0.035,
  },
  error: {
    colorA: "#4c1d2e", colorB: "#fda4af",
    noiseAmp: 0.05, noiseFreq: 2.6, timeScale: 0.5,
    glow: 0.55, scan: 0.35, flow: 0.0, flowSpeed: 0.5, spread: 0.45, ring: 0.3,
    particleAlpha: 0.4, bloom: 0.95, pulseSpeed: 2.0, pulseDepth: 0.028,
  },
};

// ── GLSL ──────────────────────────────────────────────────────────────────────

/**
 * 3D simplex noise.
 * Copyright (C) 2011 Ashima Arts (webgl-noise) / Stefan Gustavson.
 * MIT licence — https://github.com/ashima/webgl-noise
 */
const SIMPLEX_NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 3; i++) {
    sum += amp * snoise(p);
    p *= 2.05;
    amp *= 0.5;
  }
  return sum;
}
`;

const SURFACE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uNoiseAmp;
uniform float uNoiseFreq;
uniform float uAudio;

varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vLocalPos;
varying float vDisp;

${SIMPLEX_NOISE_GLSL}

void main() {
  // Organic surface: FBM ridges crawl over the sphere; audio deepens them.
  float n = fbm(normal * uNoiseFreq + vec3(0.0, uTime * 0.35, uTime * 0.18));
  float disp = n * uNoiseAmp * (1.0 + uAudio * 1.8);
  vec3 displaced = position + normal * disp;

  vDisp = n;
  vLocalPos = position;
  vNormal = normalize(normalMatrix * normal);

  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const SURFACE_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uAudio;
uniform float uGlow;
uniform float uScan;
uniform vec3 uColorA;
uniform vec3 uColorB;

varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vLocalPos;
varying float vDisp;

void main() {
  float ndv = clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0);
  float fresnel = pow(1.0 - ndv, 2.4);
  float rimHot = pow(1.0 - ndv, 5.5); // tight white-hot line at grazing angles

  // Internal structure: fine latitude scan lines drifting upward, a slower
  // coarse band, and a rotating meridian sweep — machinery inside the glass.
  float fine   = smoothstep(0.55, 1.0, sin(vLocalPos.y * 46.0 - uTime * 2.4) * 0.5 + 0.5);
  float coarse = smoothstep(0.35, 1.0, sin(vLocalPos.y * 7.0 + uTime * 0.8) * 0.5 + 0.5);
  float sweep  = smoothstep(0.86, 1.0, sin(atan(vLocalPos.z, vLocalPos.x) + uTime * 0.7) * 0.5 + 0.5);
  float scan = (fine * 0.55 + coarse * 0.25 + sweep * 0.5) * uScan;

  // Depth ramp: dark heart -> saturated body -> energy rim -> hot edge.
  vec3 col = mix(uColorA * 0.4, uColorA, 0.25 + ndv * 0.4);
  col = mix(col, uColorB, fresnel);
  col += mix(uColorB, vec3(1.0), 0.55) * rimHot * (0.55 + uAudio * 0.7);
  col += uColorB * scan * (0.4 + uAudio * 0.25);     // internal scan lines
  col += uColorB * max(vDisp, 0.0) * 0.6;            // noise ridges catch light
  col += uColorB * uAudio * fresnel * 0.9;           // rim flares with the voice
  col *= 0.7 + uGlow * 0.65;

  gl_FragColor = vec4(col, 0.94);
}
`;

const HALO_VERTEX = /* glsl */ `
varying float vRim;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vRim = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 3.0);
  gl_Position = projectionMatrix * mv;
}
`;

const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uColorB;
uniform float uGlow;
uniform float uAudio;
varying float vRim;
void main() {
  float a = vRim * (0.28 + uGlow * 0.35 + uAudio * 0.3);
  gl_FragColor = vec4(uColorB, a);
}
`;

const PARTICLE_VERTEX = /* glsl */ `
attribute vec3 aDir;     // stream ray direction (unit, small per-bead jitter)
attribute float aStream; // 0..1 seed shared by every bead of one stream
attribute float aSeed;   // 0..1 per-bead phase along the stream
attribute float aSpeed;  // stream speed factor (shared, so trains stay coherent)
attribute float aShell;  // 0..1 position inside the orbit shell

uniform float uTime;
uniform float uFlow;      // -1 stream inward, 0 orbit, +1 stream outward
uniform float uFlowSpeed; // travel rate along the ray during flow
uniform float uSpread;
uniform float uRing;      // flattens the orbit shell into an equatorial band
uniform float uAudio;
uniform float uSize;      // point size scale (already includes DPR)

varying float vFade;
varying float vHot; // extra whiteness where energy meets the surface

void main() {
  const float TAU = 6.2831853;
  float flowAmt = abs(uFlow);

  // Phase along the run. Beads of one stream share aStream/aSpeed and are
  // staggered through aSeed, so a run reads as a coherent comet train.
  float t = fract(aSeed + uTime * aSpeed * 0.22 * mix(1.0, uFlowSpeed, flowAmt));

  // Behaviour A — orbit: a shell that can flatten into an equatorial band
  // (thinking pulls the swarm into a tight processing ring).
  vec3 oDir = normalize(vec3(aDir.x, aDir.y * mix(1.0, 0.3, uRing * (1.0 - flowAmt)), aDir.z));
  float orbitR = 1.3 + aShell * uSpread;

  // Behaviour B — flow: eased travel between deep space and the surface.
  // Inward runs accelerate as the orb pulls them in; outward runs erupt fast
  // off the surface and relax — force, not linear drift.
  float travel = uFlow > 0.0 ? pow(t, 0.62) : pow(1.0 - t, 0.55);
  float flowR = mix(1.02, 3.3, travel);

  float r = mix(orbitR, flowR, flowAmt);

  // Swirl: orbit spins per-bead in counter-rotating halves for depth; flow
  // precesses per-stream (keeping trains intact) with a light helix twist.
  float band = aShell > 0.5 ? 1.0 : -1.0;
  float orbitRate = (0.55 + aShell * 0.55) * band;
  float flowRate = 0.16 + (flowR - 1.0) * 0.1;
  float swirl = uTime * aSpeed * mix(orbitRate, flowRate, flowAmt)
              + mix(aSeed, aStream, flowAmt) * TAU;
  float c = cos(swirl);
  float s = sin(swirl);
  vec3 dir = mix(oDir, aDir, flowAmt);
  dir = vec3(dir.x * c - dir.z * s, dir.y, dir.x * s + dir.z * c);

  vec3 pos = dir * r;

  // Visibility: flow runs fade at both ends and surge in per-stream pulses
  // (streams breathe instead of drawing static ribbons); orbits shimmer.
  float ends = smoothstep(0.0, 0.14, t) * (1.0 - smoothstep(0.8, 1.0, t));
  float surge = 0.55 + 0.45 * sin(uTime * (0.8 + aSpeed) * 1.6 + aStream * TAU);
  float shimmer = 0.55 + 0.45 * sin(uTime * aSpeed * 3.0 + aSeed * 40.0);
  vFade = mix(shimmer, ends * (0.35 + 0.65 * surge) * (0.8 + uAudio * 0.6), flowAmt);

  // Energy concentrates near the surface — beads swell and whiten there.
  float prox = 1.0 - smoothstep(1.0, 3.3, r);
  vHot = prox * flowAmt;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = uSize * (0.55 + aSeed * 0.55)
               * (1.0 + uAudio * 1.3)
               * (0.7 + prox * mix(0.5, 1.1, flowAmt))
               * (1.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
uniform vec3 uColorB;
uniform float uAlpha;
varying float vFade;
varying float vHot;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.42, 0.05, d);
  float glow = smoothstep(0.5, 0.2, d) * 0.4;
  float a = (core + glow) * vFade * uAlpha;
  if (a < 0.003) discard;
  vec3 col = mix(uColorB, vec3(1.0), core * (0.2 + vHot * 0.5));
  gl_FragColor = vec4(col, min(a, 1.0));
}
`;

// ── Scene internals ───────────────────────────────────────────────────────────

const PARTICLE_COUNT_HIGH = 490;
const PARTICLE_COUNT_LOW = 224;
/** Beads per comet train — trains share a ray, a seed and a speed. */
const PARTICLES_PER_STREAM = 7;

/** Frame-rate-independent exponential lerp. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return THREE.MathUtils.damp(current, target, lambda, dt);
}

const WHITE = new THREE.Color("#ffffff");

interface SceneProps {
  state: OrbState;
  audioLevel: number;
  analyser: AnalyserNode | null;
  isActive: boolean;
  particleCount: number;
  /** Live bloom effect — intensity is lerped per state each frame. */
  bloomRef: React.MutableRefObject<{ intensity: number } | null>;
}

function OrbScene({ state, audioLevel, analyser, isActive, particleCount, bloomRef }: SceneProps) {
  const groupRef = useRef<THREE.Group>(null);
  const surfaceMat = useRef<THREE.ShaderMaterial>(null);
  const haloMat = useRef<THREE.ShaderMaterial>(null);
  const particleMat = useRef<THREE.ShaderMaterial>(null);
  const coreMat = useRef<THREE.MeshBasicMaterial>(null);
  const coreRef = useRef<THREE.Mesh>(null);

  // Live (lerped) visual values — mutated every frame, never in React state.
  const live = useRef({
    colorA: new THREE.Color(STATE_VISUALS.idle.colorA),
    colorB: new THREE.Color(STATE_VISUALS.idle.colorB),
    noiseAmp: STATE_VISUALS.idle.noiseAmp,
    noiseFreq: STATE_VISUALS.idle.noiseFreq,
    glow: STATE_VISUALS.idle.glow,
    scan: STATE_VISUALS.idle.scan,
    flow: 0,
    flowSpeed: STATE_VISUALS.idle.flowSpeed,
    spread: STATE_VISUALS.idle.spread,
    ring: STATE_VISUALS.idle.ring,
    particleAlpha: STATE_VISUALS.idle.particleAlpha,
    bloom: STATE_VISUALS.idle.bloom,
    audio: 0,
    surfaceTime: 0,
    timeScale: STATE_VISUALS.idle.timeScale,
    flash: 0, // one-shot burst on entering success / warning
  });
  const targetColorA = useRef(new THREE.Color(STATE_VISUALS.idle.colorA));
  const targetColorB = useRef(new THREE.Color(STATE_VISUALS.idle.colorB));
  const prevState = useRef<OrbState>(state);
  const audioBuf = useRef(new Uint8Array(0));

  // State transitions: retarget colours, fire the flash on arrival states.
  useEffect(() => {
    targetColorA.current.set(STATE_VISUALS[state].colorA);
    targetColorB.current.set(STATE_VISUALS[state].colorB);
    if (state !== prevState.current && (state === "success" || state === "warning" || state === "error")) {
      live.current.flash = 1;
    }
    prevState.current = state;
  }, [state]);

  // Particle geometry — one BufferGeometry, disposed on unmount/count change.
  // Beads are grouped into streams: each stream shares a base ray, a seed and
  // a speed, and staggers its beads in phase, so directional flow reads as
  // discrete comet trains instead of a homogeneous mist.
  const particleGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const dir = new Float32Array(particleCount * 3);
    const stream = new Float32Array(particleCount);
    const seed = new Float32Array(particleCount);
    const speed = new Float32Array(particleCount);
    const shell = new Float32Array(particleCount);
    const v = new THREE.Vector3();
    const ray = new THREE.Vector3();
    let streamSeed = 0;
    let streamSpeed = 1;
    for (let i = 0; i < particleCount; i++) {
      const bead = i % PARTICLES_PER_STREAM;
      if (bead === 0) {
        // New stream: uniform ray on the unit sphere (normalised gaussians).
        ray.set(gauss(), gauss(), gauss()).normalize();
        streamSeed = Math.random();
        streamSpeed = 0.55 + Math.random() * 0.9;
      }
      // Slight jitter off the ray gives the train body without breaking it.
      v.set(gauss(), gauss(), gauss()).multiplyScalar(0.05).add(ray).normalize();
      dir.set([v.x, v.y, v.z], i * 3);
      stream[i] = streamSeed;
      seed[i] = (streamSeed + bead * 0.085 + Math.random() * 0.025) % 1;
      speed[i] = streamSpeed;
      shell[i] = Math.random();
    }
    // Positions are computed in the vertex shader; the attribute only needs
    // to exist so the draw call has a vertex count.
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3));
    geo.setAttribute("aDir", new THREE.BufferAttribute(dir, 3));
    geo.setAttribute("aStream", new THREE.BufferAttribute(stream, 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    geo.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
    geo.setAttribute("aShell", new THREE.BufferAttribute(shell, 1));
    // The shader moves points well beyond the static bounds — never cull.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
    return geo;
  }, [particleCount]);

  useEffect(() => () => particleGeometry.dispose(), [particleGeometry]);

  const surfaceUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAudio: { value: 0 },
      uNoiseAmp: { value: STATE_VISUALS.idle.noiseAmp },
      uNoiseFreq: { value: STATE_VISUALS.idle.noiseFreq },
      uGlow: { value: STATE_VISUALS.idle.glow },
      uScan: { value: STATE_VISUALS.idle.scan },
      uColorA: { value: new THREE.Color(STATE_VISUALS.idle.colorA) },
      uColorB: { value: new THREE.Color(STATE_VISUALS.idle.colorB) },
    }),
    []
  );
  const haloUniforms = useMemo(
    () => ({
      uColorB: { value: new THREE.Color(STATE_VISUALS.idle.colorB) },
      uGlow: { value: STATE_VISUALS.idle.glow },
      uAudio: { value: 0 },
    }),
    []
  );
  const particleUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uFlowSpeed: { value: STATE_VISUALS.idle.flowSpeed },
      uSpread: { value: STATE_VISUALS.idle.spread },
      uRing: { value: STATE_VISUALS.idle.ring },
      uAudio: { value: 0 },
      uAlpha: { value: STATE_VISUALS.idle.particleAlpha },
      uSize: { value: 26 },
      uColorB: { value: new THREE.Color(STATE_VISUALS.idle.colorB) },
    }),
    []
  );

  useFrame((three, rawDt) => {
    const dt = Math.min(rawDt, 0.05); // guard against tab-switch jumps
    const L = live.current;
    const target = STATE_VISUALS[state];

    // ── Audio drive: analyser RMS (frame-accurate) merged with the prop ──────
    let audioRaw = audioLevel;
    if (analyser) {
      if (audioBuf.current.length !== analyser.fftSize) {
        audioBuf.current = new Uint8Array(analyser.fftSize);
      }
      const buf = audioBuf.current;
      analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const s = (buf[i] - 128) / 128;
        sum += s * s;
      }
      audioRaw = Math.max(audioRaw, Math.min(1, Math.sqrt(sum / buf.length) * 5));
    }
    // Fast attack, slow release — the orb jumps with the voice, settles gently.
    L.audio = audioRaw > L.audio ? damp(L.audio, audioRaw, 18, dt) : damp(L.audio, audioRaw, 4, dt);

    // ── Lerp every visual value toward the state target ──────────────────────
    const dim = isActive ? 1 : 0.35;
    L.noiseAmp = damp(L.noiseAmp, target.noiseAmp, 4, dt);
    L.noiseFreq = damp(L.noiseFreq, target.noiseFreq, 3, dt);
    L.glow = damp(L.glow, target.glow * dim, 4, dt);
    L.scan = damp(L.scan, target.scan, 4, dt);
    L.flow = damp(L.flow, target.flow, 3.4, dt);
    L.flowSpeed = damp(L.flowSpeed, target.flowSpeed, 3, dt);
    L.spread = damp(L.spread, target.spread, 3.2, dt);
    L.ring = damp(L.ring, target.ring, 3.5, dt);
    L.particleAlpha = damp(L.particleAlpha, target.particleAlpha * dim, 4, dt);
    L.bloom = damp(L.bloom, target.bloom * dim, 3.5, dt);
    L.timeScale = damp(L.timeScale, target.timeScale, 3, dt);
    L.flash = damp(L.flash, 0, 2.4, dt);
    L.colorA.lerp(targetColorA.current, 1 - Math.exp(-4 * dt));
    L.colorB.lerp(targetColorB.current, 1 - Math.exp(-4 * dt));

    // Surface time advances at the state's own pace so "thinking" seethes
    // while "idle" barely drifts — without any discontinuity on transition.
    L.surfaceTime += dt * L.timeScale;
    const t = L.surfaceTime;
    const flashGlow = L.flash * 0.9;

    if (surfaceMat.current) {
      const u = surfaceMat.current.uniforms;
      u.uTime.value = t;
      u.uAudio.value = L.audio;
      u.uNoiseAmp.value = L.noiseAmp;
      u.uNoiseFreq.value = L.noiseFreq;
      u.uGlow.value = L.glow + flashGlow;
      u.uScan.value = L.scan;
      (u.uColorA.value as THREE.Color).copy(L.colorA);
      (u.uColorB.value as THREE.Color).copy(L.colorB);
    }
    if (haloMat.current) {
      const u = haloMat.current.uniforms;
      u.uGlow.value = L.glow + flashGlow;
      u.uAudio.value = L.audio;
      (u.uColorB.value as THREE.Color).copy(L.colorB);
    }
    if (particleMat.current) {
      const u = particleMat.current.uniforms;
      u.uTime.value = t;
      u.uFlow.value = L.flow;
      u.uFlowSpeed.value = L.flowSpeed;
      u.uSpread.value = L.spread;
      u.uRing.value = L.ring;
      u.uAudio.value = L.audio;
      u.uAlpha.value = L.particleAlpha;
      // Point size follows the canvas so the dock orb keeps the same visual
      // grain as the hero orb instead of chunky device-pixel sprites.
      u.uSize.value = three.size.height * three.viewport.dpr * 0.085;
      (u.uColorB.value as THREE.Color).copy(L.colorB);
    }
    if (coreMat.current) {
      // The heart breathes on its own slow cycle and whitens under load.
      const beat = 0.05 * Math.sin(t * 2.1);
      coreMat.current.color.copy(L.colorB).lerp(WHITE, 0.18 + flashGlow * 0.35 + L.audio * 0.2);
      coreMat.current.opacity = 0.35 + beat + L.glow * 0.4 + flashGlow * 0.5 + L.audio * 0.25;
    }
    if (coreRef.current) {
      const cs = 0.42 + Math.sin(t * 2.1) * 0.015 + L.audio * 0.12 + flashGlow * 0.12;
      coreRef.current.scale.setScalar(cs);
    }
    if (bloomRef.current) {
      bloomRef.current.intensity = L.bloom + flashGlow * 0.9 + L.audio * 0.35;
    }

    // Breathing + audio swell on the whole group; slow contemplative rotation.
    if (groupRef.current) {
      const breathe =
        1 + Math.sin(t * target.pulseSpeed) * target.pulseDepth + L.audio * 0.055 + flashGlow * 0.04;
      groupRef.current.scale.setScalar(breathe);
      groupRef.current.rotation.y += dt * (0.05 + L.audio * 0.12);
      groupRef.current.rotation.x = Math.sin(t * 0.18) * 0.06;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Surface — the living skin */}
      <mesh>
        <icosahedronGeometry args={[1, 5]} />
        <shaderMaterial
          ref={surfaceMat}
          uniforms={surfaceUniforms}
          vertexShader={SURFACE_VERTEX}
          fragmentShader={SURFACE_FRAGMENT}
          transparent
        />
      </mesh>

      {/* Core — the light inside */}
      <mesh ref={coreRef} scale={0.42}>
        <sphereGeometry args={[1, 24, 24]} />
        <meshBasicMaterial
          ref={coreMat}
          transparent
          opacity={0.5}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Halo — soft rim shell for bloom to feed on */}
      <mesh scale={1.18}>
        <sphereGeometry args={[1, 32, 32]} />
        <shaderMaterial
          ref={haloMat}
          uniforms={haloUniforms}
          vertexShader={HALO_VERTEX}
          fragmentShader={HALO_FRAGMENT}
          transparent
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Tendrils — one instanced-style point cloud, morphed by uFlow */}
      <points geometry={particleGeometry}>
        <shaderMaterial
          ref={particleMat}
          uniforms={particleUniforms}
          vertexShader={PARTICLE_VERTEX}
          fragmentShader={PARTICLE_FRAGMENT}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>
    </group>
  );
}

/** Box–Muller gaussian for uniform sphere sampling. */
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Fallback + error handling ─────────────────────────────────────────────────

/** Static CSS orb for reduced-motion users and machines without WebGL. */
function StaticOrb({
  size,
  state,
  className,
  onClick,
  ariaLabel,
}: {
  size: number;
  state: OrbState;
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const rim = STATE_VISUALS[state].colorB;
  return (
    <div
      className={className}
      // role="img" (not a live region): assistive tech must not announce
      // every state change — the host surface owns meaningful announcements.
      role={onClick ? "button" : "img"}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      aria-label={ariaLabel ?? `IRA is ${state}`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        cursor: onClick ? "pointer" : undefined,
        background: `radial-gradient(circle at 38% 34%, ${rim}33 0%, ${rim}14 45%, transparent 72%)`,
        border: `1px solid ${rim}55`,
        boxShadow: `0 0 ${size * 0.25}px ${rim}2e, inset 0 0 ${size * 0.3}px ${rim}22`,
      }}
    />
  );
}

interface BoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

/** If WebGL context creation throws mid-render, degrade to the static orb. */
class OrbErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LivingOrb({
  state,
  audioLevel = 0,
  analyser = null,
  size = 280,
  isActive = true,
  quality = "high",
  className,
  onClick,
  ariaLabel,
}: LivingOrbProps) {
  // null = still deciding (SSR / first client render) → render nothing yet.
  const [canRender, setCanRender] = useState<boolean | null>(null);
  const [dpr, setDpr] = useState<[number, number]>([1, 2]);
  const bloomRef = useRef<{ intensity: number } | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setCanRender(!reduced && webglAvailable());
  }, []);

  const particleCount = quality === "high" ? PARTICLE_COUNT_HIGH : PARTICLE_COUNT_LOW;
  const fallback = (
    <StaticOrb size={size} state={state} className={className} onClick={onClick} ariaLabel={ariaLabel} />
  );

  if (canRender === null) {
    return <div className={className} style={{ width: size, height: size }} aria-hidden />;
  }
  if (!canRender) return fallback;

  return (
    <div
      className={className}
      style={{ width: size, height: size, cursor: onClick ? "pointer" : undefined }}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      // role="img", never role="status": the orb changes state constantly and
      // must not compete with the host's live regions (gate notices etc).
      role={onClick ? "button" : "img"}
      tabIndex={onClick ? 0 : undefined}
      aria-label={ariaLabel ?? `IRA is ${state}`}
    >
      <OrbErrorBoundary fallback={fallback}>
        <Canvas
          dpr={dpr}
          camera={{ position: [0, 0, 3.4], fov: 42 }}
          gl={{
            antialias: false, // bloom's mipmap blur covers aliasing at far lower cost
            alpha: true,
            powerPreference: "high-performance",
            stencil: false,
          }}
          style={{ background: "transparent" }}
        >
          {/* Step DPR down if the GPU can't hold frame rate — beauty, but honest. */}
          <PerformanceMonitor
            onDecline={() => setDpr([1, 1.25])}
            onIncline={() => setDpr([1, 2])}
          />
          <OrbScene
            state={state}
            audioLevel={audioLevel}
            analyser={analyser}
            isActive={isActive}
            particleCount={particleCount}
            bloomRef={bloomRef}
          />
          {quality === "high" && (
            <EffectComposer multisampling={0}>
              <Bloom
                ref={bloomRef as React.Ref<never>}
                intensity={STATE_VISUALS.idle.bloom}
                luminanceThreshold={0.18}
                luminanceSmoothing={0.3}
                mipmapBlur
                radius={0.72}
              />
            </EffectComposer>
          )}
        </Canvas>
      </OrbErrorBoundary>
    </div>
  );
}
