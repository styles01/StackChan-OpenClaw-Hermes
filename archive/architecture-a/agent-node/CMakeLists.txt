cmake_minimum_required(VERSION 3.16)

# Point at the esp-openclaw-node repo for all components
set(ESP_OPENCLAW_NODE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../repos/esp-openclaw-node)

set(EXTRA_COMPONENT_DIRS
    # esp-openclaw components
    "${ESP_OPENCLAW_NODE_DIR}/components/esp-openclaw-node"
    "${ESP_OPENCLAW_NODE_DIR}/components/esp-openclaw-node-provisioning"
    "${ESP_OPENCLAW_NODE_DIR}/components/esp-openclaw-talk"
    "${ESP_OPENCLAW_NODE_DIR}/components/esp-openclaw-room-node"
    # third-party components used by esp-openclaw-talk
    "${ESP_OPENCLAW_NODE_DIR}/third_party/esp-webrtc-solution/components/esp_webrtc"
    "${ESP_OPENCLAW_NODE_DIR}/third_party/esp-webrtc-solution/components/esp_peer"
    "${ESP_OPENCLAW_NODE_DIR}/third_party/esp-webrtc-solution/components/av_render"
    "${ESP_OPENCLAW_NODE_DIR}/third_party/esp-webrtc-solution/components/media_lib_utils"
    "${ESP_OPENCLAW_NODE_DIR}/third_party/esp-webrtc-solution/components/webrtc_utils"
    "${ESP_OPENCLAW_NODE_DIR}/third_party/esp-protocols/components/esp_websocket_client")

set(COMPONENTS main)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(agent-a_node)