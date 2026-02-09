import { useMemo } from 'react';
import { Slide } from '../types';
import { getTextTheme, getAverageBrightness } from '../utils/colors';

export interface SlideStyles {
  backgroundStyle: React.CSSProperties;
  textTheme: 'light' | 'dark';
  textThemeClass: string;
  slideTextThemeClass: string;
  hasCustomBackground: boolean;
  overlayStyle: React.CSSProperties;
  borderClass: string;
  buttonClass: string;
}

/**
 * Custom hook to calculate all styling for a slide
 * Extracts complex styling logic from SlideViewer component
 */
export function useSlideStyles(slide: Slide): SlideStyles {
  // Calculate background style from slide properties
  const backgroundStyle = useMemo((): React.CSSProperties => {
    if (slide.backgroundGradient) {
      const { type, colors, direction = '135deg' } = slide.backgroundGradient;
      if (type === 'linear') {
        return {
          background: `linear-gradient(${direction}, ${colors.join(', ')})`
        };
      } else {
        // Radial gradient
        const pos = direction || '50% 50%';
        return {
          background: `radial-gradient(circle at ${pos}, ${colors.join(', ')})`
        };
      }
    } else if (slide.backgroundColor) {
      return {
        backgroundColor: slide.backgroundColor
      };
    }
    return {}; // Use default CSS
  }, [slide.backgroundColor, slide.backgroundGradient]);

  // Determine text color theme based on background.
  // theme: 'light' = use light text (dark background), 'dark' = use dark text (light background)
  const textTheme = useMemo((): 'light' | 'dark' => {
    if (slide.theme === 'light') {
      return 'light'; // Use light text
    }
    if (slide.theme === 'dark') {
      return 'dark'; // Use dark text
    }
    // Auto: calculate brightness from background
    if (slide.backgroundGradient) {
      const avgBrightness = getAverageBrightness(slide.backgroundGradient.colors);
      return avgBrightness > 128 ? 'dark' : 'light';
    } else if (slide.backgroundColor) {
      return getTextTheme(slide.backgroundColor);
    }
    return 'light'; // Default to light text for dark backgrounds
  }, [slide.theme, slide.backgroundGradient, slide.backgroundColor]);

  // Apply text color theme class
  const textThemeClass = textTheme === 'light' ? 'text-white' : 'text-gray-900';
  const slideTextThemeClass = textTheme === 'light' ? 'slide-text-light' : 'slide-text-dark';

  const hasCustomBackground = !!(slide.backgroundColor || slide.backgroundGradient);

  const overlayStyle = useMemo((): React.CSSProperties => {
    if (!hasCustomBackground) return {};
    // Stabilize readability regardless of app theme/Tailwind-generated text colors.
    // - Light text: add a subtle dark veil.
    // - Dark text: add a subtle light veil.
    return {
      background: textTheme === 'light'
        ? 'rgba(0, 0, 0, 0.22)'
        : 'rgba(255, 255, 255, 0.18)',
    };
  }, [hasCustomBackground, textTheme]);

  // Border classes for headers, footers, and other elements
  const borderClass = textTheme === 'light' ? 'border-white/20' : 'border-gray-800/30';

  // Button classes for navigation and toggles
  const buttonClass = textTheme === 'light'
    ? 'border-white/30 bg-white/10 hover:bg-white/20'
    : 'border-gray-800/30 bg-gray-100/10 hover:bg-gray-200/20';

  return {
    backgroundStyle,
    textTheme,
    textThemeClass,
    slideTextThemeClass,
    hasCustomBackground,
    overlayStyle,
    borderClass,
    buttonClass,
  };
}
