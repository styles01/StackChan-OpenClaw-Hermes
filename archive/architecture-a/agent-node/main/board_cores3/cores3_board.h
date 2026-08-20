#pragma once

#include "esp_openclaw_room_node.h"
#include <stdint.h>
#include <stdbool.h>

// CoreS3 hardware constants (from StackChan firmware config.h)
// Display: ILI9342 320x240 SPI
#define CORES3_DISPLAY_WIDTH   320
#define CORES3_DISPLAY_HEIGHT  240

// SPI pins for ILI9342
#define CORES3_LCD_SPI_HOST    SPI3_HOST
#define CORES3_LCD_MOSI        GPIO_NUM_37
#define CORES3_LCD_SCLK        GPIO_NUM_36
#define CORES3_LCD_CS          GPIO_NUM_3
#define CORES3_LCD_DC          GPIO_NUM_35
#define CORES3_LCD_SPI_MODE    2
#define CORES3_LCD_PCLK_HZ     40000000

// I2C bus (shared by AW88298, ES7210, AXP2101, FT6336, AW9523)
#define CORES3_I2C_SDA         GPIO_NUM_12
#define CORES3_I2C_SCL         GPIO_NUM_11
#define CORES3_I2C_PORT        I2C_NUM_1
#define CORES3_I2C_FREQ_HZ     400000

// I2S audio pins
#define CORES3_I2S_MCLK        GPIO_NUM_0
#define CORES3_I2S_WS          GPIO_NUM_33
#define CORES3_I2S_BCLK        GPIO_NUM_34
#define CORES3_I2S_DOUT        GPIO_NUM_13
#define CORES3_I2S_DIN         GPIO_NUM_14

// Audio config
#define CORES3_AUDIO_SAMPLE_RATE  16000
#define CORES3_AUDIO_INPUT_GAIN_DB  30.0f

// Display functions
lv_display_t *cores3_display_start(void *ctx);
bool cores3_display_lock(void *ctx, uint32_t timeout_ms);
void cores3_display_unlock(void *ctx);
esp_err_t cores3_display_set_brightness(void *ctx, int percent);

// Audio functions
esp_err_t cores3_audio_open(void *ctx, esp_openclaw_room_audio_handles_t *handles);

// Touch/input functions
esp_err_t cores3_setup_local_input(void *ctx, void (*toggle_view)(void));