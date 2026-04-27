#ifndef M_BGM_H
#define M_BGM_H

#include "types.h"
#include "game_h.h"
#include "m_lib.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
    mBGM_PAUSE_0,
    mBGM_PAUSE_1,
    mBGM_PAUSE_MSCORE,
    mBGM_PAUSE_NOTICE,
    mBGM_PAUSE_4,
    mBGM_PAUSE_STOP,

    mBGM_PAUSE_NUM
};

extern void mBGMPsComp_make_ps_fanfare(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_make_ps_lost_fanfare(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_make_ps_wipe(u16 stop_type);
extern void mBGMPsComp_make_ps_quiet(u16 stop_type);
extern void mBGMPsComp_make_ps_co_quiet(u16 stop_type, s16 counter);
extern void mBGMPsComp_make_ps_fc_quiet(u16 stop_type);
extern void mBGMPsComp_make_ps_demo(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_make_ps_happening(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_make_ps_room(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_make_ps_quietField(u16 stop_type);
extern void mBGMPsComp_make_ps_fc_quietField(u16 stop_type);
extern void mBGMPsComp_make_ps_fieldSuddenEv(u8 bgm_num, u16 stop_type, u8 priority);
extern void mBGMPsComp_delete_ps_fanfare(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_delete_ps_quiet(void);
extern void mBGMPsComp_delete_ps_demo(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_delete_ps_happening(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_delete_ps_room(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_delete_ps_quietField(void);
extern void mBGMPsComp_delete_ps_fieldSuddenEv(u8 bgm_num, u16 stop_type);
extern void mBGMPsComp_volume_fishing_start(void);
extern void mBGMPsComp_volume_fishing_end(void);
extern void mBGMPsComp_volume_collect_insects_start(void);
extern void mBGMPsComp_volume_collect_insects_end(void);
extern void mBGMPsComp_volume_talk_start(void);
extern void mBGMPsComp_volume_talk_end(void);
extern void mBGMPsComp_volume_boat_start(void);
extern void mBGMPsComp_volume_boat_end(void);
extern void mBGMPsComp_pause(int state);
extern void mBGMPsComp_MDPlayerPos_make(void);
extern void mBGMPsComp_MDPlayerPos_delete(void);
extern void mBGMPsComp_MDPlayerPos_param_set(const xyz_t* pos, u16 angle, u16 md_type, u32 ongen_no);
extern void mBGMPsComp_scene_mode(u8 mode);
extern void mBGMPsComp_museum_status(u8 status);
extern int mBGMPsComp_execute_bgm_num_get(void);
extern void mBGMForce_inform_start(void);
extern void mBGMForce_inform_end(void);
extern void mBGMForce_room_nonstop_start(void);
extern void mBGM_main(GAME* game);
extern void mBGM_ct(void);
extern void mBGM_init(void);
extern void mBGM_cleanup(void);
extern void mBGM_reset(void);

#ifdef __cplusplus
}
#endif

#endif
