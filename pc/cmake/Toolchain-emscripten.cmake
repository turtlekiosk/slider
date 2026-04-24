# Emscripten toolchain wrapper.
# Usage: cmake -DCMAKE_TOOLCHAIN_FILE=pc/cmake/Toolchain-emscripten.cmake ..
# (or prefer `emcmake cmake ..`, which sets this automatically)
#
# This resolves the real Emscripten.cmake from $EMSDK or the `emcc` on PATH.

if(NOT DEFINED ENV{EMSDK} AND NOT DEFINED ENV{EMSCRIPTEN})
    message(FATAL_ERROR
        "Emscripten SDK not found.\n"
        "  1. Install emsdk: https://emscripten.org/docs/getting_started/downloads.html\n"
        "  2. Activate it: `source /path/to/emsdk/emsdk_env.sh`\n"
        "  3. Prefer: `emcmake cmake ..` (sets toolchain automatically)")
endif()

if(DEFINED ENV{EMSDK})
    set(_EMSCRIPTEN_TOOLCHAIN "$ENV{EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake")
elseif(DEFINED ENV{EMSCRIPTEN})
    set(_EMSCRIPTEN_TOOLCHAIN "$ENV{EMSCRIPTEN}/cmake/Modules/Platform/Emscripten.cmake")
endif()

if(NOT EXISTS "${_EMSCRIPTEN_TOOLCHAIN}")
    message(FATAL_ERROR "Emscripten.cmake not found at: ${_EMSCRIPTEN_TOOLCHAIN}")
endif()

include("${_EMSCRIPTEN_TOOLCHAIN}")
