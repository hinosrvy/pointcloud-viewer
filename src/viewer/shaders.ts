import * as THREE from 'three';

export type ColorMode = 'elevation' | 'rgb' | 'intensity' | 'classification';
export const COLOR_MODE_INDEX: Record<ColorMode, number> = { elevation: 0, rgb: 1, intensity: 2, classification: 3 };

/** 全レイヤーで共有するユニフォーム（値オブジェクトを共有するので一括更新できる） */
export interface SharedUniforms {
  uMode: { value: number };
  uPointSize: { value: number };
  uAttenuate: { value: number };
  uScreenHeight: { value: number };
  uZRange: { value: THREE.Vector2 }; // シーン座標(原点相対)での z の min/max
  uIntensityRange: { value: THREE.Vector2 }; // 0..1 正規化後
  uGamma: { value: number };
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uMode: { value: 1 }, // 既定は RGB
    uPointSize: { value: 2 },
    uAttenuate: { value: 0 },
    uScreenHeight: { value: 1000 },
    uZRange: { value: new THREE.Vector2(0, 1) },
    uIntensityRange: { value: new THREE.Vector2(0, 0.5) },
    uGamma: { value: 1 },
  };
}

const vertex = /* glsl */ `
  attribute vec3 color;
  attribute float intensity;
  attribute float classification;
  uniform int uMode;
  uniform float uPointSize;
  uniform float uAttenuate;
  uniform float uScreenHeight;
  uniform vec2 uZRange;
  uniform vec2 uIntensityRange;
  uniform float uColorScale;
  uniform float uGamma;
  varying vec3 vColor;

  // Turbo colormap (Google) の多項式近似
  vec3 turbo(float t) {
    t = clamp(t, 0.0, 1.0);
    const vec4 kR = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 kG = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 kB = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 kR2 = vec2(-152.94239396, 59.28637943);
    const vec2 kG2 = vec2(4.27729857, 2.82956604);
    const vec2 kB2 = vec2(-89.90310912, 27.34824973);
    vec4 v4 = vec4(1.0, t, t * t, t * t * t);
    vec2 v2 = v4.zw * v4.z;
    return vec3(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2));
  }

  vec3 classColor(float c) {
    int k = int(c + 0.5);
    if (k == 1) return vec3(0.55, 0.55, 0.55);   // 未分類
    if (k == 2) return vec3(0.63, 0.45, 0.25);   // 地面
    if (k == 3) return vec3(0.55, 0.80, 0.35);   // 低植生
    if (k == 4) return vec3(0.25, 0.70, 0.25);   // 中植生
    if (k == 5) return vec3(0.05, 0.50, 0.10);   // 高植生
    if (k == 6) return vec3(0.90, 0.30, 0.25);   // 建物
    if (k == 7) return vec3(0.80, 0.10, 0.80);   // ノイズ
    if (k == 9) return vec3(0.20, 0.45, 0.95);   // 水
    if (k == 10) return vec3(0.60, 0.20, 0.60);  // 鉄道
    if (k == 11) return vec3(0.35, 0.35, 0.40);  // 道路
    if (k == 13 || k == 14) return vec3(1.0, 0.85, 0.2); // 電線
    if (k == 15 || k == 16) return vec3(1.0, 0.55, 0.1); // 鉄塔・碍子
    if (k == 17) return vec3(0.75, 0.75, 0.55);  // 橋梁
    if (k == 18) return vec3(0.9, 0.9, 0.9);     // 高ノイズ
    return vec3(0.7);
  }

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    if (uMode == 0) {
      float t = (wp.z - uZRange.x) / max(uZRange.y - uZRange.x, 1e-6);
      vColor = turbo(t);
    } else if (uMode == 1) {
      vColor = pow(clamp(color * uColorScale, 0.0, 1.0), vec3(1.0 / uGamma));
    } else if (uMode == 2) {
      float t = (intensity - uIntensityRange.x) / max(uIntensityRange.y - uIntensityRange.x, 1e-6);
      vColor = vec3(clamp(t, 0.0, 1.0));
    } else {
      vColor = classColor(classification);
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float size = uPointSize;
    if (uAttenuate > 0.5) size = uPointSize * uScreenHeight * 0.001 / max(-mv.z, 0.01) * 10.0;
    gl_PointSize = clamp(size, 1.0, 64.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  varying vec3 vColor;
  uniform float uRound;
  void main() {
    if (uRound > 0.5) {
      vec2 d = gl_PointCoord - 0.5;
      if (dot(d, d) > 0.25) discard;
    }
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

export function createPointMaterial(shared: SharedUniforms, colorScale: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uColorScale: { value: colorScale },
      uRound: { value: 1 },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
}
