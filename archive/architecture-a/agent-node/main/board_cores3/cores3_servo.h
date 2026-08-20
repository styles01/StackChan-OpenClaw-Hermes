// CoreS3 servo driver for StackChan-OpenClaw-Hermes
// SCSCL serial-bus servos on UART1 (GPIO6 TX / GPIO7 RX)
// Non-blocking gesture queue pattern from stackchan-gemini-firmware
//
// BSP angle units: 10 = 1 degree
// Yaw range:   -1280..1280 (±128°)
// Pitch range:  0..900     (0-90°, physical safe ~120-700)

#ifndef CORES3_SERVO_H
#define CORES3_SERVO_H

#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Servo angle constants (BSP units: 10 = 1°)
#define CORES3_SERVO_YAW_NEUTRAL     0
#define CORES3_SERVO_YAW_MIN        -1280
#define CORES3_SERVO_YAW_MAX         1280
#define CORES3_SERVO_PITCH_NEUTRAL   120   // ~12° — slightly down
#define CORES3_SERVO_PITCH_MIN       0
#define CORES3_SERVO_PITCH_MAX       900
#define CORES3_SERVO_MAX_STEPS       16
#define CORES3_SERVO_SPEED_MIN       0
#define CORES3_SERVO_SPEED_MAX       1000

// Servo UART pins (CoreS3)
#define CORES3_SERVO_UART            UART_NUM_1
#define CORES3_SERVO_TX_PIN          GPIO_NUM_6
#define CORES3_SERVO_RX_PIN          GPIO_NUM_7
#define CORES3_SERVO_BAUD            1000000  // 1 Mbps (SCSCL default)

typedef struct {
    int x;          // yaw (BSP units)
    int y;          // pitch (BSP units)
    int speed;      // 0-1000
    uint16_t hold_ms;  // hold time at this position
    bool relative;     // true = relative to current position
} cores3_servo_step_t;

typedef enum {
    CORES3_SERVO_IDLE,
    CORES3_SERVO_RUNNING,
} cores3_servo_state_t;

// Initialize servo UART and driver
esp_err_t cores3_servo_init(void);

// Queue a named gesture (nod, shake, look_around, etc.)
// Returns ESP_ERR_NOT_FOUND if gesture name is unknown
esp_err_t cores3_servo_queue_gesture(const char *name);

// Queue raw steps
esp_err_t cores3_servo_queue_steps(const char *name,
                                    const cores3_servo_step_t *steps,
                                    uint8_t count);

// Move to absolute position
esp_err_t cores3_servo_move_to(int yaw, int pitch, int speed);

// Stop any running gesture
void cores3_servo_stop(void);

// Call from main loop — non-blocking, executes queued steps
void cores3_servo_loop(void);

// Status
const char *cores3_servo_current_gesture(void);
bool cores3_servo_is_active(void);
int cores3_servo_anchor_x(void);
int cores3_servo_anchor_y(void);

#ifdef __cplusplus
}
#endif

#endif // CORES3_SERVO_H