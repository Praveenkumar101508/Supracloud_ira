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
 *   - Tendrils  : one GPU particle system (a single draw call). A `uFlow`
 *                 uniform morphs the same particles between three behaviours:
 *                 orbiting shell (idle/thinking), streaming inward
 *                 (listening) and streaming outward (speaking).
 *   - Post      : EffectComposer + mipmap-blur Bloom for the cinematic glow.
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
  spread: number; // particle shell thickness / travel span
  particleAlpha: number;
  pulseSpeed: number; // breathing rate (rad/s)
  pulseDepth: number; // breathing amplitude (scale units)
}

const STATE_VISUALS: Record<OrbState, OrbVisualTarget> = {
  idle: {
    colorA: "#083344", colorB: "#22d3ee",
    noiseAmp: 0.055, noiseFreq: 2.4, timeScale: 0.35,
    glow: 0.4, scan: 0.22, flow: 0.0, spread: 0.55,
    particleAlpha: 0.3, pulseSpeed: 1.4, pulseDepth: 0.02,
  },
  listening: {
    colorA: "#0a3947", colorB: "#67e8f9",
    noiseAmp: 0.085, noiseFreq: 3.0, timeScale: 0.8,
    glow: 0.8, scan: 0.42, flow: -1.0, spread: 1.0,
    particleAlpha: 0.95, pulseSpeed: 2.2, pulseDepth: 0.02,
  },
  thinking: {
    colorA: "#241a4d", colorB: "#a78bfa",
    noiseAmp: 0.12, noiseFreq: 4.6, timeScale: 1.5,
    glow: 0.75, scan: 0.85, flow: 0.0, spread: 0.16,
    particleAlpha: 0.85, pulseSpeed: 4.2, pulseDepth: 0.014,
  },
  speaking: {
    colorA: "#064e3b", colorB: "#5eead4",
    noiseAmp: 0.1, noiseFreq: 3.2, timeScale: 1.1,
    glow: 0.95, scan: 0.5, flow: 1.0, spread: 1.0,
    particleAlpha: 0.95, pulseSpeed: 2.6, pulseDepth: 0.03,
  },
  success: {
    colorA: "#065f46", colorB: "#34d399",
    noiseAmp: 0.03, noiseFreq: 2.0, timeScale: 0.5,
    glow: 1.25, scan: 0.3, flow: 0.35, spread: 0.8,
    particleAlpha: 0.7, pulseSpeed: 1.2, pulseDepth: 0.012,
  },
  warning: {
    colorA: "#492c05", colorB: "#fbbf24",
    noiseAmp: 0.07, noiseFreq: 3.4, timeScale: 0.9,
    glow: 0.85, scan: 0.6, flow: 0.0, spread: 0.35,
    particleAlpha: 0.6, pulseSpeed: 3.4, pulseDepth: 0.035,
  },
  error: {
    colorA: "#4c1d2e", colorB: "#fda4af",
    noiseAmp: 0.05, noiseFreq: 2.6, timeScale: 0.5,
    glow: 0.55, scan: 0.35, flow: 0.0, spread: 0.45,
    particleAlpha: 0.4, pulseSpeed: 2.0, pulseDepth: 0.028,
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
  float fresnel = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0), 2.6);

  // Internal structure: fine latitude scan lines drifting upward, plus a
  // slower coarse band — reads as machinery inside the glass.
  float fine   = smoothstep(0.55, 1.0, sin(vLocalPos.y * 46.0 - uTime * 2.4) * 0.5 + 0.5);
  float coarse = smoothstep(0.35, 1.0, sin(vLocalPos.y * 7.0 + uTime * 0.8) * 0.5 + 0.5);
  float scan = (fine * 0.7 + coarse * 0.3) * uScan;

  vec3 col = mix(uColorA * 0.55, uColorB, fresnel); // dark heart, bright rim
  col += uColorB * scan * 0.4;                       // internal scan lines
  col += uColorB * max(vDisp, 0.0) * 0.55;           // noise ridges catch light
  col += uColorB * uAudio * fresnel * 0.9;           // rim flares with the voice
  col *= 0.75 + uGlow * 0.6;

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
attribute vec3 aDir;    // unit direction from the orb centre
attribute float aSeed;  // 0..1 phase offset
attribute float aSpeed; // individual speed factor
attribute float aShell; // 0..1 position inside the orbit shell

uniform float uTime;
uniform float uFlow;    // -1 stream inward, 0 orbit, +1 stream outward
uniform float uSpread;
uniform float uAudio;
uniform float uSize;    // point size scale (already includes DPR)

varying float vFade;

void main() {
  float t = fract(aSeed + uTime * aSpeed * 0.16);
  float flowAmt = abs(uFlow);

  // Behaviour A — orbit: particles live on a shell and swirl slowly.
  float orbitR = 1.28 + aShell * uSpread;

  // Behaviour B — flow: particles travel between the halo edge and deep
  // space along their direction ray; sign of uFlow picks the direction.
  float travel = uFlow > 0.0 ? t : 1.0 - t;
  float flowR = mix(1.05, 2.9, travel);

  float r = mix(orbitR, flowR, flowAmt);

  // Swirl the direction ray around Y — faster in orbit, a light twist in flow.
  float swirl = uTime * aSpeed * mix(0.9, 0.25, flowAmt) + aSeed * 6.2831853;
  float c = cos(swirl);
  float s = sin(swirl);
  vec3 dir = vec3(aDir.x * c - aDir.z * s, aDir.y, aDir.x * s + aDir.z * c);

  vec3 pos = dir * r;

  // Fade in/out at both ends of a flow run; orbits keep a steady shimmer.
  float ends = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.82, 1.0, t));
  vFade = mix(0.55 + 0.45 * sin(uTime * aSpeed * 3.0 + aSeed * 40.0), ends, flowAmt);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = uSize * (0.7 + aSeed * 0.6) * (1.0 + uAudio * 1.2) * (1.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
uniform vec3 uColorB;
uniform float uAlpha;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float sprite = smoothstep(0.5, 0.08, d);
  float a = sprite * vFade * uAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColorB, a);
}
`;

// ── Scene internals ───────────────────────────────────────────────────────────

const PARTICLE_COUNT_HIGH = 420;
const PARTICLE_COUNT_LOW = 200;

/** Frame-rate-independent exponential lerp. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return THREE.MathUtils.damp(current, target, lambda, dt);
}

interface SceneProps {
  state: OrbState;
  audioLevel: number;
  analyser: AnalyserNode | null;
  isActive: boolean;
  particleCount: number;
}

function OrbScene({ state, audioLevel, analyser, isActive, particleCount }: SceneProps) {
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
    spread: STATE_VISUALS.idle.spread,
    particleAlpha: STATE_VISUALS.idle.particleAlpha,
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
  const particleGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const dir = new Float32Array(particleCount * 3);
    const seed = new Float32Array(particleCount);
    const speed = new Float32Array(particleCount);
    const shell = new Float32Array(particleCount);
    const v = new THREE.Vector3();
    for (let i = 0; i < particleCount; i++) {
      // Uniform points on the unit sphere (normalised gaussians).
      v.set(gauss(), gauss(), gauss()).normalize();
      dir.set([v.x, v.y, v.z], i * 3);
      seed[i] = Math.random();
      speed[i] = 0.5 + Math.random();
      shell[i] = Math.random();
    }
    // Positions are computed in the vertex shader; the attribute only needs
    // to exist so the draw call has a vertex count.
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3));
    geo.setAttribute("aDir", new THREE.BufferAttribute(dir, 3));
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
      uSpread: { value: STATE_VISUALS.idle.spread },
      uAudio: { value: 0 },
      uAlpha: { value: STATE_VISUALS.idle.particleAlpha },
      uSize: { value: 26 },
      uColorB: { value: new THREE.Color(STATE_VISUALS.idle.colorB) },
    }),
    []
  );

  useFrame((_, rawDt) => {
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
    L.flow = damp(L.flow, target.flow, 3.2, dt);
    L.spread = damp(L.spread, target.spread, 3.2, dt);
    L.particleAlpha = damp(L.particleAlpha, target.particleAlpha * dim, 4, dt);
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
      u.uSpread.value = L.spread;
      u.uAudio.value = L.audio;
      u.uAlpha.value = L.particleAlpha;
      (u.uColorB.value as THREE.Color).copy(L.colorB);
    }
    if (coreMat.current) {
      coreMat.current.color.copy(L.colorB);
      coreMat.current.opacity = 0.35 + L.glow * 0.4 + flashGlow * 0.5 + L.audio * 0.25;
    }
    if (coreRef.current) {
      const cs = 0.42 + L.audio * 0.12 + flashGlow * 0.1;
      coreRef.current.scale.setScalar(cs);
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
function StaticOrb({ size, state, className }: { size: number; state: OrbState; className?: string }) {
  const rim = STATE_VISUALS[state].colorB;
  return (
    <div
      className={className}
      role="status"
      aria-label={`IRA is ${state}`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
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

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setCanRender(!reduced && webglAvailable());
  }, []);

  const particleCount = quality === "high" ? PARTICLE_COUNT_HIGH : PARTICLE_COUNT_LOW;
  const fallback = <StaticOrb size={size} state={state} className={className} />;

  if (canRender === null) {
    return <div className={className} style={{ width: size, height: size }} aria-hidden />;
  }
  if (!canRender) return fallback;

  return (
    <div
      className={className}
      style={{ width: size, height: size, cursor: onClick ? "pointer" : undefined }}
      onClick={onClick}
      role={onClick ? "button" : "status"}
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
          />
          {quality === "high" && (
            <EffectComposer multisampling={0}>
              <Bloom
                intensity={1.05}
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
