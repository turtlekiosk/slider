#version 300 es
/* CRT filter — single pass:
 *   barrel-distort UV → bounds cull → sample → scanlines → optional
 *   RGB-triad aperture grille → brightness boost → smooth vignette.
 *
 * The grille and boost are uniform-gated so one program serves both
 * presets: crt-basic disables them (clean on high-DPR displays where a
 * per-pixel triad would moiré); crt-full enables them for a punchier
 * arcade-monitor look. Y-flip omitted vs the old JS-overlay version
 * because both source (FBO) and destination (default FB) follow GL
 * convention. */
precision mediump float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_game;
uniform vec2  u_canvasSize;
uniform float u_grille_amt;     // 0.0 = no mask, 0.18 = punchy
uniform float u_boost;          // 1.0 = no boost, 1.18 = scanline comp
uniform float u_scan_intensity; // 0.10 = subtle, 0.40 = heavy

const float CURVATURE      = 0.04;
const float VIGNETTE_INNER = 0.95;
const float VIGNETTE_OUTER = 1.40;
const float VIGNETTE_DARK  = 0.65;

void main() {
    vec2 uv = v_uv;
    vec2 q = (uv - 0.5) * 2.0;
    q *= 1.0 + dot(q, q) * CURVATURE;
    uv = q * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec3 col = texture(u_game, uv).rgb;

    float scan = sin(uv.y * u_canvasSize.y * 3.14159265) * 0.5 + 0.5;
    col *= 1.0 - u_scan_intensity * (1.0 - scan);

    if (u_grille_amt > 0.0) {
        float xMod3 = mod(floor(uv.x * u_canvasSize.x), 3.0);
        vec3 mask = vec3(1.0 - u_grille_amt);
        if (xMod3 < 1.0)      mask.r = 1.0 + u_grille_amt;
        else if (xMod3 < 2.0) mask.g = 1.0 + u_grille_amt;
        else                  mask.b = 1.0 + u_grille_amt;
        col *= mask;
    }

    col *= u_boost;

    float vd = length(q);
    float vig = 1.0 - smoothstep(VIGNETTE_INNER, VIGNETTE_OUTER, vd);
    col *= mix(VIGNETTE_DARK, 1.0, vig);

    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
