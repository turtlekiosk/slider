#version 300 es
/* LCD filter — Mattias-style sub-pixel grid: RGB column stripes + row
 * gaps + backlight floor; handheld-screen look. CELL_X must stay a
 * multiple of 3 so each of the three RGB sub-pixel columns occupies a
 * whole-pixel slice (CELL_X/3 canvas px each) and stripe edges align
 * to canvas-pixel boundaries — keeps the mask from aliasing. */
precision mediump float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_game;
uniform vec2 u_canvasSize;

const float CELL_X    = 6.0;   // canvas px per LCD pixel column
const float CELL_Y    = 6.0;   // canvas px per LCD pixel row
const float SUB_W     = 2.0;   // CELL_X / 3, canvas px per sub-pixel
const float V_GAP     = 0.15;  // fraction of cell height that's row gap
const float BACKLIGHT = 0.12;  // ambient floor brightness
const float STRIPE    = 0.80;  // dominant-channel boost. Off-channels
                               // get dimmed by half this amount so the
                               // 3-pixel modulator average is exactly
                               // 1.0 — source colors are preserved when
                               // sub-pixels blend at viewing distance.

void main() {
    // Sample the source once per LCD pixel. Each LCD pixel covers
    // CELL_X canvas px horizontally and CELL_Y vertically.
    vec2 lcdIdx = vec2(
        floor(v_uv.x * u_canvasSize.x / CELL_X),
        floor(v_uv.y * u_canvasSize.y / CELL_Y));
    vec2 lcdCenter = vec2(
        (lcdIdx.x + 0.5) * CELL_X / u_canvasSize.x,
        (lcdIdx.y + 0.5) * CELL_Y / u_canvasSize.y);
    vec3 src = texture(u_game, lcdCenter).rgb;

    // Sub-pixel column assignment: gl_FragCoord.x / SUB_W groups every
    // SUB_W canvas pixels into one sub-pixel slice, then mod 3 cycles
    // R/G/B. Boundaries land on canvas-pixel boundaries.
    float subIdx = mod(floor(gl_FragCoord.x / SUB_W), 3.0);
    vec3 colMask = vec3(1.0 - STRIPE * 0.5);
    if (subIdx < 0.5)      colMask.r = 1.0 + STRIPE;
    else if (subIdx < 1.5) colMask.g = 1.0 + STRIPE;
    else                   colMask.b = 1.0 + STRIPE;

    // Vertical row gap: dim the top and bottom of each cell.
    float cellLocalY = fract(v_uv.y * u_canvasSize.y / CELL_Y);
    float vMask = smoothstep(0.0, V_GAP, cellLocalY) *
                  smoothstep(1.0, 1.0 - V_GAP, cellLocalY);

    vec3 lit = src * colMask * vMask;

    // Backlight floor — real LCDs leak some light through the mask, so
    // dark cells / gridline gaps stay faintly visible instead of full
    // black.
    vec3 col = max(lit, src * BACKLIGHT);

    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
