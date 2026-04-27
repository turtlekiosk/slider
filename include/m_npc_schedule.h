#ifndef M_NPC_SCHEDULE_H
#define M_NPC_SCHEDULE_H

#include "types.h"
#include "m_npc_schedule_h.h"

#ifdef __cplusplus
extern "C" {
#endif

extern mNPS_schedule_c* mNPS_get_schedule_area(AnmPersonalID_c* anm_id);
extern void mNPS_set_island_schedule_area(AnmPersonalID_c* anm_id);
extern void mNPS_reset_schedule_area(AnmPersonalID_c* anm_id);
extern void mNPS_schedule_manager(void);
extern void mNPS_set_all_schedule_area(void);

#ifdef __cplusplus
}
#endif

#endif
