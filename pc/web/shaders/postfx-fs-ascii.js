/* Fragment shader source for the ASCII filter (shell-postfx.js). Picks
 * a glyph from cell-center brightness (gamma-stretched), then tints by
 * underlying color. The brightness gradient is encoded in the glyph
 * shape; the color multiplier just gives modest saturation. */
(window.acgcPostfxShaders = window.acgcPostfxShaders || {}).fsAscii = `#version 300 es
precision mediump float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_game;
uniform sampler2D u_atlas;
uniform vec2  u_canvasSize;
uniform float u_cell;
uniform float u_numGlyphs;

void main() {
  vec2 cellIdx = floor(v_uv * u_canvasSize / u_cell);
  vec2 cellCenter = (cellIdx + 0.5) * u_cell / u_canvasSize;
  // Captured-from-canvas texture is top-down; flip Y for the read.
  vec2 cellCenterFlipped = vec2(cellCenter.x, 1.0 - cellCenter.y);
  vec4 game = texture(u_game, cellCenterFlipped);
  float brightness = dot(game.rgb, vec3(0.299, 0.587, 0.114));

  // Gamma-stretch brightness so AC's mid-dark scenes climb a bit higher
  // up the ramp without aggressively flattening contrast.
  float bGamma = pow(clamp(brightness, 0.0, 1.0), 0.75);
  float gi = floor(bGamma * u_numGlyphs);
  gi = clamp(gi, 0.0, u_numGlyphs - 1.0);

  vec2 cellLocal = fract(v_uv * u_canvasSize / u_cell);
  // Atlas is laid out top-down (canvas 2D), so flip Y when sampling.
  vec2 atlasUV = vec2((gi + cellLocal.x) / u_numGlyphs, 1.0 - cellLocal.y);
  float mask = texture(u_atlas, atlasUV).r;

  // Tint: modest boost on the underlying color so dim cells stay dim
  // (preserve chiaroscuro) but very dark cells are still readable.
  // clamp keeps highlights from blowing out.
  vec3 tint = clamp(game.rgb * 1.4, 0.0, 1.0);

  outColor = vec4(tint * mask, 1.0);
}
`;
