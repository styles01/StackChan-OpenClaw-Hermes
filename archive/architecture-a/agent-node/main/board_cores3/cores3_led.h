// CoreS3 LED + emotion controller for StackChan-OpenClaw-Hermes
// WS2812C ×12 LEDs via AW9523 IO expander
// 10-mode emotion state machine from stackchan-gemini-firmware
// LED state machine from robot-bridge (idle=off, wake=green, think=rainbow, reply=blue)

#ifndef CORES3_LED_H
#define CORES3_LED_H

#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Emotion states (from stackchan-gemini-firmware, 10 modes)
typedef enum {
    CORES3_EMOTION_NEUTRAL = 0,
    CORES3_EMOTION_LISTENING,
    CORES3_EMOTION_SPEAKING,
    CORES3_EMOTION_THINKING,
    CORES3_EMOTION_LOOKING,
    CORES3_EMOTION_HAPPY,
    CORES3_EMOTION_ANGRY,
    CORES3_EMOTION_FOUND,
    CORES3_EMOTION_ERROR,
    CORES3_EMOTION_SLEEP,
} cores3_emotion_t;

// LED states (from robot-bridge, 4-state simplified)
typedef enum {
    CORES3_LED_OFF = 0,
    CORES3_LED_WAKE,       // green for 1.8s on wake
    CORES3_LED_THINK,      // rainbow chase while processing
    CORES3_LED_REPLY,      // blue while speaking
} cores3_led_state_t;

// Initialize LED driver (via AW9523 IO expander)
esp_err_t cores3_led_init(void);

// Set emotion state (controls both LEDs and display face overlay)
esp_err_t cores3_led_set_emotion(cores3_emotion_t emotion);

// Set LED state directly (overrides emotion-driven LED)
esp_err_t cores3_led_set_state(cores3_led_state_t state);

// Call from main loop — non-blocking animation updates
void cores3_led_loop(void);

// Get current state
cores3_emotion_t cores3_led_current_emotion(void);
cores3_led_state_t cores3_led_current_state(void);
const char *cores3_led_emotion_name(cores3_emotion_t emotion);

#ifdef __cplusplus
}
#endif

#endif // CORES3_LED_H