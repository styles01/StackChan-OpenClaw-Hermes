// strip_emoji.cc — Remove 4-byte emoji from strings for TTS compatibility
// Ported from plaipin's stripEmoji concept to plain C++ (no Arduino deps)
#include <string>
#include <cstdint>

// Strip 4-byte UTF-8 characters (emoji and other supplementary plane chars)
// These are encoded as 4-byte UTF-8 sequences starting with 0xF0-0xF4
void strip_emoji(std::string& text) {
    size_t i = 0;
    while (i < text.size()) {
        unsigned char c = (unsigned char)text[i];
        
        // 4-byte UTF-8 sequence (U+10000 to U+10FFFF) — emoji range
        if (c >= 0xF0 && c <= 0xF4 && i + 3 < text.size()) {
            text.erase(i, 4);
            continue;
        }
        
        // 3-byte UTF-8 (U+0800 to U+FFFF) — some emoji here too
        // Keep these — most CJK and common symbols are 3-byte
        // Only strip known emoji modifier ranges if needed
        
        i++;
    }
    
    // Also strip common emoji that are 3-byte (variation selectors, etc.)
    // U+FE00-FE0F (variation selectors) = EF B8 80 to EF B8 8F
    // U+200D (zero-width joiner) = E2 80 8D
    i = 0;
    while (i < text.size()) {
        if (i + 2 < text.size()) {
            unsigned char c0 = (unsigned char)text[i];
            unsigned char c1 = (unsigned char)text[i+1];
            unsigned char c2 = (unsigned char)text[i+2];
            
            // Variation selectors U+FE00-FE0F: EF B8 80-8F
            if (c0 == 0xEF && c1 == 0xB8 && c2 >= 0x80 && c2 <= 0x8F) {
                text.erase(i, 3);
                continue;
            }
            
            // Zero-width joiner U+200D: E2 80 8D
            if (c0 == 0xE2 && c1 == 0x80 && c2 == 0x8D) {
                text.erase(i, 3);
                continue;
            }
        }
        i++;
    }
}