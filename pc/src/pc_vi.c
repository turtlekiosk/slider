/* pc_vi.c - video interface → SDL window swap + frame pacing */
#include "pc_platform.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#define VI_TVMODE_NTSC_INT    0
#define VI_TVMODE_NTSC_DS     1
#define VI_TVMODE_PAL_INT     4
#define VI_TVMODE_MPAL_INT    8
#define VI_TVMODE_EURGB60_INT 20

static u32 retrace_count = 0;
u32 pc_frame_counter = 0;
static Uint64 frame_start_time = 0;
static Uint64 perf_freq = 0;
static void (*vi_pre_callback)(u32) = NULL;
static void (*vi_post_callback)(u32) = NULL;

void VIInit(void) { }

void VIConfigure(void* rm) { (void)rm; }

void VISetNextFrameBuffer(void* fb) { (void)fb; }

void VIFlush(void) {}

void VIWaitForRetrace(void) {
    if (!perf_freq) perf_freq = SDL_GetPerformanceFrequency();

#ifdef TARGET_ANDROID
    {
        static int vi_calls_this_sec = 0;
        static Uint64 vi_sec_start = 0;
        if (vi_sec_start == 0) vi_sec_start = SDL_GetPerformanceCounter();
        vi_calls_this_sec++;
        Uint64 now = SDL_GetPerformanceCounter();
        if ((now - vi_sec_start) * 1000 / SDL_GetPerformanceFrequency() >= 2000) {
            printf("[VI] %d swaps in 2s (%.1f swaps/sec) frame_counter=%u\n",
                   vi_calls_this_sec, vi_calls_this_sec / 2.0, pc_frame_counter);
            vi_calls_this_sec = 0;
            vi_sec_start = now;
        }
    }
#endif

    /* --- frame time diagnostic --- */
    Uint64 vi_enter = SDL_GetPerformanceCounter();
    double frame_ms = 0.0;
    if (frame_start_time) {
        frame_ms = (double)(vi_enter - frame_start_time) * 1000.0 / (double)perf_freq;
    }

    if (!pc_platform_poll_events()) {
        g_pc_running = 0;
        return;
    }

    Uint64 t_before_swap = SDL_GetPerformanceCounter();
    pc_platform_swap_buffers();
    Uint64 t_after_swap = SDL_GetPerformanceCounter();

    Uint64 t_before_pace = SDL_GetPerformanceCounter();
#ifdef __EMSCRIPTEN__
    /* Emscripten: yield to the browser via Asyncify so rAF can paint.
     * Audio is also pumped here since there's no producer thread. */
    extern void pc_audio_pump_if_needed(void);
    pc_audio_pump_if_needed();
    if (!g_pc_no_framelimit) {
        int remain_ms = 0;
        if (frame_start_time) {
            Uint64 now = SDL_GetPerformanceCounter();
            Uint64 elapsed_us = (now - frame_start_time) * 1000000 / perf_freq;
            if (elapsed_us < 16667) {
                remain_ms = (int)((16667 - elapsed_us) / 1000);
                if (remain_ms < 1) remain_ms = 1;
            }
        }
        /* Floor: yield at least 4 ms so iOS Safari has breathing room
         * for raster/compositing. Doesn't extend tab lifetime on devices
         * hitting iOS Safari's deterministic energy watchdog (~50 s on
         * iPhone SE 3 regardless of yield amount), but reduces sustained
         * CPU on capable devices and helps with thermals broadly. */
        if (remain_ms < 4) remain_ms = 4;
        emscripten_sleep(remain_ms);
    } else {
        emscripten_sleep(4); /* minimum yield so the browser can repaint */
    }
#else
    if (!g_pc_no_framelimit) {
        /* Timer-based pacing: sleep until 16ms per frame (~60 FPS).
         * Audio production runs on a dedicated thread and is no longer
         * tied to game frame timing. */
        if (frame_start_time) {
            Uint64 now = SDL_GetPerformanceCounter();
            Uint64 elapsed_us = (now - frame_start_time) * 1000000 / perf_freq;
            /* 16667us = 60.0 Hz (NTSC). Spin for sub-ms precision. */
            while (elapsed_us < 16667) {
                Uint64 remain_us = 16667 - elapsed_us;
                if (remain_us > 2000) {
                    SDL_Delay(1);
                }
                now = SDL_GetPerformanceCounter();
                elapsed_us = (now - frame_start_time) * 1000000 / perf_freq;
            }
        }
    }
#endif
    Uint64 t_after_pace = SDL_GetPerformanceCounter();

    /* report slow frames (>20ms = missed 60fps by >4ms) */
    if (frame_ms > 20.0 && g_pc_verbose) {
        double swap_ms = (double)(t_after_swap - t_before_swap) * 1000.0 / (double)perf_freq;
        double pace_ms = (double)(t_after_pace - t_before_pace) * 1000.0 / (double)perf_freq;
        double work_ms = (double)(vi_enter - frame_start_time) * 1000.0 / (double)perf_freq;
        int audio_fill = pc_audio_get_buffer_fill();
        printf("[STUTTER] frame %u: total=%.1fms work=%.1fms swap=%.1fms pace=%.1fms audio_fill=%d\n",
               pc_frame_counter, frame_ms, work_ms - swap_ms - pace_ms, swap_ms, pace_ms, audio_fill);
    }

    {
        static Uint64 fps_start = 0;
        static int fps_count = 0;
        if (fps_start == 0) fps_start = SDL_GetPerformanceCounter();
        fps_count++;
        if (fps_count >= 60) {
            Uint64 now = SDL_GetPerformanceCounter();
            double secs = (double)(now - fps_start) / (double)perf_freq;
            double fps = (double)fps_count / secs;
            char title[64];
            snprintf(title, sizeof(title), "Animal Crossing - %.1f FPS", fps);
            SDL_SetWindowTitle(g_pc_window, title);
            fps_start = now;
            fps_count = 0;
        }
    }

    frame_start_time = SDL_GetPerformanceCounter();

    retrace_count++;
    pc_frame_counter++;
}

u32 VIGetRetraceCount(void) { return retrace_count; }

void VISetBlack(BOOL black) { (void)black; }

u32 VIGetTvFormat(void) { return 0; /* VI_NTSC */ }
u32 VIGetDTVStatus(void) { return 0; }

void* VISetPreRetraceCallback(void* cb) {
    void* old = (void*)vi_pre_callback;
    vi_pre_callback = (void (*)(u32))cb;
    return old;
}

void* VISetPostRetraceCallback(void* cb) {
    void* old = (void*)vi_post_callback;
    vi_post_callback = (void (*)(u32))cb;
    return old;
}

u32 VIGetCurrentLine(void) { return 0; }

void VISetNextXFB(void* xfb) { (void)xfb; }
