#ifndef M_EAPPLI_H
#define M_EAPPLI_H

#include "types.h"

#ifdef __cplusplus
extern "C" {
#endif

extern void mEA_InitLetterCardE(void);
extern int mEA_CheckLetterCardE(int card_no);
extern void mEA_SetLetterCardE(int card_no);
extern void mEA_GetCardDLProgram(void);
extern void mEA_CleanCardDLProgram(void);
extern u8* mEA_dl_carde_program_p(void);
extern size_t mEA_dl_carde_program_size(void);

#ifdef __cplusplus
}
#endif

#endif
