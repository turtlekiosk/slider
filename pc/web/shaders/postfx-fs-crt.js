/* Fragment shader source for the CRT filter (shell-postfx.js). Single-
 * pass: barrel-distort curvature → bounds cull → texture sample →
 * scanline modulation → optional RGB-triad aperture grille → brightness
 * boost → smooth vignette.
 *
 * The grille and boost are gated on uniforms so a single program serves
 * both presets: crt-basic disables them (clean rendering on high-DPR
 * mobile displays); crt-full enables them for a punchier
 * arcade-monitor look. */
(window.acgcPostfxShaders = window.acgcPostfxShaders || {}).fsCrt = `#version 300 es
precision mediump float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_game;
uniform vec2  u_canvasSize;
uniform float u_grille_amt;     // 0.0 = no mask, 0.18 = punchy
uniform float u_boost;          // 1.0 = no boost, 1.18 = scanline comp
uniform float u_scan_intensity; // 0.10 = subtle, 0.40 = heavy

const float CURVATURE        = 0.04;
const float VIGNETTE_INNER   = 0.95;
const float VIGNETTE_OUTER   = 1.40;
const float VIGNETTE_DARK    = 0.65;

void main() {
  // Captured-from-canvas texture is top-down; flip Y.
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);

  // Curvature: barrel-distort UV around the center.
  vec2 q = (uv - 0.5) * 2.0;
  q *= 1.0 + dot(q, q) * CURVATURE;
  uv = q * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 col = texture(u_game, uv).rgb;

  // Scanlines: subtle dark stripes between every row.
  float scan = sin(uv.y * u_canvasSize.y * 3.14159265) * 0.5 + 0.5;
  col *= 1.0 - u_scan_intensity * (1.0 - scan);

  // Aperture grille (RGB triad). When u_grille_amt is 0 (basic preset),
  // the branch is skipped — leaves col unchanged.
  if (u_grille_amt > 0.0) {
    float xMod3 = mod(floor(uv.x * u_canvasSize.x), 3.0);
    vec3 mask = vec3(1.0 - u_grille_amt);
    if (xMod3 < 1.0) mask.r = 1.0 + u_grille_amt;
    else if (xMod3 < 2.0) mask.g = 1.0 + u_grille_amt;
    else mask.b = 1.0 + u_grille_amt;
    col *= mask;
  }

  // Brightness boost compensates for scanline + grille darkening.
  col *= u_boost;

  // Vignette: smoothly dim from VIGNETTE_INNER → VIGNETTE_OUTER,
  // bottoming out at VIGNETTE_DARK rather than full black so the
  // corners stay readable instead of getting blacked out.
  float vd = length(q);
  float vig = 1.0 - smoothstep(VIGNETTE_INNER, VIGNETTE_OUTER, vd);
  col *= mix(VIGNETTE_DARK, 1.0, vig);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
