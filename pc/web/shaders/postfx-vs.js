/* Vertex shader source for shell-postfx.js. Trivial fullscreen-triangle
 * (a single tri large enough to cover the screen, dodging the seam two
 * tris would have at the diagonal). Both fragment shaders consume v_uv. */
(window.acgcPostfxShaders = window.acgcPostfxShaders || {}).vs = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
