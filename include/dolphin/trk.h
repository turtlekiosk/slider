#ifndef _DOLPHIN_TRK_H
#define _DOLPHIN_TRK_H

#include "types.h"

#ifdef __cplusplus
extern "C" {
#endif // ifdef __cplusplus

unsigned int TRKTargetContinue(void);
void TRKTargetSetStopped(unsigned int);
void TRKSwapAndGo(void);

void UnreserveEXI2Port(void);
void ReserveEXI2Port(void);

#ifdef __cplusplus
};
#endif // ifdef __cplusplus

#endif
