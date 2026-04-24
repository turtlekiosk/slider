/* android_enum_fixup.h — Force-included for decomp C++ files on Android.
 *
 * NDK Clang rejects implicit int→enum conversions that GCC allows.
 * The decomp's JSUStreamEnum.h defines enums SEEK_SET/SEEK_CUR/SEEK_END/EOF
 * but POSIX macros of the same name get restored, so call sites pass int
 * instead of the enum type.  We override the macros with cast expressions. */
#ifndef ANDROID_ENUM_FIXUP_H
#define ANDROID_ENUM_FIXUP_H

#if defined(TARGET_ANDROID) || defined(__EMSCRIPTEN__)

/* Pull in stdio first so its macros are defined, then override.
 * stdlib is pulled in so decomp sources that use strtol()/etc. without
 * an explicit include (works on NDK via transitive includes) still compile. */
#include <stdio.h>
#include <stdlib.h>
#include "JSystem/JSupport/JSUStreamEnum.h"

/* Now override POSIX macros with typed casts for C++ overload resolution.
 * Safe because no decomp C++ code uses fseek() or stdio EOF. */
#undef SEEK_SET
#undef SEEK_CUR
#undef SEEK_END
#undef EOF
#define SEEK_SET ((JSUStreamSeekFrom)0)
#define SEEK_CUR ((JSUStreamSeekFrom)1)
#define SEEK_END ((JSUStreamSeekFrom)2)
#define EOF      ((EIoState)1)

#endif
#endif
