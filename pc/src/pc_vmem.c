#include "pc_platform.h"
#include "pc_vmem.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

int pc_vmem_is_page_committed(unsigned int addr) {
    MEMORY_BASIC_INFORMATION mbi;
    return (VirtualQuery((void*)(uintptr_t)addr, &mbi, sizeof(mbi)) > 0 &&
            mbi.State == MEM_COMMIT) ? 1 : 0;
}

#elif defined(__EMSCRIPTEN__)
/* wasm has a flat linear memory with no per-page commit state; treat all
 * addresses as committed. emu64::seg2k0 falls through to normal segment
 * resolution, matching the original GC behavior. */
int pc_vmem_is_page_committed(unsigned int addr) {
    (void)addr;
    return 1;
}

#else
#include <sys/mman.h>

int pc_vmem_is_page_committed(unsigned int addr) {
    unsigned char vec;
    return (mincore((void*)(uintptr_t)(addr & ~0xFFFu), 1, &vec) == 0) ? 1 : 0;
}
#endif
