// CoreS3 servo driver for StackChan-OpenClaw-Hermes
// SCSCL serial-bus servos on UART1 (GPIO6 TX / GPIO7 RX)
// Non-blocking gesture queue pattern from stackchan-gemini-firmware
//
// BSP angle units: 10 = 1 degree
// Yaw range:   -1280..1280 (±128°)
// Pitch range:  0..900     (0-90°, physical safe ~120-700)

#include "cores3_servo.h"
#include "esp_log.h"
#include "esp_check.h"
#include "driver/uart.h"
#include <string.h>
#include <math.h>

#define TAG "cores3_servo"

// SCSCL protocol constants
#define SCSCL_HEADER            0xFF
#define SCSCL_BROADCAST_ID       0xFE
#define SCSCL_REG_TORQUE_ENABLE  0x28
#define SCSCL_REG_GOAL_POSITION  0x2C
#define SCSCL_REG_GOAL_SPEED     0x2A
#define SCSCL_SERVO_YAW_ID       1
#define SCSCL_SERVO_PITCH_ID     2

// Gesture definitions (from stackchan-mcp + stackchan-gemini-firmware patterns)
typedef struct {
    const char *name;
    cores3_servo_step_t steps[CORES3_SERVO_MAX_STEPS];
    uint8_t step_count;
} servo_gesture_t;

static const servo_gesture_t s_gestures[] = {
    {
        .name = "nod",
        .steps = {
            { 0, 120, 500, 200, false },   // neutral
            { 0, 200, 500, 300, false },   // look down
            { 0, 80,  500, 300, false },   // look up
            { 0, 120, 500, 200, false },   // back to neutral
        },
        .step_count = 4,
    },
    {
        .name = "shake",
        .steps = {
            { 0,   120, 500, 200, false },  // neutral
            { 200, 120, 500, 300, false },  // look right
            { -200,120, 500, 300, false },  // look left
            { 0,   120, 500, 200, false },  // back to neutral
        },
        .step_count = 4,
    },
    {
        .name = "look_around",
        .steps = {
            { 0,    120, 300, 500, false },  // neutral
            { 400,  120, 300, 800, false },  // look right
            { -400, 120, 300, 800, false },  // look left
            { 0,    200, 300, 500, false },  // center + down
            { 0,    80,  300, 500, false },  // center + up
            { 0,    120, 300, 300, false },  // back to neutral
        },
        .step_count = 6,
    },
    {
        .name = "happy",
        .steps = {
            { 0, 120, 800, 150, false },
            { 0, 60,  800, 200, false },
            { 0, 180, 800, 200, false },
            { 0, 120, 800, 150, false },
        },
        .step_count = 4,
    },
};

static const int s_gesture_count = sizeof(s_gestures) / sizeof(s_gestures[0]);

// Driver state
static bool s_initialized = false;
static bool s_active = false;
static char s_current_gesture[32] = "idle";
static cores3_servo_step_t s_steps[CORES3_SERVO_MAX_STEPS];
static uint8_t s_step_count = 0;
static uint8_t s_step_index = 0;
static uint32_t s_next_step_at = 0;
static int s_anchor_x = CORES3_SERVO_YAW_NEUTRAL;
static int s_anchor_y = CORES3_SERVO_PITCH_NEUTRAL;

// --- SCSCL protocol helpers ---

static esp_err_t scscl_write_reg(uint8_t id, uint8_t reg, uint16_t value)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;

    uint8_t packet[10];
    packet[0] = SCSCL_HEADER;
    packet[1] = SCSCL_HEADER;
    packet[2] = id;
    packet[3] = 5;  // length = params(2) + instruction(1) + checksum(1)
    packet[4] = 0x03;  // WRITE instruction
    packet[5] = reg;
    packet[6] = (value >> 8) & 0xFF;
    packet[7] = value & 0xFF;
    packet[8] = ~(packet[2] + packet[3] + packet[4] + packet[5] + packet[6] + packet[7]) & 0xFF;

    int written = uart_write_bytes(CORES3_SERVO_UART, packet, 9);
    if (written != 9) {
        ESP_LOGE(TAG, "SCSCL write failed for servo %d reg 0x%02X", id, reg);
        return ESP_FAIL;
    }
    return ESP_OK;
}

static esp_err_t scscl_enable_torque(uint8_t id, bool enable)
{
    return scscl_write_reg(id, SCSCL_REG_TORQUE_ENABLE, enable ? 1 : 0);
}

static esp_err_t scscl_move(uint8_t id, int position, int speed)
{
    // Clamp to safe ranges
    if (id == SCSCL_SERVO_YAW_ID) {
        if (position < CORES3_SERVO_YAW_MIN) position = CORES3_SERVO_YAW_MIN;
        if (position > CORES3_SERVO_YAW_MAX) position = CORES3_SERVO_YAW_MAX;
    } else if (id == SCSCL_SERVO_PITCH_ID) {
        if (position < CORES3_SERVO_PITCH_MIN) position = CORES3_SERVO_PITCH_MIN;
        if (position > CORES3_SERVO_PITCH_MAX) position = CORES3_SERVO_PITCH_MAX;
    }

    // Set speed first, then position
    if (speed > 0) {
        scscl_write_reg(id, SCSCL_REG_GOAL_SPEED, speed);
    }
    return scscl_write_reg(id, SCSCL_REG_GOAL_POSITION, (uint16_t)position);
}

// --- Public API ---

esp_err_t cores3_servo_init(void)
{
    if (s_initialized) return ESP_OK;

    uart_config_t uart_cfg = {
        .baud_rate = CORES3_SERVO_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_RETURN_ON_ERROR(uart_param_config(CORES3_SERVO_UART, &uart_cfg), TAG, "UART1 config");
    ESP_RETURN_ON_ERROR(uart_set_pin(CORES3_SERVO_UART,
        CORES3_SERVO_TX_PIN, CORES3_SERVO_RX_PIN,
        UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE), TAG, "UART1 pins");
    ESP_RETURN_ON_ERROR(uart_driver_install(CORES3_SERVO_UART, 256, 256, 0, NULL, 0), TAG, "UART1 driver");

    // Enable torque on both servos
    scscl_enable_torque(SCSCL_SERVO_YAW_ID, true);
    scscl_enable_torque(SCSCL_SERVO_PITCH_ID, true);

    // Move to neutral
    scscl_move(SCSCL_SERVO_YAW_ID, CORES3_SERVO_YAW_NEUTRAL, 500);
    scscl_move(SCSCL_SERVO_PITCH_ID, CORES3_SERVO_PITCH_NEUTRAL, 500);

    s_initialized = true;
    s_anchor_x = CORES3_SERVO_YAW_NEUTRAL;
    s_anchor_y = CORES3_SERVO_PITCH_NEUTRAL;
    ESP_LOGI(TAG, "Servos initialized: UART1 @ %d baud, yaw+pitch at neutral",
             CORES3_SERVO_BAUD);
    return ESP_OK;
}

esp_err_t cores3_servo_queue_gesture(const char *name)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;

    for (int i = 0; i < s_gesture_count; i++) {
        if (strcmp(s_gestures[i].name, name) == 0) {
            return cores3_servo_queue_steps(name, s_gestures[i].steps, s_gestures[i].step_count);
        }
    }
    ESP_LOGW(TAG, "Unknown gesture: %s", name);
    return ESP_ERR_NOT_FOUND;
}

esp_err_t cores3_servo_queue_steps(const char *name,
                                    const cores3_servo_step_t *steps,
                                    uint8_t count)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    if (count == 0 || count > CORES3_SERVO_MAX_STEPS) return ESP_ERR_INVALID_ARG;
    if (s_active) {
        ESP_LOGW(TAG, "Gesture already running, ignoring '%s'", name);
        return ESP_ERR_INVALID_STATE;
    }

    memcpy(s_steps, steps, count * sizeof(cores3_servo_step_t));
    s_step_count = count;
    s_step_index = 0;
    s_active = true;
    s_next_step_at = 0;  // Execute immediately
    strncpy(s_current_gesture, name ? name : "custom", sizeof(s_current_gesture) - 1);
    s_current_gesture[sizeof(s_current_gesture) - 1] = '\0';
    return ESP_OK;
}

esp_err_t cores3_servo_move_to(int yaw, int pitch, int speed)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    scscl_move(SCSCL_SERVO_YAW_ID, yaw, speed);
    scscl_move(SCSCL_SERVO_PITCH_ID, pitch, speed);
    s_anchor_x = yaw;
    s_anchor_y = pitch;
    return ESP_OK;
}

void cores3_servo_stop(void)
{
    s_active = false;
    s_step_index = 0;
    s_step_count = 0;
    strncpy(s_current_gesture, "idle", sizeof(s_current_gesture) - 1);
}

void cores3_servo_loop(void)
{
    if (!s_initialized || !s_active) return;

    uint32_t now = esp_timer_get_time() / 1000;  // ms
    if (s_next_step_at > 0 && now < s_next_step_at) return;

    if (s_step_index >= s_step_count) {
        // Gesture complete
        s_active = false;
        s_step_index = 0;
        s_step_count = 0;
        strncpy(s_current_gesture, "idle", sizeof(s_current_gesture) - 1);
        return;
    }

    const cores3_servo_step_t *step = &s_steps[s_step_index];
    int target_x = step->relative ? s_anchor_x + step->x : step->x;
    int target_y = step->relative ? s_anchor_y + step->y : step->y;

    scscl_move(SCSCL_SERVO_YAW_ID, target_x, step->speed);
    scscl_move(SCSCL_SERVO_PITCH_ID, target_y, step->speed);

    if (step->relative) {
        s_anchor_x += step->x;
        s_anchor_y += step->y;
    } else {
        s_anchor_x = step->x;
        s_anchor_y = step->y;
    }

    s_next_step_at = now + step->hold_ms;
    s_step_index++;
}

const char *cores3_servo_current_gesture(void) { return s_current_gesture; }
bool cores3_servo_is_active(void) { return s_active; }
int cores3_servo_anchor_x(void) { return s_anchor_x; }
int cores3_servo_anchor_y(void) { return s_anchor_y; }