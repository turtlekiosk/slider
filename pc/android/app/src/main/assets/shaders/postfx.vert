#version 300 es
/* Vertex shader for pc_postfx.c — fullscreen-triangle pass.
 * One triangle large enough to cover [-1,1]^2 (vertices at
 * (-1,-1), (3,-1), (-1,3)), avoiding the diagonal seam that two
 * tris meeting at the screen center would produce. */
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
