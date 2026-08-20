// CoreS3 ILI9342 display driver for Agent A Node
// Adapted from StackChan firmware display init + esp-openclaw-room-node display contract

#include "cores3_board.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_ili9341.h"
#include "driver/spi_master.h"
#include "lvgl.h"

#define TAG "cores3_display"

// Draw buffer rows — small chunks for SPI (can DMA from PSRAM on ILI9342,
// unlike the Waveshare SH8601 AMOLED which needed internal RAM)
#define CORES3_DRAW_ROWS 32

static lv_display_t *s_display = NULL;

lv_display_t *cores3_display_start(void *ctx)
{
    (void)ctx;

    // Initialize SPI bus for the display
    spi_bus_config_t buscfg = {
        .mosi_io_num = CORES3_LCD_MOSI,
        .miso_io_num = GPIO_NUM_NC,
        .sclk_io_num = CORES3_LCD_SCLK,
        .quadwp_io_num = GPIO_NUM_NC,
        .quadhd_io_num = GPIO_NUM_NC,
        .max_transfer_sz = CORES3_DISPLAY_WIDTH * CORES3_DISPLAY_HEIGHT * sizeof(uint16_t),
    };
    ESP_ERROR_CHECK(spi_bus_initialize(CORES3_LCD_SPI_HOST, &buscfg, SPI_DMA_CH_AUTO));

    // Install panel IO
    esp_lcd_panel_io_handle_t panel_io = NULL;
    esp_lcd_panel_io_spi_config_t io_config = {
        .cs_gpio_num = CORES3_LCD_CS,
        .dc_gpio_num = CORES3_LCD_DC,
        .spi_mode = CORES3_LCD_SPI_MODE,
        .pclk_hz = CORES3_LCD_PCLK_HZ,
        .trans_queue_depth = 10,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(CORES3_LCD_SPI_HOST, &io_config, &panel_io));

    // Install ILI9341 driver (ILI9342 is compatible)
    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = GPIO_NUM_NC,  // Reset handled by AW9523 IO expander
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_ili9341(panel_io, &panel_config, &panel));

    esp_lcd_panel_reset(panel);
    // Note: AW9523 ResetIli9342() would go here if we wire the IO expander
    esp_lcd_panel_init(panel);
    esp_lcd_panel_invert_color(panel, true);
    // No swap/mirror for Stack-chan orientation
    esp_lcd_panel_swap_xy(panel, false);
    esp_lcd_panel_mirror(panel, false, false);

    s_display = lv_display_create(CORES3_DISPLAY_WIDTH, CORES3_DISPLAY_HEIGHT);
    if (s_display == NULL) {
        ESP_LOGE(TAG, "lv_display_create failed");
        return NULL;
    }

    // Allocate draw buffers — ILI9342 SPI CAN DMA from PSRAM, so we can use
    // larger buffers than the Waveshare AMOLED which needed internal RAM
    size_t draw_bytes = (size_t)CORES3_DISPLAY_WIDTH * CORES3_DRAW_ROWS * sizeof(uint16_t);
    void *draw_a = heap_caps_aligned_alloc(
        CONFIG_LV_DRAW_BUF_ALIGN, draw_bytes, MALLOC_CAP_DMA | MALLOC_CAP_SPIRAM);
    void *draw_b = heap_caps_aligned_alloc(
        CONFIG_LV_DRAW_BUF_ALIGN, draw_bytes, MALLOC_CAP_DMA | MALLOC_CAP_SPIRAM);
    if (draw_a == NULL || draw_b == NULL) {
        ESP_LOGE(TAG, "draw buffer allocation failed");
        heap_caps_free(draw_a);
        heap_caps_free(draw_b);
        return NULL;
    }
    lv_display_set_buffers(s_display, draw_a, draw_b, (uint32_t)draw_bytes,
                           LV_DISPLAY_RENDER_MODE_PARTIAL);

    ESP_LOGI(TAG, "ILI9342 display initialized: %dx%d, %d-row partial buffers",
             CORES3_DISPLAY_WIDTH, CORES3_DISPLAY_HEIGHT, CORES3_DRAW_ROWS);
    return s_display;
}

bool cores3_display_lock(void *ctx, uint32_t timeout_ms)
{
    (void)ctx;
    if (s_display == NULL) {
        return false;
    }
    // LVGL 9.x uses lv_lock/lv_unlock for the display mutex
    lv_lock();
    (void)timeout_ms;  // lv_lock doesn't take a timeout
    return true;
}

void cores3_display_unlock(void *ctx)
{
    (void)ctx;
    lv_unlock();
}

esp_err_t cores3_display_set_brightness(void *ctx, int percent)
{
    (void)ctx;
    // CoreS3 backlight is controlled via AW9523 IO expander
    // For now, no brightness control (display is on/off)
    // TODO: wire AW9523 for brightness PWM
    return ESP_OK;
}