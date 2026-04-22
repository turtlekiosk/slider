/* pc_gles_compat.h - Abstract GL 3.3 / GLES 3.0 differences */
#ifndef PC_GLES_COMPAT_H
#define PC_GLES_COMPAT_H

#ifdef TARGET_ANDROID
  #include <GLES3/gl3.h>
  #include <GLES3/gl3ext.h>

  /* Desktop GL uses double-precision; GLES 3.0 only has float versions */
  #define glClearDepth glClearDepthf
  #define glDepthRange glDepthRangef

  /* GL_MULTISAMPLE doesn't exist in GLES (MSAA is at the EGL surface level) */
  #ifndef GL_MULTISAMPLE
  #define GL_MULTISAMPLE 0x809D
  #endif

  /* GL_UNSIGNED_SHORT_5_6_5_REV doesn't exist in GLES 3.0.
   * Code that uses it must byte-swap and use GL_UNSIGNED_SHORT_5_6_5 instead. */
#else
  #include <glad/gl.h>
#endif

#endif /* PC_GLES_COMPAT_H */
