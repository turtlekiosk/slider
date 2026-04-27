#ifndef M_COCKROACH_H
#define M_COCKROACH_H

#include "types.h"
#include "m_home_h.h"

#ifdef __cplusplus
extern "C" {
#endif

#define mCkRh_MAX_NUM 10 /* maximum 'stored' in the house */
#define mCkRh_INTERVAL_DAYS 6 /* number of days before roaches will spawn */

#define mCkRh_CAN_LOOK_GOKI_NUM 3 /* maximum that can spawn in the house at once */

extern void mCkRh_InitGokiSaveData_InitNewPlayer(void);
extern void mCkRh_InitGokiSaveData_1Room(int home_no);
extern void mCkRh_InitGokiSaveData_1Room_ByHomeData(mHm_hs_c* home);
extern void mCkRh_InitGokiSaveData_IslandPlayerRoom(void);
extern void mCkRh_InitGokiSaveData_AllRoom(void);
extern void mCkRh_SetGoingOutCottageTime(int scene_id);
extern void mCkRh_SavePlayTime(int player_no);
extern void mCkRh_DecideNowGokiFamilyCount(int player_no);
extern int mCkRh_PlussGokiN_NowRoom(int count, int scene_no);
extern int mCkRh_MinusGokiN_NowRoom(int count, int scene_id);
extern int mCkRh_NowSceneGokiFamilyCount(void);
extern void mCkRh_InitCanLookGokiCount(void);
extern int mCkRh_CalcCanLookGokiCount(int count);
extern int mCkRh_GetCanLookGokiCount(void);

#ifdef __cplusplus
}
#endif

#endif
