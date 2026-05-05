cmake_minimum_required(VERSION 3.16)
project(ac_pc C CXX)

if(ANDROID)
    # C23 allows declarations after case labels (decomp code relies on this GCC extension)
    set(CMAKE_C_STANDARD 23)
else()
    set(CMAKE_C_STANDARD 11)
endif()
set(CMAKE_CXX_STANDARD 17)

# Do NOT set a default build type. Any optimization level (-O1, -O2) exposes
# undefined behavior in decomp code causing crashes. An empty build type gives
# GCC's default (-O0) which works correctly. The NDEBUG define below ensures
# asserts stay disabled regardless of build type.

option(PC_CONSOLE "Show console window (disables -mwindows, useful for debugging)" OFF)

# =============================================================================
# 32-bit enforcement (required: JSystem casts pointers to u32)
# =============================================================================
# wasm32 (Emscripten default) has sizeof(void*) == 4, so the check below passes.
if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR
        "This project MUST be built as 32-bit (pointer-to-u32 casts in JSystem).\n"
        "  Windows/MSYS2: Use the MINGW32 shell (not MINGW64)\n"
        "  Linux: Use a 32-bit toolchain, e.g.:\n"
        "    cmake .. -DCMAKE_C_COMPILER=i686-linux-gnu-gcc -DCMAKE_CXX_COMPILER=i686-linux-gnu-g++\n"
        "    OR: cmake .. -DCMAKE_TOOLCHAIN_FILE=../cmake/Toolchain-linux32.cmake\n"
        "  Web: emcmake cmake .. (wasm32 is the default)")
endif()

set(CMAKE_C_EXTENSIONS ON)
set(CMAKE_CXX_EXTENSIONS ON)

# =============================================================================
# Compiler definitions
# =============================================================================
add_compile_definitions(
    TARGET_PC
    VERSION=0
    F3DEX_GBI_2
    NDEBUG
    BUGFIXES        # Fix OOB reads in letter scoring tables (m_mail_check_ovl.c).
    _LANGUAGE_C    # Required for N64 GBI/ultratypes headers
    PC_ENHANCEMENTS   # Optional visual improvements (MSAA, etc). Remove to get pure PC port.
)
if(ANDROID)
    add_compile_definitions(TARGET_ANDROID)
elseif(EMSCRIPTEN)
    add_compile_definitions(
        TARGET_EMSCRIPTEN
        KEYBOARD_TYPING
    )
else()
    add_compile_definitions(
        KEYBOARD_TYPING   # Physical keyboard typing in text editor. Remove for platforms without keyboards.
    )
endif()

if(MSVC)
    add_compile_options(/W0)
else()
    add_compile_options(
        -fno-strict-aliasing
        -fwrapv
        -Wno-unused-parameter
    )
    if(ANDROID)
        # ARM32 may emit multi-word loads requiring 4-byte alignment for structs
        # that are only 2-byte aligned (e.g. s_xyz: 3×s16, 6 bytes). The decomp
        # code assumes unaligned access is transparent (true on PowerPC/x86).
        add_compile_options(-mno-unaligned-access)
    endif()
    if(EMSCRIPTEN)
        # Emscripten supplies SDL2 headers via ports at compile time.
        # (USE_WEBGL2 is a link-only setting — applied via target_link_options.)
        add_compile_options(-sUSE_SDL=2)
    endif()
endif()

# =============================================================================
# Include paths
# =============================================================================
set(DECOMP_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/..")

include_directories(
    ${DECOMP_ROOT}/include
    # NOTE: Do NOT add ${DECOMP_ROOT}/include/libc here!
    # Having both include/ and include/libc/ in the path breaks #include_next
    # chains in the decomp's shadow headers (e.g. libc/string.h). Without it,
    # #include "string.h" etc. resolve directly to system headers on PC.
    ${DECOMP_ROOT}/src
    # Project root needed for includes like "src/actor/npc/event/file.c_inc"
    ${DECOMP_ROOT}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/lib/fixnes
    # .inc assets are loaded at runtime from disc image (no build/GAFE01_00 needed)
)
if(NOT ANDROID AND NOT EMSCRIPTEN)
    include_directories(${CMAKE_CURRENT_SOURCE_DIR}/lib/glad/include)
endif()

# =============================================================================
# Find SDL2
# =============================================================================
if(ANDROID)
    add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/lib/SDL2-src SDL2-build)
    message(STATUS "SDL2: Building from source for Android")
elseif(EMSCRIPTEN)
    # -sUSE_SDL=2 (set in compile/link options) handles headers + linking
    message(STATUS "SDL2: Using Emscripten port (-sUSE_SDL=2)")
else()
    if(WIN32)
        set(SDL2_DIR "${CMAKE_CURRENT_SOURCE_DIR}/lib/SDL2/cmake" CACHE PATH "SDL2 cmake dir")
    endif()
    find_package(SDL2 QUIET)
    if(NOT SDL2_FOUND)
        find_package(PkgConfig QUIET)
        if(PKG_CONFIG_FOUND)
            pkg_check_modules(SDL2 QUIET sdl2)
        endif()
    endif()
    if(NOT SDL2_FOUND)
        if(WIN32)
            # MSYS2 32-bit location
            set(SDL2_MSYS2_DIR "C:/msys64/mingw32")
            if(EXISTS "${SDL2_MSYS2_DIR}/include/SDL2/SDL.h")
                set(SDL2_FOUND TRUE)
                set(SDL2_INCLUDE_DIRS "${SDL2_MSYS2_DIR}/include/SDL2")
                set(SDL2_LIBRARIES "${SDL2_MSYS2_DIR}/lib/libSDL2.a")
            else()
                # Downloaded SDL2 MinGW dev package (32-bit)
                set(SDL2_DOWNLOAD_DIR "${DECOMP_ROOT}/../SDL2-2.30.10/i686-w64-mingw32")
                if(EXISTS "${SDL2_DOWNLOAD_DIR}/include/SDL2/SDL.h")
                    set(SDL2_FOUND TRUE)
                    set(SDL2_INCLUDE_DIRS "${SDL2_DOWNLOAD_DIR}/include/SDL2")
                    set(SDL2_LIBRARIES "${SDL2_DOWNLOAD_DIR}/lib/libSDL2.a")
                else()
                    # Last resort: vendored SDL2 in lib/
                    set(SDL2_LOCAL_DIR "${CMAKE_CURRENT_SOURCE_DIR}/lib/SDL2")
                    if(EXISTS "${SDL2_LOCAL_DIR}/include/SDL.h")
                        set(SDL2_FOUND TRUE)
                        set(SDL2_INCLUDE_DIRS "${SDL2_LOCAL_DIR}/include")
                        set(SDL2_LIBRARIES "${SDL2_LOCAL_DIR}/lib/libSDL2.a")
                    endif()
                endif()
            endif()
        endif()

        if(NOT SDL2_FOUND)
            message(FATAL_ERROR
                "SDL2 not found!\n"
                "  Linux:         sudo apt install libsdl2-dev:i386  (Debian/Ubuntu)\n"
                "                 sudo dnf install SDL2-devel.i686   (Fedora)\n"
                "  Windows/MSYS2: pacman -S mingw-w64-i686-SDL2\n"
                "  Or download SDL2 development libraries to ${CMAKE_CURRENT_SOURCE_DIR}/lib/SDL2")
        endif()
    endif()
    include_directories(${SDL2_INCLUDE_DIRS})
    message(STATUS "SDL2 include: ${SDL2_INCLUDE_DIRS}")
    message(STATUS "SDL2 libraries: ${SDL2_LIBRARIES}")
endif()

# =============================================================================
# GLAD (OpenGL 3.3 loader - desktop only; Android/Emscripten use GLES3 headers)
# =============================================================================
if(NOT ANDROID AND NOT EMSCRIPTEN)
    add_library(glad STATIC
        ${CMAKE_CURRENT_SOURCE_DIR}/lib/glad/src/gl.c
    )
    target_include_directories(glad PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/lib/glad/include
    )
endif()

# =============================================================================
# Collect game source files
# =============================================================================
file(GLOB_RECURSE GAME_C_SOURCES CONFIGURE_DEPENDS
    "${DECOMP_ROOT}/src/*.c"
)
file(GLOB_RECURSE GAME_CXX_SOURCES CONFIGURE_DEPENDS
    "${DECOMP_ROOT}/src/*.cpp"
)

list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/AUS/.*")  # AUS-specific versions

# Exclude all Dolphin SDK hardware abstraction (we replace with pc_*.c stubs)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX
    ".*/dolphin/(gx|os|vi|pad|card|dvd|ai|ar|dsp|exi|si|db|mtx|base|gba|amcstubs|OdemuExi2|odenotstub)/.*")

# Exclude PPC-specific runtime/compiler support (Metrowerks CodeWarrior)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/TRK_MINNOW_DOLPHIN/.*")
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/Runtime\\.PPCEABI\\.H/.*")
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/MSL_C\\.PPCEABI\\.bare\\.H/.*")

file(GLOB_RECURSE DATA_C_SOURCES CONFIGURE_DEPENDS "${DECOMP_ROOT}/src/data/*.c")
list(APPEND GAME_C_SOURCES ${DATA_C_SOURCES})

# f_furniture.c #includes all 696 src/furniture/*.c files as a single TU (like GC build).
# Exclude the individual files to avoid duplicate symbol definitions.
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/src/furniture/.*")

# Exclude duplicate data files (subdirectory verbose versions conflict with top-level)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/src/data/model/obj_e_boat/.*")

# Exclude template/include .c files that are #included from other files
list(FILTER GAME_C_SOURCES EXCLUDE REGEX
    ".*/(ac_npc_shop_common|ac_animal_logo_misc|m_item_debug)\\.c$")

# Exclude NPC anime data fragments (no headers, #included from other NPC files)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/actor/npc/.*_anime\\.c$")

# Exclude Dolphin OS sources that conflict with PC stubs
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/osreport\\.c$")

# Exclude Famicom/NES emulator (contains PPC inline assembly)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/Famicom/.*")

# Exclude MSL_C library sources (using system libc on PC)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/MSL_C/.*")

# Exclude GBA-specific jaudio sources (the rest of the audio engine is kept)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/jaudio_NES/internal/(dsp_cardunlock|dsp_GBAKey)\\.c$")

# libc64: Include most files (qrand, math64, sleep, etc.)
# Exclude malloc.c (redefines system malloc/free which crashes CRT on PC).
# Keep __osMalloc.c (game code uses __osMalloc* directly via m_malloc.c).
# Exclude sprintf.c/aprintf.c (they need _Printf from libultra xprintf).
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/libc64/(malloc|sprintf|aprintf)\\.c$")

# libultra: Exclude most (we have pc_os.c replacements), but keep xprintf for libc64
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/libultra/.*")

# Exclude PPC-specific files
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/ReconfigBATs\\.c$")

# Exclude GC-specific entry point (PC has its own main)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/executor\\.c$")

# Exclude ef_effect_lib.c (has no #includes, pure function definitions without type context)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/ef_effect_lib\\.c$")

# Exclude m_card.c (needs Dolphin CARD system headers with non-standard include paths)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/m_card\\.c$")

list(FILTER GAME_CXX_SOURCES EXCLUDE REGEX ".*/AUS/.*")
list(FILTER GAME_CXX_SOURCES EXCLUDE REGEX ".*/dolphin/.*")
list(FILTER GAME_CXX_SOURCES EXCLUDE REGEX ".*/TRK_MINNOW_DOLPHIN/.*")
list(FILTER GAME_CXX_SOURCES EXCLUDE REGEX ".*/Runtime\\.PPCEABI\\.H/.*")
list(FILTER GAME_CXX_SOURCES EXCLUDE REGEX ".*/MSL_C\\.PPCEABI\\.bare\\.H/.*")
list(FILTER GAME_CXX_SOURCES EXCLUDE REGEX ".*/Famicom/.*")

# Re-include Famicom files (PPC asm guarded out with #ifndef TARGET_PC)
list(APPEND GAME_CXX_SOURCES
    ${DECOMP_ROOT}/src/static/Famicom/famicom.cpp
    ${DECOMP_ROOT}/src/static/Famicom/famicom_nesinfo.cpp
    ${DECOMP_ROOT}/src/static/Famicom/ks_nes_core.cpp
    ${DECOMP_ROOT}/src/static/Famicom/ks_nes_draw.cpp
)

# Exclude emu64_print.cpp (it's #included directly from emu64.c, not a standalone file)
list(FILTER GAME_CXX_SOURCES EXCLUDE REGEX ".*/emu64_print\\.cpp$")

# libjsys: jsyswrapper_ext.cpp and jsyswrapper_main.cpp are #included from jsyswrapper.cpp
# so exclude them from standalone compilation (just like emu64_utility.c).
list(FILTER GAME_CXX_SOURCES EXCLUDE REGEX ".*/jsyswrapper_(ext|main)\\.cpp$")

# =============================================================================
# PC port source files
# =============================================================================
set(PC_SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_main.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_gx.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_gx_tev.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_gx_texture.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_os.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_dvd.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_pad.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_typing.c
    ${DECOMP_ROOT}/src/static/dolphin/pad/Padclamp.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_card.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_vi.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_audio.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_aram.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_misc.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_mtx.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_m_card.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_save_bswap.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_model_viewer.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_texture_pack.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_settings.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_keybindings.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_nes_fixnes.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_stubs.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_stubs_cpp.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_assets.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_disc.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pc_vmem.c
)

# =============================================================================
# fixNES — vendored NES emulator (MIT License, by FIX94)
# =============================================================================
set(FIXNES_DIR ${CMAKE_CURRENT_SOURCE_DIR}/lib/fixnes)
file(GLOB FIXNES_MAPPER_SOURCES ${FIXNES_DIR}/mapper/*.c)
set(FIXNES_SOURCES
    ${FIXNES_DIR}/cpu.c
    ${FIXNES_DIR}/ppu.c
    ${FIXNES_DIR}/apu.c
    ${FIXNES_DIR}/mem.c
    ${FIXNES_DIR}/input.c
    ${FIXNES_DIR}/mapper.c
    ${FIXNES_DIR}/mapperList.c
    ${FIXNES_DIR}/vrc_irq.c
    ${FIXNES_DIR}/audio.c
    ${FIXNES_DIR}/fm2play.c
    ${FIXNES_DIR}/audio_fds.c
    ${FIXNES_DIR}/audio_mmc5.c
    ${FIXNES_DIR}/audio_vrc6.c
    ${FIXNES_DIR}/audio_vrc7.c
    ${FIXNES_DIR}/audio_n163.c
    ${FIXNES_DIR}/audio_s5b.c
    ${FIXNES_MAPPER_SOURCES}
)
# fixNES compile flags: -O2 (third-party code, no decomp UB to worry about) +
# DO_INLINE_ATTRIBS for hot-path inlining (cycle-accurate emulation).
set_source_files_properties(${FIXNES_SOURCES}
    PROPERTIES
    COMPILE_OPTIONS "-w;-O2"
    COMPILE_DEFINITIONS "COL_TEX_BSWAP;COL_GL_BSWAP;DO_INLINE_ATTRIBS=1"
)
# Also optimize the fixNES wrapper (frame loop is hot)
# Note: DO NOT set DO_INLINE_ATTRIBS here — the always_inline functions (cpuCycle etc)
# are in separate TUs and can't be inlined across files. They'll be inlined within
# their own .c files where -O2 + DO_INLINE_ATTRIBS is set.
set_source_files_properties(${CMAKE_CURRENT_SOURCE_DIR}/src/pc_nes_fixnes.c
    PROPERTIES
    COMPILE_OPTIONS "-Wall;-Wextra;-O2;-Wno-unused-parameter"
    COMPILE_DEFINITIONS ""
)

# Rename game's main() to ac_entry() to avoid conflict with PC main() and game_main(GAME*)
set_source_files_properties(
    "${DECOMP_ROOT}/src/main.c"
    PROPERTIES COMPILE_DEFINITIONS "main=ac_entry"
)

# Rename boot.c's main() to avoid conflict with PC main()
set_source_files_properties(
    "${DECOMP_ROOT}/src/static/boot.c"
    PROPERTIES COMPILE_DEFINITIONS "main=boot_main"
)

# Exclude emu64_utility.c (it's #included from emu64.c, not a standalone file)
list(FILTER GAME_C_SOURCES EXCLUDE REGEX ".*/emu64_utility\\.c$")

# These .c files contain C++ code (classes, namespaces, ::) and need C++
# compilation. Don't promote a file just for nullptr — the COMPILE_LANGUAGE
# generator expression below handles that case.
set_source_files_properties(
    "${DECOMP_ROOT}/src/static/libforest/emu64/emu64.c"
    # ja_calc.c uses std::sinf, std::sqrtf
    "${DECOMP_ROOT}/src/static/jaudio_NES/internal/ja_calc.c"
    # jammain_2.c uses extern "C"
    "${DECOMP_ROOT}/src/static/jaudio_NES/internal/jammain_2.c"
    # game64.c includes .c_inc with extern "C" (OSAttention.c_inc)
    "${DECOMP_ROOT}/src/static/jaudio_NES/game/game64.c"
    PROPERTIES LANGUAGE CXX
)

# jaudio_NES C files use nullptr: define it as NULL for C compilation on PC.
# Generator expression ensures this only applies to C files (C++ has nullptr natively).
add_compile_options($<$<COMPILE_LANGUAGE:C>:-Dnullptr=NULL>)

# =============================================================================
# Per-source warning settings
# =============================================================================
# Decomp code: suppress all warnings (fires heavily on decompiled code)
set(DECOMP_WARN_FLAGS "-fpermissive;-Wno-everything;-Wreturn-type;-Wreturn-mismatch;-Wcast-function-type-strict")
if(ANDROID OR EMSCRIPTEN)
    # Clang (NDK + Emscripten) promotes some warnings to errors even with -w; suppress them.
    list(APPEND DECOMP_WARN_FLAGS "-Wno-error=return-type" "-Wno-error=return-mismatch"
                                   "-Wno-error=cast-function-type-strict"
                                   "-Wno-error=format-security"
                                   "-Wno-error=implicit-function-declaration"
                                   "-Wno-register" "-Wno-c++11-narrowing")
endif()
set_source_files_properties(${GAME_C_SOURCES} ${GAME_CXX_SOURCES}
    PROPERTIES COMPILE_OPTIONS "${DECOMP_WARN_FLAGS}"
)

# Force-include android_enum_fixup.h for all decomp C++ TUs on Clang-only targets.
# Clang (NDK + Emscripten) rejects implicit int→enum conversions (e.g. SEEK_SET passed
# to JSUStreamSeekFrom parameters). The header overrides the POSIX macros with typed casts.
if(ANDROID OR EMSCRIPTEN)
    set_source_files_properties(${GAME_CXX_SOURCES}
        PROPERTIES COMPILE_FLAGS
        "-include ${CMAKE_CURRENT_SOURCE_DIR}/include/android_enum_fixup.h"
    )
endif()

# PC port code: enable warnings to catch bugs in code we control
set(PC_C_SOURCES ${PC_SOURCES})
list(FILTER PC_C_SOURCES EXCLUDE REGEX "\\.cpp$")
set(PC_CXX_SOURCES ${PC_SOURCES})
list(FILTER PC_CXX_SOURCES INCLUDE REGEX "\\.cpp$")
# Note: -Wno-comment/-Wno-unused-function/-Wno-builtin-declaration-mismatch suppress
# warnings from decomp headers (types.h, gfxprint.h, OSRtc.h, libultra.h) that we can't modify.
set(PC_WARN_SUPPRESS "-Wno-unused-parameter;-Wno-sign-compare;-Wno-comment;-Wno-unused-function")
if(NOT ANDROID AND NOT EMSCRIPTEN)
    # GCC-specific flag, not supported by NDK Clang or Emscripten Clang
    list(APPEND PC_WARN_SUPPRESS "-Wno-builtin-declaration-mismatch")
endif()
set_source_files_properties(${PC_C_SOURCES}
    PROPERTIES COMPILE_OPTIONS "-Wall;-Wextra;${PC_WARN_SUPPRESS}"
)
set_source_files_properties(${PC_CXX_SOURCES}
    PROPERTIES COMPILE_OPTIONS "-Wall;-Wextra;${PC_WARN_SUPPRESS};-fpermissive"
)

# =============================================================================
# Windows resource file (sets process name in Task Manager)
# =============================================================================
if(WIN32)
    set(RC_FILE "${CMAKE_CURRENT_SOURCE_DIR}/res/app.rc")
endif()

# =============================================================================
# Build target
# =============================================================================
# Source list shared across all platforms (Android shared lib + Emscripten
# wasm + desktop exe). Desktop appends its Windows resource file separately.
set(_AC_SOURCES ${PC_SOURCES} ${FIXNES_SOURCES} ${GAME_C_SOURCES} ${GAME_CXX_SOURCES})

if(ANDROID)
    # Android: shared library loaded by SDLActivity via System.loadLibrary()
    add_library(ac_pc SHARED ${_AC_SOURCES})
    target_link_libraries(ac_pc SDL2 GLESv3 EGL android log m)
elseif(EMSCRIPTEN)
    add_executable(ac_pc ${_AC_SOURCES})
    set_target_properties(ac_pc PROPERTIES
        # Emitted as `index.*` so GitHub Pages serves the wasm shell directly
        # at the repo root URL (e.g. https://user.github.io/repo/) without
        # needing a redirector or rename step in CI.
        OUTPUT_NAME "index"
        SUFFIX ".html"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/web"
    )
    # `-g` and `-sASSERTIONS=2` are debug-only — they bloat the wasm by
    # 50–100 MB and add per-allocation overhead, pushing iOS Safari past
    # its per-tab memory budget in release.
    set(_pc_web_debug_flags "")
    if(CMAKE_BUILD_TYPE STREQUAL "Debug")
        set(_pc_web_debug_flags -g -sASSERTIONS=2)
    endif()
    target_link_options(ac_pc PRIVATE
        -sUSE_SDL=2
        -sUSE_WEBGL2=1
        -sFULL_ES3=1
        -sMIN_WEBGL_VERSION=2
        -sMAX_WEBGL_VERSION=2
        -sALLOW_MEMORY_GROWTH=1
        -sINITIAL_MEMORY=134217728       # 128 MB — start small, grow on demand. iPhone SE 3
                                         # has a tight per-tab budget; reserving 256 MB upfront
                                         # tips us over before the game has a chance to run.
        -sSTACK_SIZE=5242880             # 5 MB: emu64 uses deep recursion
        ${_pc_web_debug_flags}
        -sASYNCIFY=1
        -sASYNCIFY_STACK_SIZE=4194304    # 4 MB: AC's main loop is deep
        # WebKit bug #304810 leaks "Page" memory under any Asyncify-
        # instrumented wasm — Safari/iOS climb to 7+ GB and OOM. JSPI
        # would fix it but isn't viable: Safari/iOS don't expose
        # WebAssembly.Suspending and Firefox gates JSPI behind an
        # about:config flag. Stay on Asyncify until that lands.
        -sEXIT_RUNTIME=0
        -sFORCE_FILESYSTEM=1
        -lidbfs.js
        # Gate decomp/jaudio printf logging on g_pc_verbose: each printf
        # crosses the wasm→JS bridge into console.log (~100–500 µs) and
        # jaudio emits several per voice setup → ~25 ms press-time hitch.
        # The shims in pc_os.c short-circuit when verbose is off. Wrap
        # puts/iprintf too because clang -O2 rewrites `printf("…\n")` →
        # puts and `printf("…%d…")` → iprintf based on format string.
        -Wl,--wrap=printf
        -Wl,--wrap=puts
        -Wl,--wrap=iprintf
        # Use Android's GLES 300-flavored shaders — WebGL2 is GLES 3.0, not desktop GL.
        "SHELL:--preload-file ${CMAKE_CURRENT_SOURCE_DIR}/android/app/src/main/assets/shaders@/shaders"
        "SHELL:--shell-file ${CMAKE_BINARY_DIR}/web/shell.html"
    )
    # Re-link when shell.html changes — emcc bakes it into index.html via
    # --shell-file but CMake doesn't track that as a dep on its own.
    set_property(TARGET ac_pc APPEND PROPERTY
        LINK_DEPENDS "${CMAKE_BINARY_DIR}/web/shell.html"
    )
    # POST_BUILD copy_if_different for each existing path; skips missing
    # entries so optional assets (icons) don't break the build.
    function(_pc_web_copy_each dest)
        foreach(_src IN LISTS ARGN)
            if(EXISTS "${_src}")
                add_custom_command(TARGET ac_pc POST_BUILD
                    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_src}" "${dest}")
            endif()
        endforeach()
    endfunction()

    # PWA assets copied next to the wasm output so the SW finds them at
    # the same origin path as index.html. sw.js is configure_file'd below
    # to stamp in the cache version.
    set(_PWA_FILES
        "${CMAKE_CURRENT_SOURCE_DIR}/web/manifest.webmanifest"
        "${CMAKE_CURRENT_SOURCE_DIR}/web/shell.css"
        "${CMAKE_CURRENT_SOURCE_DIR}/web/shell-touch.js"
        "${CMAKE_CURRENT_SOURCE_DIR}/web/shell-saves.js"
    )
    _pc_web_copy_each("${CMAKE_BINARY_DIR}/web/" ${_PWA_FILES})

    # Webfonts go in a fonts/ subdir so shell.css's url() paths resolve.
    file(GLOB _PWA_FONTS "${CMAKE_CURRENT_SOURCE_DIR}/web/fonts/*.woff2")
    if(_PWA_FONTS)
        add_custom_command(TARGET ac_pc POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_BINARY_DIR}/web/fonts")
        _pc_web_copy_each("${CMAKE_BINARY_DIR}/web/fonts/" ${_PWA_FONTS})
    endif()

    # SW cache key = git short SHA. Append a "-dirty-<timestamp>" suffix
    # only when a tracked file under pc/ has been modified relative to
    # HEAD. Untracked files (the build dir at pc/build-web/, editor
    # scratch) and submodule churn are explicitly excluded — neither
    # represents a real source change for cache-busting purposes.
    # CMAKE_CONFIGURE_DEPENDS forces a reconfigure on any web-source edit
    # — the cache tag is captured at configure time.
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/web/sw.js"
        "${CMAKE_CURRENT_SOURCE_DIR}/web/shell.html"
        "${CMAKE_CURRENT_SOURCE_DIR}/web/shell.css"
        "${CMAKE_CURRENT_SOURCE_DIR}/web/shell-touch.js"
        "${CMAKE_CURRENT_SOURCE_DIR}/web/shell-saves.js"
        "${CMAKE_CURRENT_SOURCE_DIR}/web/manifest.webmanifest"
        ${_PWA_FONTS}
    )
    find_package(Git QUIET)
    set(_pc_web_sha "")
    if(Git_FOUND)
        execute_process(
            COMMAND ${GIT_EXECUTABLE} -C "${CMAKE_SOURCE_DIR}" rev-parse --short=12 HEAD
            OUTPUT_VARIABLE _pc_web_sha
            OUTPUT_STRIP_TRAILING_WHITESPACE
            RESULT_VARIABLE _pc_web_git_rc
            ERROR_QUIET
        )
        if(NOT _pc_web_git_rc EQUAL 0)
            set(_pc_web_sha "")
        endif()
    endif()
    if(_pc_web_sha)
        set(PC_WEB_BUILD_TAG "${_pc_web_sha}")
        execute_process(
            COMMAND ${GIT_EXECUTABLE} -C "${CMAKE_SOURCE_DIR}"
                    status --porcelain --untracked-files=no --ignore-submodules=all
            OUTPUT_VARIABLE _pc_web_status
            OUTPUT_STRIP_TRAILING_WHITESPACE
            ERROR_QUIET
        )
        if(_pc_web_status)
            string(TIMESTAMP _pc_web_ts "%Y%m%d%H%M")
            set(PC_WEB_BUILD_TAG "${PC_WEB_BUILD_TAG}-dirty-${_pc_web_ts}")
        endif()
    else()
        string(TIMESTAMP _pc_web_ts "%Y%m%d%H%M%S")
        set(PC_WEB_BUILD_TAG "dev-${_pc_web_ts}")
    endif()
    set(PC_WEB_CACHE_VERSION "acgc-${PC_WEB_BUILD_TAG}")
    message(STATUS "PWA build tag: ${PC_WEB_BUILD_TAG} (SW cache: ${PC_WEB_CACHE_VERSION})")
    # configure_file stamps @PC_WEB_BUILD_TAG@ / @PC_WEB_CACHE_VERSION@
    # into sw.js and shell.html — kept on real .html/.js extensions so
    # editors/linters treat them as ordinary sources.
    configure_file(
        "${CMAKE_CURRENT_SOURCE_DIR}/web/sw.js"
        "${CMAKE_BINARY_DIR}/web/sw.js"
        @ONLY
    )
    configure_file(
        "${CMAKE_CURRENT_SOURCE_DIR}/web/shell.html"
        "${CMAKE_BINARY_DIR}/web/shell.html"
        @ONLY
    )
    # Copy any icon-*.png that exist (icons are optional — the build still
    # works without them, the manifest just won't have art).
    file(GLOB _PWA_ICONS "${CMAKE_CURRENT_SOURCE_DIR}/web/icon-*.png")
    _pc_web_copy_each("${CMAKE_BINARY_DIR}/web/" ${_PWA_ICONS})
    # nipplejs (touch analog stick library). Not gated by configure-time
    # EXISTS check so dropping in or updating the file picks up without
    # re-running CMake; missing file fails the build with a clear error.
    add_custom_command(TARGET ac_pc POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/web/nipplejs.min.js"
            "${CMAKE_BINARY_DIR}/web/nipplejs.min.js"
        BYPRODUCTS "${CMAKE_BINARY_DIR}/web/nipplejs.min.js"
        COMMENT "Copying nipplejs.min.js (touch analog stick)"
    )
else()
    add_executable(ac_pc ${_AC_SOURCES} ${RC_FILE})

    # Link SDL2 without SDL2main (we define SDL_MAIN_HANDLED)
    if(TARGET SDL2::SDL2)
        target_link_libraries(ac_pc glad SDL2::SDL2)
    else()
        list(FILTER SDL2_LIBRARIES EXCLUDE REGEX "SDL2main")
        target_link_libraries(ac_pc glad ${SDL2_LIBRARIES})
    endif()

    if(WIN32)
        target_link_libraries(ac_pc opengl32 winmm imm32 version setupapi)
    else()
        find_package(OpenGL REQUIRED)
        target_link_libraries(ac_pc OpenGL::GL dl pthread m)
    endif()

    set_target_properties(ac_pc PROPERTIES
        OUTPUT_NAME "AnimalCrossing"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    )

    # Copy shader files to output directory (loaded at runtime, with embedded fallback)
    add_custom_command(TARGET ac_pc POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_BINARY_DIR}/bin/shaders"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/shaders/default.vert"
            "${CMAKE_CURRENT_SOURCE_DIR}/shaders/default.frag"
            "${CMAKE_BINARY_DIR}/bin/shaders/"
        COMMENT "Copying shader files to bin/shaders/"
    )

    # Copy SDL2.dll next to executable so users don't need it on PATH
    if(WIN32)
        find_file(SDL2_DLL_PATH SDL2.dll PATHS
            "${SDL2_MSYS2_DIR}/bin"
            "${SDL2_DOWNLOAD_DIR}/bin"
            "${SDL2_LOCAL_DIR}/bin"
            "$ENV{MINGW_PREFIX}/bin"
        )
        if(SDL2_DLL_PATH)
            add_custom_command(TARGET ac_pc POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "${SDL2_DLL_PATH}" "${CMAKE_BINARY_DIR}/bin/"
                COMMENT "Copying SDL2.dll to bin/"
            )
        endif()
    endif()

    # Static link MinGW runtime (no libgcc_s_dw2-1.dll, libstdc++-6.dll, libwinpthread-1.dll)
    # Strip version.o from winpthread to prevent its version resource from overriding app.rc
    if(MINGW)
        find_file(WINPTHREAD_LIB libwinpthread.a PATHS ${CMAKE_C_IMPLICIT_LINK_DIRECTORIES} /mingw32/lib NO_DEFAULT_PATH)
        if(NOT WINPTHREAD_LIB)
            find_file(WINPTHREAD_LIB libwinpthread.a)
        endif()
        set(WINPTHREAD_STRIPPED "${CMAKE_CURRENT_BINARY_DIR}/libwinpthread_stripped.a")
        if(WINPTHREAD_LIB AND NOT EXISTS "${WINPTHREAD_STRIPPED}")
            file(COPY_FILE ${WINPTHREAD_LIB} ${WINPTHREAD_STRIPPED})
            execute_process(COMMAND ${CMAKE_AR} d "${WINPTHREAD_STRIPPED}" version.o)
            message(STATUS "Stripped version.o from winpthread: ${WINPTHREAD_STRIPPED}")
        endif()
        target_link_options(ac_pc PRIVATE -static-libgcc -static-libstdc++ -Wl,-Bstatic,--whole-archive "${WINPTHREAD_STRIPPED}" -Wl,-Bdynamic,--no-whole-archive)
    endif()

    # Hide console window on Windows (GUI subsystem)
    # Use -DPC_CONSOLE=ON to keep the console visible for debugging
    if(WIN32 AND NOT PC_CONSOLE)
        target_link_options(ac_pc PRIVATE -mwindows)
    endif()
endif()

# =============================================================================
# Install rules (cmake --install . --prefix <dest>) - desktop only
# =============================================================================
if(NOT ANDROID AND NOT EMSCRIPTEN)
    install(TARGETS ac_pc RUNTIME DESTINATION bin)
    install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/shaders/"
        DESTINATION bin/shaders
        FILES_MATCHING PATTERN "*.vert" PATTERN "*.frag"
    )
endif()
