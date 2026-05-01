/* pc_audio.c - SDL2 audio backend with dedicated producer thread.
 *
 * Architecture (matches GC):
 *   Game thread:  Na_GameFrame() queues commands via message queues
 *   Audio thread: pc_audio_process_frame() produces samples into ring buffer
 *   SDL callback: reads ring buffer → speakers
 *
 * The audio thread decouples sample production from the game frame,
 * so OS preemption of the game thread doesn't cause audio dropouts.
 */
#include "pc_platform.h"
#include "jaudio_NES/audiothread.h"

#define PC_AUDIO_SAMPLE_RATE 32000

/* lock-free SPSC ring buffer (producer=audio thread, consumer=SDL callback) */
#define RING_BUF_SAMPLES (32768) /* ~512ms at 32kHz stereo */
#define RING_BUF_MASK    (RING_BUF_SAMPLES - 1)

/* Produce more samples when buffer drops below this level. ~75 ms keeps
 * latency tight; the catch-up loop in pc_audio_pump_if_needed refills
 * after stutters drop the ring lower, so this is a floor, not a target. */
#define AUDIO_PRODUCE_THRESHOLD 4800

static s16 ring_buffer[RING_BUF_SAMPLES];
static SDL_atomic_t ring_write_pos; /* written by audio producer thread */
static SDL_atomic_t ring_read_pos;  /* written by SDL audio callback */
static SDL_AudioDeviceID audio_device = 0;

typedef void (*AIDMACallback)(void);
static AIDMACallback ai_dma_callback = NULL;
static u32 ai_dsp_sample_rate = PC_AUDIO_SAMPLE_RATE;

/* --- Audio producer thread --- */
static SDL_Thread* audio_producer_thread = NULL;
static SDL_atomic_t audio_thread_running;

static int pc_audio_producer_func(void* data) {
    (void)data;
    while (SDL_AtomicGet(&audio_thread_running)) {
        int fill = pc_audio_get_buffer_fill();
        if (fill < AUDIO_PRODUCE_THRESHOLD) {
            pc_audio_process_frame();
        } else {
            SDL_Delay(1);
        }
    }
    return 0;
}

void pc_audio_start_producer_thread(void) {
#ifdef __EMSCRIPTEN__
    /* No producer thread under Emscripten — single-threaded wasm.
     * pc_audio_pump_if_needed() is called from pc_vi.c each frame. */
    (void)pc_audio_producer_func;
    return;
#else
    if (audio_producer_thread) return;
    SDL_AtomicSet(&audio_thread_running, 1);
    audio_producer_thread = SDL_CreateThread(pc_audio_producer_func, "AudioProducer", NULL);
    if (audio_producer_thread) {
        printf("[AUDIO] Producer thread started\n");
    } else {
        printf("[AUDIO] Failed to create producer thread: %s\n", SDL_GetError());
    }
#endif
}

/* Called from pc_vi.c under Emscripten (and harmlessly on other platforms).
 * Keeps the ring buffer filled without a dedicated thread. On web the game
 * loop runs single-threaded, so if its frame rate dips below 60 Hz a single
 * audio-frame-per-game-frame can't keep up with the audio device's pull
 * rate. Loop until the ring is at or above the threshold so we catch up
 * after a stutter rather than dragging behind it. Bounded so a stuck
 * sequencer can't burn unbounded time here. */
void pc_audio_pump_if_needed(void) {
    /* Cap to 2 catch-up iterations per VI tick. The previous cap of 16
     * let one frame burn ~50–65 ms running the JaiSeq sequencer + mixer
     * + SDL_ResampleAudio in a tight loop when the audio buffer dipped
     * below threshold (e.g., right after a press triggers a new sound).
     * That blew the 16.67 ms frame budget by 3–4×, producing the
     * "stutter on press" observed on Snapdragon 8 Gen 3 phones. With
     * safety=2 the buffer catches up across multiple frames instead of
     * in a single tick; the AUDIO_PRODUCE_THRESHOLD headroom still
     * absorbs the dip without underrunning the audio device. */
    int safety = 2;
    while (safety-- > 0 && pc_audio_get_buffer_fill() < AUDIO_PRODUCE_THRESHOLD) {
        pc_audio_process_frame();
    }
}

/* --- SDL audio callback (runs on SDL's audio device thread) --- */
static void pc_audio_callback(void* userdata, Uint8* stream, int len) {
    s16* out = (s16*)stream;
    int total_samples = len / sizeof(s16);
    u32 wp = (u32)SDL_AtomicGet(&ring_write_pos);
    SDL_MemoryBarrierAcquire();
    u32 rp = (u32)SDL_AtomicGet(&ring_read_pos);
    u32 used = wp - rp;

    /* overrun: producer lapped us */
    if (used > RING_BUF_SAMPLES) {
        rp = wp - RING_BUF_SAMPLES;
        rp &= ~1u; /* stereo-align */
        used = wp - rp;
    }

    int avail = (int)used;
    avail &= ~1; /* whole stereo frames only */
    int copy = (avail < total_samples) ? avail : total_samples;
    copy &= ~1;

    for (int i = 0; i < copy; i++) {
        out[i] = ring_buffer[(rp + i) & RING_BUF_MASK];
    }
    if (copy < total_samples) {
        memset(&out[copy], 0, (total_samples - copy) * sizeof(s16));
    }

    SDL_MemoryBarrierRelease();
    SDL_AtomicSet(&ring_read_pos, (int)(rp + copy));
}

/* --- AI (Audio Interface) --- */

void AIInit(u8* stack) {
    (void)stack;
    if (audio_device != 0) return;

    SDL_AudioSpec want, have;
    memset(&want, 0, sizeof(want));
    want.freq = PC_AUDIO_SAMPLE_RATE;
    want.format = AUDIO_S16SYS;
    want.channels = 2;
    /* 512 samples (~16 ms) is the lowest-latency request; SDL/the OS
     * may coerce upward (Android in particular often picks ≥1024). The
     * catch-up loop in pc_audio_pump_if_needed handles short stutters
     * without needing the device buffer to grow. */
    want.samples = 512;
    want.callback = pc_audio_callback;

    audio_device = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
    if (audio_device != 0) {
        printf("[AUDIO] Opened: freq=%d fmt=0x%04X ch=%d samples=%d (requested: freq=%d)\n",
               have.freq, have.format, have.channels, have.samples, want.freq);
    } else {
        printf("[AUDIO] Failed to open: %s\n", SDL_GetError());
    }
}

void AIInitDMA(u32 addr, u32 size) {
    s16* src = (s16*)(uintptr_t)addr;
    u32 n_samples = size / sizeof(s16);
    n_samples &= ~1u; /* whole stereo frames */

    u32 wp = (u32)SDL_AtomicGet(&ring_write_pos);
    u32 rp = (u32)SDL_AtomicGet(&ring_read_pos);
    SDL_MemoryBarrierAcquire();
    u32 used = wp - rp;
    u32 free = RING_BUF_SAMPLES - used;

    if (n_samples > free) {
        n_samples = free & ~1u;
    }

    for (u32 i = 0; i < n_samples; i++) {
        ring_buffer[(wp + i) & RING_BUF_MASK] = src[i];
    }

    SDL_MemoryBarrierRelease();
    SDL_AtomicSet(&ring_write_pos, (int)(wp + n_samples));
}

void AIStartDMA(void) {
    if (audio_device != 0) SDL_PauseAudioDevice(audio_device, 0);
}

void AIStopDMA(void) {
    if (audio_device != 0) SDL_PauseAudioDevice(audio_device, 1);
}

u32  AIGetDMAStartAddr(void) { return 0; }
u16  AIGetDMALength(void) { return 0; }
u32  AIGetStreamTrigger(void) { return 0; }
u32  AIGetStreamSampleCount(void) { return 0; }
void AISetStreamPlayState(u32 state) { (void)state; }
u32  AIGetStreamPlayState(void) { return 0; }
void AISetStreamSampleRate(u32 rate) { (void)rate; }
u32  AIGetStreamSampleRate(void) { return PC_AUDIO_SAMPLE_RATE; }
void AISetStreamVolLeft(u8 vol) { (void)vol; }
void AISetStreamVolRight(u8 vol) { (void)vol; }
u8   AIGetStreamVolLeft(void) { return 0; }
u8   AIGetStreamVolRight(void) { return 0; }
void AIResetStreamSampleCount(void) {}
void AISetDSPSampleRate(u32 rate) { ai_dsp_sample_rate = rate; }
u32  AIGetDSPSampleRate(void) { return ai_dsp_sample_rate; }

void* AIRegisterDMACallback(void* callback) {
    void* old = (void*)ai_dma_callback;
    ai_dma_callback = (AIDMACallback)callback;
    return old;
}

/* --- DSP stubs (rspsim does everything in software) --- */

void DSPInit(void) {}
BOOL DSPCheckMailToDSP(void) { return FALSE; }
BOOL DSPCheckMailFromDSP(void) { return FALSE; }
u32  DSPReadMailFromDSP(void) { return 0; }
void DSPSendMailToDSP(u32 mail) { (void)mail; }
void DSPAssertInt(void) {}
void* DSPAddTask(void* task) { return task; }

/* --- ring buffer queries for frame pacing (pc_vi.c) --- */

int pc_audio_get_buffer_fill(void) {
    return SDL_AtomicGet(&ring_write_pos) - SDL_AtomicGet(&ring_read_pos);
}

int pc_audio_is_active(void) {
    return audio_device != 0;
}

void pc_audio_shutdown(void) {
    /* Stop producer thread first */
    SDL_AtomicSet(&audio_thread_running, 0);
    if (audio_producer_thread) {
        SDL_WaitThread(audio_producer_thread, NULL);
        audio_producer_thread = NULL;
    }
    if (audio_device != 0) {
        SDL_CloseAudioDevice(audio_device);
        audio_device = 0;
    }
}
