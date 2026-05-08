(window.acgcPostfxShaders = window.acgcPostfxShaders || {}).fsHalftone = `#version 300 es
precision mediump float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_game;
uniform vec2  u_canvasSize;

// Halftone screen geometry.
const float CELL_PX   = 7.0;    // canvas px per halftone cell
const float DOT_BLUR  = 0.05;   // dot edge softness, in cell-uv units
const float DOT_GAIN  = 0.62;   // dot radius scale: r = sqrt(cov) * GAIN.
                                // Above 0.5, dots can spill into neighbor
                                // cells (we only check the home cell, so
                                // they get clipped at the cell boundary —
                                // visually fine and gives high-coverage
                                // areas a near-solid look).

// Standard CMYK screen angles (degrees) — non-coincident so the
// four halftone grids don't moiré with each other.
const float ANG_Y =  0.0;
const float ANG_M = 75.0;
const float ANG_C = 15.0;
const float ANG_K = 45.0;

// Per-ink misregistration offset (canvas px). Each ink layer
// samples the source at a slightly shifted position, so the
// layers don't perfectly align — the riso signature.
const vec2 REG_Y = vec2( 2.0,  0.0);
const vec2 REG_M = vec2(-1.5,  1.0);
const vec2 REG_C = vec2( 1.0, -1.5);
const vec2 REG_K = vec2( 0.0,  0.0);

// Riso-style spot palette (the color each ink looks like on the
// paper). Not pure CMYK — fluorescent pink for M, federal blue
// for C, warm dark for K, on a warm cream paper.
const vec3 PAPER = vec3(0.96, 0.94, 0.86);
const vec3 INK_Y = vec3(1.00, 0.86, 0.18);
const vec3 INK_M = vec3(1.00, 0.28, 0.69);
const vec3 INK_C = vec3(0.24, 0.33, 0.53);
const vec3 INK_K = vec3(0.12, 0.10, 0.12);

const float GRAIN_AMT = 0.07;

mat2 rot2(float angDeg) {
  float a = radians(angDeg);
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Sample the source at canvas-pixel position px. The captured
// texture is top-down, so flip Y on read.
vec3 sampleSrc(vec2 px) {
  vec2 uv = vec2(px.x, u_canvasSize.y - px.y) / u_canvasSize;
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  return texture(u_game, uv).rgb;
}

// RGB → CMYK separation (standard process-print formula).
vec4 rgbToCmyk(vec3 c) {
  float k = 1.0 - max(c.r, max(c.g, c.b));
  if (k >= 0.999) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 cmy = (1.0 - c - k) / (1.0 - k);
  return vec4(cmy, k);
}

// One halftone-ink layer. Builds a rotated cell grid at angleDeg,
// samples the source at this fragment's cell-center (plus
// misregistration), pulls the requested CMYK channel, and returns
// a soft-edged dot mask whose radius scales with sqrt(coverage)
// (equal-area dot growth — perceptually linear).
float halftoneInk(vec2 fragXY, float angleDeg, vec2 regOff, int channel) {
  mat2 R    = rot2(angleDeg);
  mat2 Rinv = rot2(-angleDeg);

  // Cell coordinates in the rotated frame.
  vec2 q       = (R * fragXY) / CELL_PX;
  vec2 cellId  = floor(q);
  vec2 cellUv  = fract(q) - 0.5;

  // Cell center back in screen-pixel space, plus misregistration.
  vec2 cellCenterScreen = Rinv * ((cellId + 0.5) * CELL_PX) + regOff;
  vec3 src  = sampleSrc(cellCenterScreen);
  vec4 cmyk = rgbToCmyk(src);
  float cov = (channel == 0) ? cmyk.x
            : (channel == 1) ? cmyk.y
            : (channel == 2) ? cmyk.z
            :                  cmyk.w;

  float r = sqrt(cov) * DOT_GAIN;
  float d = length(cellUv);
  return 1.0 - smoothstep(r - DOT_BLUR, r + DOT_BLUR, d);
}

void main() {
  vec2 px = gl_FragCoord.xy;

  float dotC = halftoneInk(px, ANG_C, REG_C, 0);
  float dotM = halftoneInk(px, ANG_M, REG_M, 1);
  float dotY = halftoneInk(px, ANG_Y, REG_Y, 2);
  float dotK = halftoneInk(px, ANG_K, REG_K, 3);

  // Composite: paper, then ink layers Y → M → C → K. We use
  // priority mix (last-applied wins where dots overlap) rather
  // than CMYK multiplicative blending — riso spot inks aren't
  // orthogonal RGB filters, and dot adjacency does most of the
  // visual color mixing in real riso prints.
  vec3 col = PAPER;
  col = mix(col, INK_Y, dotY);
  col = mix(col, INK_M, dotM);
  col = mix(col, INK_C, dotC);
  col = mix(col, INK_K, dotK);

  // Paper grain — small per-canvas-pixel darkening, holds
  // substrate texture even in flat-ink regions.
  float g = hash21(floor(px));
  col *= 1.0 - GRAIN_AMT * g;

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
