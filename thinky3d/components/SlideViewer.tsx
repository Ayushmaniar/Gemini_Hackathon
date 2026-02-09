import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Slide } from '../types';
import { ChevronRight, ChevronLeft, BookOpen, MonitorPlay, Maximize2, Volume2, VolumeX } from 'lucide-react';
import { VoiceBot } from './VoiceBot';
import { useSlideStyles } from '../hooks/useSlideStyles';

interface SlideViewerProps {
  slides: Slide[];
  currentSlideIndex: number;
  onNext: () => void;
  onPrev: () => void;
  isSimVisible?: boolean;
  onToggleSim?: () => void;
  /** When true, hide the "Focus Mode / Show 3D" toggle (e.g. fullscreen slides-only view) */
  showSimToggle?: boolean;
  /** When true, strip card chrome (rounded corners, border, shadow) and expand to fill container */
  isFullscreen?: boolean;
}

export const SlideViewer: React.FC<SlideViewerProps> = ({
  slides,
  currentSlideIndex,
  onNext,
  onPrev,
  isSimVisible = true,
  onToggleSim,
  showSimToggle = true,
  isFullscreen = false
}) => {
  const slide = slides[currentSlideIndex];
  const contentRef = useRef<HTMLDivElement>(null);
  const isTypesettingRef = useRef(false);
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(false);

  // Reset subtitle when slide changes
  useEffect(() => {
    setCurrentSubtitle(null);
  }, [currentSlideIndex]);

  const isLayoutSlide = useMemo(() => {
    const html = slide?.content ?? '';
    // Heuristic: treat as layout-heavy if it uses multi-column grid patterns.
    // These slides look cramped at reading-width (65ch).
    return /(grid-cols-\d+|md:grid-cols-\d+|lg:grid-cols-\d+|xl:grid-cols-\d+)/.test(html);
  }, [slide?.content]);

  // Trigger MathJax typeset whenever slide content changes
  useEffect(() => {
    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 15;

    const renderMath = async () => {
      if (!contentRef.current || cancelled) return;

      // Prevent overlapping typesetting operations
      if (isTypesettingRef.current) return;
      isTypesettingRef.current = true;

      const MathJax = (window as any).MathJax;

      // If MathJax isn't loaded yet, retry after a delay
      if (!MathJax || !MathJax.typesetPromise) {
        console.log(`MathJax not ready, retry ${retryCount + 1}/${maxRetries}`);
        if (retryCount < maxRetries) {
          retryCount++;
          isTypesettingRef.current = false;
          setTimeout(renderMath, 200);
        } else {
          console.warn("MathJax failed to load after retries");
          isTypesettingRef.current = false;
        }
        return;
      }

      try {
        // Wait for MathJax to be fully ready (startup.promise exists in MathJax 3)
        if (MathJax.startup?.promise) {
          await MathJax.startup.promise;
        }

        if (cancelled) {
          isTypesettingRef.current = false;
          return;
        }

        // Clear any previous typesetting on this element to avoid duplicates
        if (MathJax.typesetClear) {
          MathJax.typesetClear([contentRef.current]);
        }

        // Delay to ensure DOM is fully updated after React render
        await new Promise(resolve => setTimeout(resolve, 200));

        if (cancelled) {
          isTypesettingRef.current = false;
          return;
        }

        // Now typeset the content
        console.log("Typesetting MathJax for slide", currentSlideIndex);
        await MathJax.typesetPromise([contentRef.current]);
        console.log("MathJax typeset complete for slide", currentSlideIndex);
        isTypesettingRef.current = false;
      } catch (err) {
        console.warn("MathJax typeset error:", err);
        isTypesettingRef.current = false;
        // Retry on error
        if (retryCount < maxRetries) {
          retryCount++;
          setTimeout(renderMath, 300);
        }
      }
    };

    renderMath();

    return () => {
      cancelled = true;
      isTypesettingRef.current = false;
    };
  }, [slide, currentSlideIndex]);

  // Use custom hook for all slide styling
  const {
    backgroundStyle,
    textTheme,
    textThemeClass,
    slideTextThemeClass,
    hasCustomBackground,
    overlayStyle,
    borderClass,
    buttonClass,
  } = useSlideStyles(slide);

  if (!slide) return <div className="text-white">Loading content...</div>;

  return (
    <div
      className={`relative isolate flex flex-col h-full overflow-hidden slide-viewer ${isFullscreen ? 'slide-viewer-fullscreen' : 'rounded-2xl border-2 shadow-2xl'} ${slideTextThemeClass} ${hasCustomBackground ? 'slide-has-custom-bg' : ''} ${!isSimVisible ? 'slide-viewer-full-width' : ''}`}
      style={backgroundStyle}
    >
      {/* Background contrast veil (keeps text readable on strong colors) */}
      {hasCustomBackground && (
        <div
          aria-hidden="true"
          className="absolute inset-0 slide-bg-overlay"
          style={overlayStyle}
        />
      )}

      {/* Slide Header */}
      <div className={`relative z-10 flex items-center justify-between p-6 border-b slide-header ${borderClass}`}>
        <div className={`flex items-center gap-3 ${textTheme === 'light' ? 'text-orange-300' : 'text-orange-600'}`}>
          <BookOpen size={22} strokeWidth={2.5} />
          <span className={`text-sm font-bold tracking-wide uppercase ${textThemeClass}`}>Slide {currentSlideIndex + 1} of {slides.length}</span>
        </div>

        {showSimToggle && onToggleSim && (
          <button
            onClick={onToggleSim}
            className={`flex items-center gap-2 text-xs font-bold px-4 py-2 rounded-xl transition-all border-2 toggle-sim-btn ${textThemeClass} ${buttonClass}`}
          >
            {isSimVisible ? <Maximize2 size={16} /> : <MonitorPlay size={16} />}
            {isSimVisible ? "Focus Mode" : "Show 3D"}
          </button>
        )}
      </div>

      {/* Slide Content Area */}
      <div className="relative z-10 flex-grow p-10 overflow-y-auto custom-scrollbar" style={{ paddingBottom: currentSubtitle ? '100px' : '40px' }}>
        <div className="slide-content-inner">
          <div
            className={
              hasCustomBackground
                ? `slide-readable-panel ${isLayoutSlide ? 'slide-readable-panel--wide' : ''}`
                : undefined
            }
          >
            <h2 className={`text-4xl font-black mb-8 pb-4 border-b-2 slide-title ${textThemeClass} ${borderClass}`}>{slide.title}</h2>

            {/* Render HTML Content safely */}
            <div
              key={`slide-content-${currentSlideIndex}`}
              ref={contentRef}
              className={`prose-custom mathjax-process ${isLayoutSlide ? 'prose-wide' : ''}`}
              dangerouslySetInnerHTML={{ __html: slide.content }}
            />
          </div>
        </div>
      </div>

      {/* YouTube-style Subtitles - Fixed at bottom above VoiceBot */}
      {currentSubtitle && (
        <div className="slide-subtitle-container">
          <div className="slide-subtitle">
            {currentSubtitle}
          </div>
        </div>
      )}

      {/* Voice Bot Narrator */}
      <VoiceBot
        slide={slide}
        slideIndex={currentSlideIndex}
        onSubtitleChange={setCurrentSubtitle}
        isVoiceEnabled={isVoiceEnabled}
      />

      {/* Footer Navigation + Voice Toggle */}
      <div className={`relative z-10 flex justify-between items-center p-6 border-t slide-footer ${borderClass}`}>
        <button
          onClick={onPrev}
          disabled={currentSlideIndex === 0}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold transition-all ${
            currentSlideIndex === 0
              ? `cursor-not-allowed slide-nav-disabled ${textTheme === 'light' ? 'text-white/30' : 'text-gray-500'}`
              : `border-2 slide-nav-btn ${textThemeClass} ${buttonClass}`
          }`}
        >
          <ChevronLeft size={20} />
          Previous
        </button>

        <div className="flex gap-2">
          {slides.map((_, idx) => (
            <div
              key={idx}
              className={`h-2 rounded-full transition-all ${
                idx === currentSlideIndex ? 'w-10 slide-indicator-active' : 'w-2 slide-indicator'
              }`}
            />
          ))}
        </div>

        <div className="flex items-center gap-3">
          {/* Simple voice toggle button — only show when current slide has audio */}
          {slide.audioData && slide.speakerNotes && (
            <button
              type="button"
              onClick={() => {
                const next = !isVoiceEnabled;
                setIsVoiceEnabled(next);
                if (!next) {
                  setCurrentSubtitle(null);
                }
              }}
              className={`flex items-center justify-center h-10 w-10 rounded-full border-2 slide-nav-btn ${buttonClass} ${textThemeClass}`}
              title={isVoiceEnabled ? 'Turn voice off' : 'Turn voice on'}
            >
              {isVoiceEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
          )}

          <button
            onClick={onNext}
            disabled={currentSlideIndex === slides.length - 1}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold transition-all ${
              currentSlideIndex === slides.length - 1
                ? `cursor-not-allowed slide-nav-disabled ${textTheme === 'light' ? 'text-white/30' : 'text-gray-500'}`
                : 'text-white shadow-lg'
            }`}
            style={currentSlideIndex !== slides.length - 1 ? { background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' } : {}}
          >
            Next
            <ChevronRight size={20} />
          </button>
        </div>
      </div>
    </div>
  );
};
