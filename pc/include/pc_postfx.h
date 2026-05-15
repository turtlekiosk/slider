/* pc_postfx.h - Final-pass post-processing filter (CRT / LCD / halftone)
 *
 * Web-only: redirects game rendering into an offscreen FBO, then runs a
 * fragment shader as a final fullscreen pass that samples the FBO and
 * writes to the default framebuffer. Replaces the older JS overlay
 * approach (pc/web/shell-postfx.js) for these three filters, which
 * required preserveDrawingBuffer:true + cross-context texImage2D capture
 * per frame. ASCII still lives in shell-postfx.js because porting its
 * runtime-generated glyph atlas to C is out of scope.
 *
 * Mode is owned by JS (dropdown + localStorage) and pushed to C via
 * pc_postfx_set_mode_str() — exposed as a wasm export so shell-postfx.js
 * can Module.ccall() into it.
 *
 * On non-web targets every function is a no-op. */
#ifndef PC_POSTFX_H
#define PC_POSTFX_H

#ifdef __cplusplus
extern "C" {
#endif

void pc_postfx_init(void);
void pc_postfx_shutdown(void);

/* Begin-frame: bind the offscreen FBO so all subsequent draws land in
 * the texture we'll sample in end-frame. When mode is OFF (or ASCII —
 * the JS overlay handles that case), this is a no-op and game rendering
 * goes straight to the default framebuffer. Call before glClear in
 * pc_gx_begin_frame(). */
void pc_postfx_begin_frame(void);

/* End-frame: unbind the FBO, run the active shader as a fullscreen pass
 * sampling the FBO color attachment, writing to the default
 * framebuffer. No-op when OFF/ASCII. Call from pc_platform_swap_buffers
 * just before SDL_GL_SwapWindow. */
void pc_postfx_end_frame(void);

/* Filter codes — must stay in sync with the JS-side MODE_CODES table
 * in pc/web/shell-postfx.js. Values are part of the JS↔C ABI and must
 * not be renumbered (treat like a wire format). ASCII is intentionally
 * mapped to OFF because its overlay lives in JS; this enum only covers
 * what C can render. */
#define PC_POSTFX_OFF            0
#define PC_POSTFX_CRT_BASIC      1
#define PC_POSTFX_CRT_FULL       2
#define PC_POSTFX_LCD            3
#define PC_POSTFX_CMYK_HALFTONE  4

/* Set the active mode. JS dispatches the dropdown value's mapped code
 * here via Module._pc_postfx_set_mode (the same direct-export pattern
 * used by pc_input_touch_*). Out-of-range values map to OFF. */
void pc_postfx_set_mode(int code);

#ifdef __cplusplus
}
#endif

#endif /* PC_POSTFX_H */
