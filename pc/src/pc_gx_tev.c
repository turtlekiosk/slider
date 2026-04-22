/* pc_gx_tev.c - TEV shader: GLSL program loading and uniform upload */
#include "pc_gx_internal.h"

/* --- file I/O --- */

static char* load_text_file(const char* path) {
    /* Use SDL_RWFromFile so Android can read from APK assets transparently */
    SDL_RWops* rw = SDL_RWFromFile(path, "rb");
    if (!rw) return NULL;

    Sint64 len = SDL_RWsize(rw);
    if (len <= 0) { SDL_RWclose(rw); return NULL; }

    char* buf = (char*)malloc((size_t)len + 1);
    if (!buf) { SDL_RWclose(rw); return NULL; }

    size_t read = SDL_RWread(rw, buf, 1, (size_t)len);
    SDL_RWclose(rw);
    if (read != (size_t)len) {
        fprintf(stderr, "WARNING: Partial read of %s (got %zu of %lld bytes)\n", path, read, (long long)len);
        free(buf);
        return NULL;
    }
    buf[read] = '\0';
    return buf;
}

static char* load_shader(const char* filename) {
    char path[512];
    snprintf(path, sizeof(path), "shaders/%s", filename);
    char* src = load_text_file(path);
    if (src) {
        printf("[PC/TEV] Loaded shader: %s\n", path);
    } else {
        fprintf(stderr, "FATAL: Could not load shader: %s\n", path);
    }
    return src;
}

static GLuint default_program = 0;

static GLuint compile_shader(GLenum type, const char* source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, NULL);
    glCompileShader(shader);

    GLint success;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &success);
    if (!success) {
        char log[512];
        glGetShaderInfoLog(shader, sizeof(log), NULL, log);
        fprintf(stderr, "FATAL: Shader compile error: %s\n", log);
        glDeleteShader(shader);
        return 0;
    }
    return shader;
}

static GLuint link_program(GLuint vert, GLuint frag) {
    if (!vert || !frag) {
        fprintf(stderr, "FATAL: Cannot link program — shader compilation failed\n");
        if (vert) glDeleteShader(vert);
        if (frag) glDeleteShader(frag);
        return 0;
    }

    GLuint prog = glCreateProgram();
    glAttachShader(prog, vert);
    glAttachShader(prog, frag);

    glBindAttribLocation(prog, 0, "a_position");
    glBindAttribLocation(prog, 1, "a_normal");
    glBindAttribLocation(prog, 2, "a_color0");
    glBindAttribLocation(prog, 3, "a_texcoord0");

    glLinkProgram(prog);

    GLint success;
    glGetProgramiv(prog, GL_LINK_STATUS, &success);
    if (!success) {
        char log[512];
        glGetProgramInfoLog(prog, sizeof(log), NULL, log);
        fprintf(stderr, "FATAL: Program link error: %s\n", log);
        glDeleteProgram(prog);
        prog = 0;
    }

    glDeleteShader(vert);
    glDeleteShader(frag);
    return prog;
}

void pc_gx_tev_init(void) {
    char* vs_src = load_shader("default.vert");
    char* fs_src = load_shader("default.frag");

    if (!vs_src || !fs_src) {
        fprintf(stderr, "FATAL: Shader files missing from shaders/ directory.\n"
                        "Expected: shaders/default.vert and shaders/default.frag\n"
                        "Make sure shader files are next to the executable.\n");
        free(vs_src);
        free(fs_src);
        exit(1);
    }

    GLuint vs = compile_shader(GL_VERTEX_SHADER, vs_src);
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER, fs_src);
    default_program = link_program(vs, fs);

    free(vs_src);
    free(fs_src);
}

void pc_gx_tev_shutdown(void) {
    if (default_program) {
        glDeleteProgram(default_program);
        default_program = 0;
    }

}

GLuint pc_gx_tev_get_shader(PCGXState* state) {
    return default_program;
}
