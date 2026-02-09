/**
 * Unified color utilities for slide backgrounds, themes, and accessibility
 * Combines color calculations, palettes, and theme detection in one place
 */

// ============================================================================
// Color Calculation Utilities
// ============================================================================

/**
 * Convert hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Calculate relative luminance of a color
 * Based on WCAG 2.0 formula
 */
function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;

  // Normalize RGB values to 0-1
  const [r, g, b] = [rgb.r / 255, rgb.g / 255, rgb.b / 255];

  // Apply gamma correction
  const [rs, gs, bs] = [
    r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4),
    g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4),
    b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4),
  ];

  // Calculate relative luminance
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate brightness of a color (0-255)
 * Simple brightness calculation
 */
export function calculateBrightness(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;

  // Weighted brightness calculation
  return Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
}

/**
 * Calculate contrast ratio between two colors
 * Returns a value between 1 and 21
 * WCAG AA requires 4.5:1 for normal text, 3:1 for large text
 * WCAG AAA requires 7:1 for normal text, 4.5:1 for large text
 */
export function getContrastRatio(color1: string, color2: string): number {
  const lum1 = getLuminance(color1);
  const lum2 = getLuminance(color2);

  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Check if contrast meets WCAG AA standards
 */
export function meetsWCAGAA(foreground: string, background: string, isLargeText: boolean = false): boolean {
  const ratio = getContrastRatio(foreground, background);
  return isLargeText ? ratio >= 3 : ratio >= 4.5;
}

/**
 * Get average brightness from multiple colors (for gradients)
 */
export function getAverageBrightness(colors: string[]): number {
  if (colors.length === 0) return 0;
  const sum = colors.reduce((acc, color) => acc + calculateBrightness(color), 0);
  return Math.round(sum / colors.length);
}

/**
 * Check if a color is dark (brightness < 128)
 */
export function isDarkColor(hex: string): boolean {
  return calculateBrightness(hex) < 128;
}

/**
 * Check if a color is light (brightness >= 128)
 */
export function isLightColor(hex: string): boolean {
  return calculateBrightness(hex) >= 128;
}

// ============================================================================
// Theme Detection
// ============================================================================

/**
 * Determine if text should be light or dark based on background
 * Returns 'light' for dark backgrounds, 'dark' for light backgrounds
 */
export function getTextTheme(backgroundColor: string): 'light' | 'dark' {
  const brightness = calculateBrightness(backgroundColor);
  return brightness > 128 ? 'dark' : 'light';
}

/**
 * Get appropriate text color for a background
 * Returns a light or dark color that contrasts well
 */
export function getContrastingTextColor(backgroundColor: string): string {
  const theme = getTextTheme(backgroundColor);
  return theme === 'light' ? '#1C2833' : '#F4F6F6';
}

// ============================================================================
// Color Palettes
// ============================================================================

export interface ColorPalette {
  name: string;
  backgrounds: string[];
  accents: string[];
  textLight: string;
  textDark: string;
  description: string;
}

export const COLOR_PALETTES: Record<string, ColorPalette> = {
  physics: {
    name: "Physics & Math",
    backgrounds: ["#1C2833", "#2E4053", "#34495E", "#5D6D7E"],
    accents: ["#4285f4", "#34a853", "#3498DB"],
    textLight: "#F4F6F6",
    textDark: "#1C2833",
    description: "Deep blues, purples, and teals for physics and mathematics"
  },
  biology: {
    name: "Biology & Life Sciences",
    backgrounds: ["#1E5128", "#4E9F3D", "#5EA8A7", "#277884"],
    accents: ["#2ECC71", "#16A085", "#27AE60"],
    textLight: "#FFFFFF",
    textDark: "#1E5128",
    description: "Greens and earth tones for biology and life sciences"
  },
  chemistry: {
    name: "Chemistry",
    backgrounds: ["#C0392B", "#E74C3C", "#F39C12", "#F1C40F"],
    accents: ["#E74C3C", "#F39C12", "#2ECC71"],
    textLight: "#FFFFFF",
    textDark: "#2C3E50",
    description: "Vibrant colors for chemistry - reds, oranges, yellows"
  },
  astronomy: {
    name: "Astronomy & Space",
    backgrounds: ["#181B24", "#2C3E50", "#34495E", "#5D6D7E"],
    accents: ["#4285f4", "#34a853", "#3498DB", "#E74C3C"],
    textLight: "#F4F6F6",
    textDark: "#181B24",
    description: "Deep space colors with cosmic accents"
  },
  mathematics: {
    name: "Mathematics",
    backgrounds: ["#1C2833", "#2E4053", "#5D6D7E", "#85929E"],
    accents: ["#4285f4", "#34a853", "#3498DB"],
    textLight: "#F4F6F6",
    textDark: "#1C2833",
    description: "Classic blue and purple tones for mathematics"
  },
  computerScience: {
    name: "Computer Science",
    backgrounds: ["#0A0A1F", "#12122D", "#1A1A3E", "#252560"],
    accents: ["#4285f4", "#34a853", "#00d4aa"],
    textLight: "#F8F9FF",
    textDark: "#0A0A1F",
    description: "Tech-inspired dark backgrounds with neon accents"
  },
  history: {
    name: "History & Social Studies",
    backgrounds: ["#5D1D2E", "#951233", "#C15937", "#997929"],
    accents: ["#C15937", "#997929", "#D4A574"],
    textLight: "#F4F6F6",
    textDark: "#5D1D2E",
    description: "Warm earth tones and burgundy for history"
  },
  literature: {
    name: "Literature & Language",
    backgrounds: ["#A49393", "#EED6D3", "#E8B4B8", "#AD7670"],
    accents: ["#E8B4B8", "#AD7670", "#B49886"],
    textLight: "#FFFFFF",
    textDark: "#2C2C2C",
    description: "Warm blush and rose tones for literature"
  },
  general: {
    name: "General Education",
    backgrounds: ["#2E4053", "#5D6D7E", "#85929E", "#AAB7B8"],
    accents: ["#4285f4", "#34a853", "#3498DB"],
    textLight: "#F4F6F6",
    textDark: "#2E4053",
    description: "Versatile palette for general topics"
  }
};

/**
 * Get color palette for a given topic
 * Uses keyword matching to select appropriate palette
 */
export function getPaletteForTopic(topic: string): ColorPalette {
  const lowerTopic = topic.toLowerCase();

  // Physics & Math keywords
  if (lowerTopic.match(/\b(physics|quantum|mechanics|electromagnetism|thermodynamics|optics|wave|particle|energy|force|motion|velocity|acceleration|momentum|gravity|relativity|einstein|newton|math|mathematics|calculus|algebra|geometry|trigonometry|equation|formula|theorem|proof)\b/)) {
    return COLOR_PALETTES.physics;
  }

  // Biology keywords
  if (lowerTopic.match(/\b(biology|biological|cell|dna|genetics|evolution|organism|ecosystem|photosynthesis|respiration|protein|enzyme|molecule|organic|life|living|species|habitat|biome)\b/)) {
    return COLOR_PALETTES.biology;
  }

  // Chemistry keywords
  if (lowerTopic.match(/\b(chemistry|chemical|molecule|atom|element|compound|reaction|bond|periodic|table|organic|inorganic|acid|base|ph|solution|solvent)\b/)) {
    return COLOR_PALETTES.chemistry;
  }

  // Astronomy keywords
  if (lowerTopic.match(/\b(astronomy|astrophysics|space|cosmos|universe|galaxy|star|planet|solar|system|nebula|black|hole|orbit|satellite|moon|sun)\b/)) {
    return COLOR_PALETTES.astronomy;
  }

  // Computer Science keywords
  if (lowerTopic.match(/\b(computer|programming|code|algorithm|software|hardware|network|data|structure|database|artificial|intelligence|machine|learning|neural|network|cyber|digital|binary)\b/)) {
    return COLOR_PALETTES.computerScience;
  }

  // History keywords
  if (lowerTopic.match(/\b(history|historical|ancient|civilization|war|battle|empire|kingdom|revolution|medieval|renaissance|world|war|politics|government|society|culture)\b/)) {
    return COLOR_PALETTES.history;
  }

  // Literature keywords
  if (lowerTopic.match(/\b(literature|literary|poetry|poem|novel|story|author|writer|writing|language|grammar|syntax|prose|verse|metaphor|symbolism|theme)\b/)) {
    return COLOR_PALETTES.literature;
  }

  // Default to general
  return COLOR_PALETTES.general;
}

/**
 * Get suggested colors for a topic
 * Returns an array of background color suggestions
 */
export function getSuggestedColors(topic: string): string[] {
  const palette = getPaletteForTopic(topic);
  return palette.backgrounds;
}

/**
 * Get accent colors for a topic
 */
export function getAccentColors(topic: string): string[] {
  const palette = getPaletteForTopic(topic);
  return palette.accents;
}
