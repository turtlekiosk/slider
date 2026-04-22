#ifndef PC_VMEM_H
#define PC_VMEM_H

#ifdef __cplusplus
extern "C" {
#endif

/* Returns 1 if the page containing addr is committed/mapped in this process,
 * 0 otherwise. Used by emu64::seg2k0 to distinguish raw PC heap pointers from
 * N64 segment addresses. */
int pc_vmem_is_page_committed(unsigned int addr);

#ifdef __cplusplus
}
#endif
#endif
