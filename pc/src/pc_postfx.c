/* pc_postfx.c - C-side final-pass post-processing (web only)
 *
 * Render game → offscreen FBO; final pass samples FBO with one of the
 * CRT / LCD / halftone fragment shaders, writes to the default
 * framebuffer. Avoids the older JS-overlay pipeline's cross-context
 * texImage2D capture for these three filters.
 *
 * ASCII is intentionally NOT handled here — its glyph atlas is built at
 * runtime by Canvas2D in shell-postfx.js, which would be awkward to
 * replicate in C. JS retains ASCII; we accept "ascii" as a mode and
 * treat it as OFF so the game renders direct-to-default-FB and the JS
 * overlay can sample it as before.
 *
 * Y-orientation: original JS shaders flipped Y because they sampled a
 * canvas-coords texture and drew into canvas-coords. Here both source
 * (FBO color attachment) and destination (default framebuffer) follow
 * GL convention, so UV is identity — Y-flip is removed from every
 * fragment shader. Visual effect is invariant (scanlines, halftone
 * angles, LCD stripes are all symmetric under y-reflection at this
 * scale). */
#include "pc_platform.h"
#include "pc_postfx.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

extern void pc_gx_restore_after_nes(void);

/* Defined in pc_gx_tev.c. Returns a malloc'd, null-terminated buffer or
 * NULL on failure; caller frees. SDL_RWFromFile-backed so Android APK
 * assets work transparently (web reads from the --preload-file FS). */
extern char* pc_load_text_file(const char* path);

/* Mode codes — values are part of the JS↔C ABI, see pc_postfx.h. */
typedef enum {
    PFX_OFF           = PC_POSTFX_OFF,
    PFX_CRT_BASIC     = PC_POSTFX_CRT_BASIC,
    PFX_CRT_FULL      = PC_POSTFX_CRT_FULL,
    PFX_LCD           = PC_POSTFX_LCD,
    PFX_CMYK_HALFTONE = PC_POSTFX_CMYK_HALFTONE
} PostFxMode;

static struct {
    PostFxMode mode;

    int initialized;
    int init_failed;

    int fbo_w, fbo_h;
    GLuint fbo;
    GLuint color_tex;
    GLuint depth_rbo;

    GLuint vao;
    GLuint vbo;

    GLuint prog_crt;     /* shared between crt-basic and crt-full via uniforms */
    GLuint prog_lcd;
    GLuint prog_ht;

    GLint  u_crt_game,  u_crt_canvasSize, u_crt_grille, u_crt_boost, u_crt_scan;
    GLint  u_lcd_game,  u_lcd_canvasSize;
    GLint  u_ht_game,   u_ht_canvasSize;

    int prev_fbo_bound; /* whether begin_frame bound the FBO this frame */
} s;

/* ---- helpers ----------------------------------------------------- */

static GLuint compile(GLenum type, const char* src) {
    GLuint sh = glCreateShader(type);
    glShaderSource(sh, 1, &src, NULL);
    glCompileShader(sh);
    GLint ok = 0;
    glGetShaderiv(sh, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[1024];
        glGetShaderInfoLog(sh, sizeof(log), NULL, log);
        fprintf(stderr, "[postfx] shader compile error: %s\n", log);
        glDeleteShader(sh);
        return 0;
    }
    return sh;
}

static GLuint link_prog(GLuint vs, GLuint fs) {
    GLuint p = glCreateProgram();
    glAttachShader(p, vs);
    glAttachShader(p, fs);
    glBindAttribLocation(p, 0, "a_pos");
    glLinkProgram(p);
    GLint ok = 0;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) {
        char log[1024];
        glGetProgramInfoLog(p, sizeof(log), NULL, log);
        fprintf(stderr, "[postfx] program link error: %s\n", log);
        glDeleteProgram(p);
        return 0;
    }
    return p;
}

static void ensure_fbo(int w, int h) {
    if (s.fbo && s.fbo_w == w && s.fbo_h == h) return;

    if (!s.fbo) glGenFramebuffers(1, &s.fbo);
    if (!s.color_tex) glGenTextures(1, &s.color_tex);
    if (!s.depth_rbo) glGenRenderbuffers(1, &s.depth_rbo);

    glBindTexture(GL_TEXTURE_2D, s.color_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    glBindRenderbuffer(GL_RENDERBUFFER, s.depth_rbo);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, w, h);

    glBindFramebuffer(GL_FRAMEBUFFER, s.fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                           GL_TEXTURE_2D, s.color_tex, 0);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT,
                              GL_RENDERBUFFER, s.depth_rbo);
    GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    if (status != GL_FRAMEBUFFER_COMPLETE) {
        fprintf(stderr, "[postfx] framebuffer incomplete: 0x%x\n", status);
        s.init_failed = 1;
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    s.fbo_w = w;
    s.fbo_h = h;
}

/* ---- public API -------------------------------------------------- */

/* Load + compile one shader file. Returns 0 on any failure (and logs to
 * stderr). Caller checks for 0 and aborts init — unlike the TEV shader
 * (which is fatal because nothing else renders), failed postfx init is
 * non-fatal: we mark init_failed and the filter pass becomes inert. */
static GLuint load_and_compile(GLenum type, const char* filename) {
    char path[256];
    snprintf(path, sizeof(path), "shaders/%s", filename);
    char* src = pc_load_text_file(path);
    if (!src) {
        fprintf(stderr, "[postfx] failed to load %s\n", path);
        return 0;
    }
    GLuint sh = compile(type, src);
    free(src);
    return sh;
}

void pc_postfx_init(void) {
    if (s.initialized || s.init_failed) return;

    GLuint vs = load_and_compile(GL_VERTEX_SHADER,   "postfx.vert");
    GLuint fc = load_and_compile(GL_FRAGMENT_SHADER, "postfx-crt.frag");
    GLuint fl = load_and_compile(GL_FRAGMENT_SHADER, "postfx-lcd.frag");
    GLuint fh = load_and_compile(GL_FRAGMENT_SHADER, "postfx-halftone.frag");
    if (!vs || !fc || !fl || !fh) {
        if (vs) glDeleteShader(vs);
        if (fc) glDeleteShader(fc);
        if (fl) glDeleteShader(fl);
        if (fh) glDeleteShader(fh);
        s.init_failed = 1; return;
    }

    s.prog_crt = link_prog(vs, fc);
    s.prog_lcd = link_prog(vs, fl);
    s.prog_ht  = link_prog(vs, fh);
    glDeleteShader(vs);
    glDeleteShader(fc);
    glDeleteShader(fl);
    glDeleteShader(fh);
    if (!s.prog_crt || !s.prog_lcd || !s.prog_ht) { s.init_failed = 1; return; }

    s.u_crt_game       = glGetUniformLocation(s.prog_crt, "u_game");
    s.u_crt_canvasSize = glGetUniformLocation(s.prog_crt, "u_canvasSize");
    s.u_crt_grille     = glGetUniformLocation(s.prog_crt, "u_grille_amt");
    s.u_crt_boost      = glGetUniformLocation(s.prog_crt, "u_boost");
    s.u_crt_scan       = glGetUniformLocation(s.prog_crt, "u_scan_intensity");
    s.u_lcd_game       = glGetUniformLocation(s.prog_lcd, "u_game");
    s.u_lcd_canvasSize = glGetUniformLocation(s.prog_lcd, "u_canvasSize");
    s.u_ht_game        = glGetUniformLocation(s.prog_ht,  "u_game");
    s.u_ht_canvasSize  = glGetUniformLocation(s.prog_ht,  "u_canvasSize");

    glGenVertexArrays(1, &s.vao);
    glBindVertexArray(s.vao);
    glGenBuffers(1, &s.vbo);
    glBindBuffer(GL_ARRAY_BUFFER, s.vbo);
    {
        /* Fullscreen triangle: one tri large enough to cover [-1,1]^2,
         * avoiding the diagonal seam two tris would have. */
        const float verts[] = { -1.0f, -1.0f,  3.0f, -1.0f, -1.0f, 3.0f };
        glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
    }
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, (void*)0);
    glBindVertexArray(0);

    s.mode = PFX_OFF;
    s.initialized = 1;
}

void pc_postfx_shutdown(void) {
    if (!s.initialized) return;
    if (s.fbo)       glDeleteFramebuffers(1, &s.fbo);
    if (s.color_tex) glDeleteTextures(1, &s.color_tex);
    if (s.depth_rbo) glDeleteRenderbuffers(1, &s.depth_rbo);
    if (s.vbo)       glDeleteBuffers(1, &s.vbo);
    if (s.vao)       glDeleteVertexArrays(1, &s.vao);
    if (s.prog_crt)  glDeleteProgram(s.prog_crt);
    if (s.prog_lcd)  glDeleteProgram(s.prog_lcd);
    if (s.prog_ht)   glDeleteProgram(s.prog_ht);
    memset(&s, 0, sizeof(s));
}

void pc_postfx_begin_frame(void) {
    s.prev_fbo_bound = 0;
    if (!s.initialized || s.init_failed) return;
    if (s.mode == PFX_OFF) return;
    if (g_pc_window_w <= 0 || g_pc_window_h <= 0) return;

    ensure_fbo(g_pc_window_w, g_pc_window_h);
    if (s.init_failed) return;

    glBindFramebuffer(GL_FRAMEBUFFER, s.fbo);
    s.prev_fbo_bound = 1;
}

void pc_postfx_end_frame(void) {
    if (!s.prev_fbo_bound) return;
    s.prev_fbo_bound = 0;

    /* Resolve game-state-bound FBO → default framebuffer via shader pass. */
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, g_pc_window_w, g_pc_window_h);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_BLEND);
    glDisable(GL_SCISSOR_TEST);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);

    GLuint prog;
    GLint  u_game, u_canvasSize;
    switch (s.mode) {
        case PFX_CRT_BASIC:
        case PFX_CRT_FULL:
            prog = s.prog_crt;
            u_game = s.u_crt_game;
            u_canvasSize = s.u_crt_canvasSize;
            break;
        case PFX_LCD:
            prog = s.prog_lcd;
            u_game = s.u_lcd_game;
            u_canvasSize = s.u_lcd_canvasSize;
            break;
        case PFX_CMYK_HALFTONE:
            prog = s.prog_ht;
            u_game = s.u_ht_game;
            u_canvasSize = s.u_ht_canvasSize;
            break;
        default:
            return;
    }

    glUseProgram(prog);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, s.color_tex);
    glUniform1i(u_game, 0);
    glUniform2f(u_canvasSize, (GLfloat)s.fbo_w, (GLfloat)s.fbo_h);
    if (s.mode == PFX_CRT_BASIC) {
        glUniform1f(s.u_crt_grille, 0.0f);
        glUniform1f(s.u_crt_boost,  1.0f);
        glUniform1f(s.u_crt_scan,   0.10f);
    } else if (s.mode == PFX_CRT_FULL) {
        glUniform1f(s.u_crt_grille, 0.18f);
        glUniform1f(s.u_crt_boost,  1.18f);
        glUniform1f(s.u_crt_scan,   0.40f);
    }

    glBindVertexArray(s.vao);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glBindVertexArray(0);

    /* Restore GX state for the next frame's draws: rebinds the game's
     * VAO/VBO/EBO, marks shader/uniforms dirty, re-enables depth and
     * blend. Same helper the NES emulator path uses. */
    pc_gx_restore_after_nes();
}

EMSCRIPTEN_KEEPALIVE
void pc_postfx_set_mode(int code) {
    switch (code) {
        case PC_POSTFX_CRT_BASIC:     s.mode = PFX_CRT_BASIC;     break;
        case PC_POSTFX_CRT_FULL:      s.mode = PFX_CRT_FULL;      break;
        case PC_POSTFX_LCD:           s.mode = PFX_LCD;           break;
        case PC_POSTFX_CMYK_HALFTONE: s.mode = PFX_CMYK_HALFTONE; break;
        default:                      s.mode = PFX_OFF;           break;
    }
}

#else /* !__EMSCRIPTEN__ */

void pc_postfx_init(void)              {}
void pc_postfx_shutdown(void)          {}
void pc_postfx_begin_frame(void)       {}
void pc_postfx_end_frame(void)         {}
void pc_postfx_set_mode(int code)      { (void)code; }

#endif
