import React, { useState, useEffect, useRef } from 'react';
import { AppState, Course, Section, SectionContent, Slide, LearningLevel, LEARNING_LEVELS, InteractiveConfig } from './types';
import * as Gemini from './services/geminiService';
import { GenerationStep, buildSyllabusContext, getProviderDisplayName } from './services/geminiService';
import { downloadAllContent } from './services/downloadService';
import { ThreeSandbox } from './components/ThreeSandbox';
import { Controls } from './components/Controls';
import { SlideViewer } from './components/SlideViewer';
import { QuizModule } from './components/QuizModule';
import { extractTextFromPdf } from './services/pdfParser';
import { Search, Lock, CheckCircle, PlayCircle, Loader2, ArrowLeft, CloudLightning, Sparkles, Download, BookOpen, Box, HelpCircle, Check, Maximize, Minimize, X, FileText, Upload, Mic, Volume2, VolumeX, MonitorPlay, MessageCircle } from 'lucide-react';
import { SlideChatbot } from './components/SlideChatbot';
import { devLogger } from './services/devLogger';

// Generation progress state type
type StepStatus = 'pending' | 'in-progress' | 'complete';
interface GenerationProgress {
  slides: StepStatus;
  voice: StepStatus;
  simulation: StepStatus;
  quiz: StepStatus;
}

const RANDOM_TOPICS = [
  "How Volcanoes Erupt",
  "How Plants Make Food",
  "The Water Cycle",
  "How Magnets Work",
  "The Solar System",
  "How Rainbows Form",
  "How Sound Travels",
  "What Causes Earthquakes",
  "How the Human Heart Works",
  "Why Seasons Change",
  "How Batteries Work",
  "The Food Chain",
  "How Airplanes Fly",
  "States of Matter",
  "How Light and Shadows Work",
  "Why the Moon Changes Shape",
  "How Mountains Form",
  "What Makes Things Float or Sink",
];

const App: React.FC = () => {
  const [topic, setTopic] = useState('');
  const [selectedLevel, setSelectedLevel] = useState<LearningLevel>('highschool');
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [course, setCourse] = useState<Course | null>(null);
  const [courseLevel, setCourseLevel] = useState<LearningLevel>('highschool'); // Store level with course
  
  // Background fetching state
  const [generatingSections, setGeneratingSections] = useState<Set<number>>(new Set());

  // Current Active Data
  const [activeSectionId, setActiveSectionId] = useState<number | null>(null);
  const [activeContent, setActiveContent] = useState<SectionContent | null>(null);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [paramValues, setParamValues] = useState<Record<string, number>>({});
  
  // UI States
  const [viewMode, setViewMode] = useState<'content' | 'quiz'>('content');
  const [loadingMessage, setLoadingMessage] = useState('');
  const [isSimulationVisible, setIsSimulationVisible] = useState(true);
  const [isSimFullscreen, setIsSimFullscreen] = useState(false);
  /** Fullscreen slide viewer for a section (e.g. when only slides are ready) */
  const [slidesFullscreen, setSlidesFullscreen] = useState<{ sectionId: number; title: string; slides: Slide[] } | null>(null);
  const [fullscreenSlideIndex, setFullscreenSlideIndex] = useState(0);
  const [isChatOpen, setIsChatOpen] = useState(false);

  // Download state
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ step: string; percent: number } | null>(null);

  // Generation progress tracking
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress>({
    slides: 'pending',
    voice: 'pending',
    simulation: 'pending',
    quiz: 'pending'
  });

  // Voice generation opt-in (toggled on home page before course creation)
  const [courseVoiceEnabled, setCourseVoiceEnabled] = useState(false);

  // PDF upload state
  const [pdfSource, setPdfSource] = useState<{ fileName: string; text: string; numPages: number; thumbnail: string } | null>(null);
  const [isPdfDragging, setIsPdfDragging] = useState(false);
  const [isPdfParsing, setIsPdfParsing] = useState(false);
  const [pdfParseError, setPdfParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Simulation error retry state
  const [simulationRetryState, setSimulationRetryState] = useState<{
    isRetrying: boolean;
    hasRetried: boolean;
    sectionId: number | null;
    error: string | null;
  }>({
    isRetrying: false,
    hasRetried: false,
    sectionId: null,
    error: null
  });

  // Handle keyboard shortcuts for fullscreen modes (ESC, arrow keys)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If chat is open, close chat first instead of exiting fullscreen
        if (slidesFullscreen && isChatOpen) {
          setIsChatOpen(false);
          return;
        }
        if (slidesFullscreen) {
          // Exit browser fullscreen if active, then close overlay
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          }
          // Sync slide index back to learning mode if applicable
          if (appState === AppState.LEARNING_MODE && activeSectionId === slidesFullscreen.sectionId) {
            setActiveSlideIndex(fullscreenSlideIndex);
          }
          setSlidesFullscreen(null);
        } else if (isSimFullscreen) {
          setIsSimFullscreen(false);
        }
        return;
      }
      // Arrow key navigation for fullscreen slides — skip when typing in an input
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      if (slidesFullscreen) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          setFullscreenSlideIndex(i => Math.min(slidesFullscreen.slides.length - 1, i + 1));
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          setFullscreenSlideIndex(i => Math.max(0, i - 1));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSimFullscreen, slidesFullscreen, appState, activeSectionId, fullscreenSlideIndex, isChatOpen]);

  // Auto-download dev logs when the page unloads (close tab / navigate away)
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (devLogger.isActive) {
        devLogger.endSession();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Close chatbot when switching sections or exiting fullscreen
  useEffect(() => {
    setIsChatOpen(false);
  }, [slidesFullscreen?.sectionId]);

  // Request/exit browser Fullscreen API when slides overlay opens/closes
  useEffect(() => {
    if (slidesFullscreen) {
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    }
  }, [slidesFullscreen?.sectionId]);

  // Progress callback for generation steps
  const handleGenerationProgress = (step: GenerationStep, status: StepStatus) => {
    setGenerationProgress(prev => ({ ...prev, [step]: status }));
  };

  // Reset progress when starting new generation
  const resetGenerationProgress = () => {
    setGenerationProgress({
      slides: 'pending',
      voice: 'pending',
      simulation: 'pending',
      quiz: 'pending'
    });
  };

  // Helper to build RICH context from previous sections (full content, not just titles)
  const buildPreviousContext = (targetSectionId: number, currentCourse: Course) => {
    const previousSections = currentCourse.sections
      .filter(s => s.id < targetSectionId && s.content)
      .map(s => ({
        id: s.id,
        title: s.title,
        content: s.content!
      }));

    return Gemini.buildRichPreviousContext(previousSections);
  };

  // Check if all sections before targetSectionId have content
  const allPreviousSectionsComplete = (targetSectionId: number, currentCourse: Course): boolean => {
    const previousSections = currentCourse.sections.filter(s => s.id < targetSectionId);
    return previousSections.every(s => s.content !== undefined && s.content !== null);
  };

  // -------------------------------------------------------------------------
  // Background Pre-fetching Effect (SEQUENTIAL - only fetch if all previous complete)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!course) return;

    const prefetchNext = async () => {
      // Find the first section that:
      // 1. Has no content
      // 2. Is not currently being generated
      // 3. ALL previous sections have content (SEQUENTIAL requirement)
      const nextSectionToFetch = course.sections.find(
        s => !s.content && 
             !generatingSections.has(s.id) && 
             allPreviousSectionsComplete(s.id, course)
      );

      if (nextSectionToFetch) {
        // Mark as generating
        setGeneratingSections(prev => new Set(prev).add(nextSectionToFetch.id));
        resetGenerationProgress();
        
        try {
          console.log(`[Background] Fetching content for section ${nextSectionToFetch.id}: ${nextSectionToFetch.title}`);
          console.log(`[Background] All ${nextSectionToFetch.id - 1} previous sections are complete. Starting generation...`);
          
          // Use RICH context from all previous sections
          const context = buildPreviousContext(nextSectionToFetch.id, course);
          // Build syllabus context so LLM knows what's coming in future sections
          const syllabusCtx = buildSyllabusContext(
            course.sections.map(s => ({ id: s.id, title: s.title, description: s.description })),
            nextSectionToFetch.id
          );
          const sectionId = nextSectionToFetch.id;
          const content = await Gemini.fetchFullSectionData(
            course.topic, 
            nextSectionToFetch.title, 
            context,
            sectionId,  // Pass section number
            handleGenerationProgress,  // Pass progress callback
            syllabusCtx,  // Pass full syllabus for scope awareness
            courseLevel,  // Pass learning level
            (slides) => {
              setCourse(prev => {
                if (!prev) return null;
                return {
                  ...prev,
                  sections: prev.sections.map(s =>
                    s.id === sectionId ? { ...s, partialContent: { slides } } : s
                  )
                };
              });
            },
            (slideIndex, speakerNotes, audioData) => {
              setCourse(prev => {
                if (!prev) return null;
                return {
                  ...prev,
                  sections: prev.sections.map(s => {
                    if (s.id !== sectionId) return s;
                    const slides = [...(s.partialContent?.slides ?? s.content?.slides ?? [])];
                    if (slides[slideIndex]) {
                      slides[slideIndex] = { ...slides[slideIndex], speakerNotes, audioData };
                    }
                    return { ...s, partialContent: { slides } };
                  })
                };
              });
            },
            courseVoiceEnabled  // Pass voice opt-in setting
          );
          
          // Log the generated simulation code for debugging
          if (content.interactiveConfig) {
            devLogger.logSimulationCode(
              nextSectionToFetch.id,
              nextSectionToFetch.title,
              content.interactiveConfig.code,
              content.interactiveConfig.params
            );
          }

          // Update course state (full content; clear partial)
          setCourse(prevCourse => {
             if (!prevCourse) return null;
             return {
               ...prevCourse,
               sections: prevCourse.sections.map(s => 
                 s.id === nextSectionToFetch.id ? { ...s, content, partialContent: undefined } : s
               )
             };
          });
        } catch (error) {
          console.error(`[Background] Failed to fetch section ${nextSectionToFetch.id}`, error);
          devLogger.addEntry('error', 'Background', `Failed to fetch section ${nextSectionToFetch.id}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setGeneratingSections(prev => {
            const next = new Set(prev);
            next.delete(nextSectionToFetch.id);
            return next;
          });
        }
      }
    };

    prefetchNext();
  }, [course, generatingSections, courseLevel, courseVoiceEnabled]);

  // -------------------------------------------------------------------------
  // State Monitoring for Active Section
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (appState === AppState.LOADING_SECTION && activeSectionId && course) {
      const section = course.sections.find(s => s.id === activeSectionId);
      if (section && section.content) {
        initializeSectionView(section.content);
      }
    }
  }, [course, appState, activeSectionId]);

  const initializeSectionView = (content: SectionContent) => {
    const initialParams: Record<string, number> = {};
    content.interactiveConfig.params.forEach(p => initialParams[p.name] = p.defaultValue);

    setActiveContent(content);
    setParamValues(initialParams);
    setActiveSlideIndex(0);
    setViewMode('content');
    setIsSimulationVisible(true);
    setAppState(AppState.LEARNING_MODE);
  };

  const effectiveTopic = pdfSource ? pdfSource.fileName.replace(/\.pdf$/i, '') : topic.trim();
  const canStart = effectiveTopic.length > 0;

  const handlePdfFile = async (files: FileList | null) => {
    if (!files?.length) return;
    const file = files[0];
    if (file.type !== 'application/pdf') {
      setPdfParseError('Please select a PDF file.');
      return;
    }
    setPdfParseError(null);
    setIsPdfParsing(true);
    try {
      const { text, numPages, thumbnail } = await extractTextFromPdf(file);
      setPdfSource({ fileName: file.name, text, numPages, thumbnail });
    } catch (err) {
      console.error(err);
      setPdfParseError('Could not read PDF. It may be corrupted or image-only.');
      setPdfSource(null);
    } finally {
      setIsPdfParsing(false);
    }
  };

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canStart) return;

    const title = effectiveTopic;

    console.log(`[App] Starting new course generation for: ${title} (Level: ${selectedLevel})${pdfSource ? ' from PDF' : ''}`);

    // Start a new dev-logger session for this topic (auto-downloads previous if any)
    devLogger.startSession(title, selectedLevel);

    setAppState(AppState.GENERATING_SYLLABUS);
    setCourseLevel(selectedLevel); // Save the level for this course
    setLoadingMessage(`Consulting AI architect about ${title}...`);

    try {
      const sections = await Gemini.generateSyllabus(title, selectedLevel, pdfSource?.text);
      // TEMPORARY: Unlock all sections for testing (revert later)
      const unlockedSections = sections.map(s => ({ ...s, isLocked: false }));
      setCourse({ topic: title, sections: unlockedSections });
      setAppState(AppState.COURSE_OVERVIEW);
    } catch (error) {
      console.error(error);
      devLogger.addEntry('error', 'App', `Syllabus generation failed: ${error instanceof Error ? error.message : String(error)}`);
      setLoadingMessage("Failed to generate syllabus. Please try a different topic.");
      setTimeout(() => { devLogger.endSession(); setAppState(AppState.IDLE); }, 3000);
    }
  };

  const handleLoadSection = async (section: Section) => {
    if (section.isLocked) return;
    
    setActiveSectionId(section.id);

    if (section.content) {
      initializeSectionView(section.content);
      return;
    }

    // Check if all previous sections are complete (SEQUENTIAL requirement)
    if (!allPreviousSectionsComplete(section.id, course!)) {
      setLoadingMessage(`Please wait - generating previous sections first...`);
      setAppState(AppState.LOADING_SECTION);
      return;
    }

    if (generatingSections.has(section.id)) {
      setLoadingMessage(`Finishing up content generation for: ${section.title}...`);
      setAppState(AppState.LOADING_SECTION);
      return;
    }

    setLoadingMessage(`Generating customized lessons for: ${section.title}...`);
    setAppState(AppState.LOADING_SECTION);
    resetGenerationProgress();
    
    try {
      setGeneratingSections(prev => new Set(prev).add(section.id));
      
      // Use RICH context from all previous sections
      const context = buildPreviousContext(section.id, course!);
      // Build syllabus context so LLM knows what's coming in future sections
      const syllabusCtx = buildSyllabusContext(
        course!.sections.map(s => ({ id: s.id, title: s.title, description: s.description })),
        section.id
      );
      const sectionId = section.id;
      const content = await Gemini.fetchFullSectionData(
        course!.topic, 
        section.title, 
        context,
        sectionId,  // Pass section number
        handleGenerationProgress,  // Pass progress callback
        syllabusCtx,  // Pass full syllabus for scope awareness
        courseLevel,  // Pass learning level
        (slides) => {
          setCourse(prev => {
            if (!prev) return null;
            return {
              ...prev,
              sections: prev.sections.map(s =>
                s.id === sectionId ? { ...s, partialContent: { slides } } : s
              )
            };
          });
        },
        (slideIndex, speakerNotes, audioData) => {
          setCourse(prev => {
            if (!prev) return null;
            return {
              ...prev,
              sections: prev.sections.map(s => {
                if (s.id !== sectionId) return s;
                const slides = [...(s.partialContent?.slides ?? s.content?.slides ?? [])];
                if (slides[slideIndex]) {
                  slides[slideIndex] = { ...slides[slideIndex], speakerNotes, audioData };
                }
                return { ...s, partialContent: { slides } };
              })
            };
          });
        },
        courseVoiceEnabled  // Pass voice opt-in setting
      );

      // Log the generated simulation code for debugging
      if (content.interactiveConfig) {
        devLogger.logSimulationCode(
          section.id,
          section.title,
          content.interactiveConfig.code,
          content.interactiveConfig.params
        );
      }
      
      setCourse(prev => {
        if(!prev) return null;
        return {
          ...prev,
          sections: prev.sections.map(s =>
            s.id === section.id ? { ...s, content, partialContent: undefined } : s
          )
        };
      });
      setGeneratingSections(prev => {
        const next = new Set(prev);
        next.delete(section.id);
        return next;
      });
    } catch (e) {
      console.error(e);
      devLogger.addEntry('error', 'App', `Section ${section.id} loading failed: ${e instanceof Error ? e.message : String(e)}`);
      setLoadingMessage("Error loading section. Please try again.");
      setTimeout(() => setAppState(AppState.COURSE_OVERVIEW), 3000);
      setGeneratingSections(prev => {
        const next = new Set(prev);
        next.delete(section.id);
        return next;
      });
    }
  };

  const handleSectionComplete = () => {
    if (!course || !activeSectionId) return;

    const updatedSections = course.sections.map(s => {
      if (s.id === activeSectionId) return { ...s, isCompleted: true };
      if (s.id === activeSectionId + 1) return { ...s, isLocked: false };
      return s;
    });

    setCourse({ ...course, sections: updatedSections });
    setAppState(AppState.COURSE_OVERVIEW);
    setActiveSectionId(null);
    setActiveContent(null);
  };

  const handleParamChange = (name: string, value: number) => {
    setParamValues(prev => ({ ...prev, [name]: value }));
  };

  // Handle simulation runtime errors with automatic retry
  const handleSimulationError = async (error: Error) => {
    console.error('[SIMULATION ERROR]', error);
    
    // Only retry once per section
    if (!activeSectionId || !activeContent || !course) {
      console.warn('[SIMULATION ERROR] Cannot retry: missing context');
      return;
    }

    // Log the simulation error with full code context
    devLogger.logSimulationError(activeSectionId, error, activeContent.interactiveConfig.code);

    // Check if we've already retried for this section
    if (simulationRetryState.hasRetried && simulationRetryState.sectionId === activeSectionId) {
      console.warn('[SIMULATION ERROR] Already retried for this section, giving up');
      devLogger.addEntry('warn', 'SimRetry', `Section ${activeSectionId}: Giving up after retry`);
      return;
    }

    console.log('[SIMULATION ERROR] Attempting automatic retry with error correction...');
    devLogger.addEntry('info', 'SimRetry', `Section ${activeSectionId}: Starting error correction retry`);
    
    setSimulationRetryState({
      isRetrying: true,
      hasRetried: false,
      sectionId: activeSectionId,
      error: error.message
    });

    try {
      const section = course.sections.find(s => s.id === activeSectionId);
      if (!section || !section.content) {
        throw new Error('Section not found');
      }

      // Build context for error correction
      const previousSections = course.sections
        .filter(s => s.id < activeSectionId && s.content)
        .map(s => ({
          id: s.id,
          title: s.title,
          content: s.content!
        }));
      const previousContext = Gemini.buildRichPreviousContext(previousSections);
      
      const currentSlidesContext = section.content.slides.map((slide, idx) => {
        const cleanContent = slide.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        return `Slide ${idx + 1} - ${slide.title}: ${cleanContent}`;
      }).join('\n\n');

      // Get the simulation description from the interactive config
      const simulationDescription = section.content.interactiveConfig.prompt;

      // Call error correction API
      const correctedConfig = await Gemini.generateInteractiveCodeErrorCorrection(
        topic,
        section.title,
        simulationDescription,
        previousContext,
        currentSlidesContext,
        section.id,
        courseLevel,
        activeContent.interactiveConfig.code,
        error.message,
        error.stack
      );

      console.log('[SIMULATION ERROR] Received corrected code, updating section...');

      // Log the corrected code
      devLogger.logSimulationRetry(activeSectionId, error.message, correctedConfig.code);

      // Update the course with corrected code
      setCourse(prevCourse => {
        if (!prevCourse) return null;
        return {
          ...prevCourse,
          sections: prevCourse.sections.map(s => 
            s.id === activeSectionId && s.content
              ? { ...s, content: { ...s.content, interactiveConfig: correctedConfig } }
              : s
          )
        };
      });

      // Update active content with corrected code
      setActiveContent(prevContent => {
        if (!prevContent) return null;
        return { ...prevContent, interactiveConfig: correctedConfig };
      });

      setSimulationRetryState({
        isRetrying: false,
        hasRetried: true,
        sectionId: activeSectionId,
        error: null
      });

      console.log('[SIMULATION ERROR] Retry complete - corrected code applied');
    } catch (retryError) {
      console.error('[SIMULATION ERROR] Retry failed:', retryError);
      devLogger.addEntry('error', 'SimRetry', `Section ${activeSectionId}: Retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      setSimulationRetryState({
        isRetrying: false,
        hasRetried: true,
        sectionId: activeSectionId,
        error: error.message
      });
    }
  };

  const hasAnyContent = !!course?.sections.some(s => s.content || s.partialContent);

  const handleDownload = async () => {
    if (!course) return;
    setIsDownloading(true);
    setDownloadProgress({ step: 'Preparing...', percent: 0 });
    try {
      await downloadAllContent(course, courseLevel, (step, percent) => {
        setDownloadProgress({ step, percent });
      });
    } catch (err) {
      alert('Download failed: ' + (err as Error).message);
    } finally {
      setIsDownloading(false);
      setDownloadProgress(null);
    }
  };

  // --- Render Helpers ---

  // Fullscreen slide viewer (overlay when viewing slides only, e.g. while section is still generating)
  // Use live slides from course state so incremental voice updates are reflected automatically.
  if (slidesFullscreen) {
    const { title, sectionId } = slidesFullscreen;
    const liveSection = course?.sections.find(s => s.id === sectionId);
    const slides = liveSection?.content?.slides ?? liveSection?.partialContent?.slides ?? slidesFullscreen.slides;
    const fullscreenSection = liveSection;
    const simReady = !!fullscreenSection?.content?.interactiveConfig?.code;

    const handleExitSlidesFullscreen = () => {
      // Sync slide index back to learning mode if applicable
      if (appState === AppState.LEARNING_MODE && activeSectionId === sectionId) {
        setActiveSlideIndex(fullscreenSlideIndex);
      }
      setSlidesFullscreen(null);
    };

    const handleShowSim = () => {
      const currentIdx = fullscreenSlideIndex;
      setSlidesFullscreen(null);
      if (appState === AppState.LEARNING_MODE && activeSectionId === sectionId) {
        // Already in learning mode — sync slide index and ensure sim is visible
        setActiveSlideIndex(currentIdx);
        setIsSimulationVisible(true);
      } else if (fullscreenSection) {
        // Enter learning mode for this section (sim will be visible by default)
        handleLoadSection(fullscreenSection);
      }
    };

    // Build context sections for the chatbot: current section + all previous sections
    const chatContextSections: Array<{ title: string; slides: Slide[] }> = [];
    if (course) {
      for (const sec of course.sections) {
        if (sec.id > sectionId) break; // Only include current and previous
        const secSlides = sec.content?.slides ?? sec.partialContent?.slides;
        if (secSlides && secSlides.length > 0) {
          chatContextSections.push({ title: sec.title, slides: secSlides });
        }
      }
    }
    // Fallback: if course isn't available, use the fullscreen slides directly
    if (chatContextSections.length === 0) {
      chatContextSections.push({ title, slides });
    }

    return (
      <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'var(--bg-primary)' }}>
        {/* Edge-to-edge slide viewer + optional chatbot side-by-side */}
        <div className="flex-1 min-h-0 flex flex-row relative">
          {/* Slide viewer — shrinks when chat is open */}
          <div className="flex-1 min-w-0 transition-all duration-300">
            <SlideViewer
              slides={slides}
              currentSlideIndex={fullscreenSlideIndex}
              onNext={() => setFullscreenSlideIndex(i => Math.min(slides.length - 1, i + 1))}
              onPrev={() => setFullscreenSlideIndex(i => Math.max(0, i - 1))}
              isSimVisible={false}
              showSimToggle={false}
              isFullscreen={true}
            />
          </div>

          {/* Chatbot panel */}
          {isChatOpen && (
            <SlideChatbot
              slides={slides}
              currentSlideIndex={fullscreenSlideIndex}
              contextSections={chatContextSections}
              currentSectionTitle={title}
              courseTopic={course?.topic ?? ''}
              learningLevel={courseLevel}
              onClose={() => setIsChatOpen(false)}
            />
          )}
        </div>

        {/* Floating title bar — auto-hides, appears on hover/tap */}
        <div className="slides-fullscreen-titlebar">
          <h2 className="font-display text-lg font-semibold truncate" style={{ color: 'white' }}>{title}</h2>
          <div className="flex items-center gap-3 flex-shrink-0">
            {/* Chat toggle */}
            <button
              onClick={() => setIsChatOpen(prev => !prev)}
              className="slide-chatbot-toggle-btn"
            >
              <MessageCircle size={18} />
              {isChatOpen ? 'Close Chat' : 'Ask AI'}
            </button>
            {simReady && (
              <button
                onClick={handleShowSim}
                className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-white transition-all hover:scale-105"
                style={{ background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)', boxShadow: '0 4px 20px rgba(66, 133, 244, 0.4)' }}
              >
                <MonitorPlay size={18} />
                Show 3D
              </button>
            )}
            <button
              onClick={handleExitSlidesFullscreen}
              className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-white transition-all hover:scale-105"
              style={{ background: 'rgba(255, 255, 255, 0.18)', backdropFilter: 'blur(10px)' }}
            >
              <X size={18} />
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (appState === AppState.IDLE) {
    return (
      <div className="min-h-screen relative overflow-hidden gradient-bg">
        {/* Cosmic background layers */}
        <div className="starfield"></div>
        <div className="aurora-bg"></div>
        <div className="noise-overlay"></div>
        
        {/* Decorative blobs */}
        <div className="blob blob-1 float-animation"></div>
        <div className="blob blob-2 float-animation" style={{ animationDelay: '3s' }}></div>
        
        {/* Geometric decoration - rotating ring */}
        <div className="geo-ring hidden lg:block" style={{
          width: '600px',
          height: '600px',
          top: '50%',
          right: '-200px',
          transform: 'translateY(-50%)',
          opacity: 0.3
        }}></div>

        {/* Main content - asymmetric layout */}
        <div className="min-h-screen flex items-center justify-center px-6 py-12 relative z-10">
          <div className="max-w-4xl w-full">
            {/* Hero section */}
            <div className="text-center mb-16">
              {/* Title with shimmer effect */}
              <div className="slide-in-up stagger-1">
                <h1 className="font-display text-7xl md:text-8xl font-semibold tracking-tight mb-6 flex items-center justify-center gap-2" style={{ color: '#4285f4' }}>
                  <span>Thinky</span>
                  <span className="rotating-3d">3D</span>
                </h1>
                <p className="text-xl md:text-2xl max-w-2xl mx-auto leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Unlock any subject with <span className="text-[#4285f4] font-semibold">AI-crafted lessons</span> and <span className="text-[#34a853] font-semibold whitespace-nowrap">immersive 3D simulations</span>
                </p>
              </div>
            </div>

            {/* Learning Level Selector - card style */}
            <div className="slide-in-up stagger-2 mb-12">
              <p className="text-center text-sm font-semibold uppercase tracking-[0.2em] mb-6" style={{ color: 'var(--text-muted)' }}>
                Choose Your Level
              </p>
              <div className="flex flex-wrap justify-center gap-4">
                {LEARNING_LEVELS.map((level) => {
                  const isSelected = selectedLevel === level.id;
                  return (
                    <button
                      key={level.id}
                      onClick={() => setSelectedLevel(level.id)}
                      className={`level-card ${isSelected ? 'selected' : ''}`}
                    >
                      <div className="relative z-10 flex items-center gap-3">
                        <span className="text-2xl">{level.icon}</span>
                        <span className="font-semibold text-lg" style={{ color: isSelected ? 'white' : 'var(--text-primary)' }}>
                          {level.label}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
              
              {/* Level info */}
              <div className="text-center mt-6 space-y-1">
                <p className="text-base font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {LEARNING_LEVELS.find(l => l.id === selectedLevel)?.description}
                </p>
                <p className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>
                  {LEARNING_LEVELS.find(l => l.id === selectedLevel)?.ageRange}
                </p>
              </div>
            </div>

            {/* Voice Narration Toggle */}
            <div className="slide-in-up stagger-3 mb-10 flex justify-center">
              <button
                type="button"
                onClick={() => setCourseVoiceEnabled(v => !v)}
                className="flex items-center gap-3 px-6 py-3.5 rounded-2xl font-semibold text-sm transition-all border-2 hover:scale-105"
                style={{
                  borderColor: courseVoiceEnabled ? '#4285f4' : 'var(--border-primary)',
                  color: courseVoiceEnabled ? '#4285f4' : 'var(--text-muted)',
                  background: courseVoiceEnabled ? 'rgba(66, 133, 244, 0.1)' : 'rgba(18, 18, 45, 0.5)',
                  boxShadow: courseVoiceEnabled ? '0 0 20px rgba(66, 133, 244, 0.15)' : 'none'
                }}
              >
                {courseVoiceEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
                <span>{courseVoiceEnabled ? 'Voice Narration On' : 'Voice Narration Off'}</span>
                <div
                  className="w-10 h-5 rounded-full relative transition-all"
                  style={{
                    background: courseVoiceEnabled
                      ? 'linear-gradient(135deg, #4285f4, #34a853)'
                      : 'var(--bg-elevated)'
                  }}
                >
                  <div
                    className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-md transition-all"
                    style={{ left: courseVoiceEnabled ? '22px' : '2px' }}
                  />
                </div>
              </button>
            </div>

            {/* Search Form - refined design */}
            <form onSubmit={handleStart} className="slide-in-up stagger-3 mb-12">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={(e) => {
                  handlePdfFile(e.target.files);
                  e.target.value = '';
                }}
              />
              <div
                className="relative group"
                onDragOver={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.types.includes('Files')) setIsPdfDragging(true);
                }}
                onDragLeave={() => setIsPdfDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsPdfDragging(false);
                  handlePdfFile(e.dataTransfer.files);
                }}
              >
                {/* Glow effect on hover */}
                <div className="absolute -inset-[2px] rounded-[28px] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-500" style={{
                  background: 'linear-gradient(135deg, #4285f4, #34a853)',
                  filter: 'blur(8px)'
                }}></div>
                
                <div className="relative rounded-[26px] overflow-hidden transition-all" style={{
                  background: isPdfDragging ? 'rgba(0, 245, 255, 0.08)' : 'rgba(18, 18, 45, 0.7)',
                  border: '2px solid var(--border-primary)',
                  backdropFilter: 'blur(20px)'
                }}>
                  {/* PDF indicator / error */}
                  {pdfSource && (
                    <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-3" style={{ borderColor: 'var(--border-primary)' }}>
                      <div className="flex items-center gap-4">
                        {pdfSource.thumbnail ? (
                          <img
                            src={pdfSource.thumbnail}
                            alt="PDF preview"
                            className="rounded-xl border-2 flex-shrink-0 object-cover shadow-md"
                            style={{ width: 96, height: 128, borderColor: 'var(--border-primary)' }}
                          />
                        ) : (
                          <div className="flex items-center justify-center rounded-xl border-2 flex-shrink-0 bg-black/20 shadow-md" style={{ width: 96, height: 128, borderColor: 'var(--border-primary)' }}>
                            <FileText size={40} style={{ color: 'var(--text-muted)' }} />
                          </div>
                        )}
                        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                          {pdfSource.numPages} {pdfSource.numPages === 1 ? 'page' : 'pages'}
                          {' · '}
                          {pdfSource.text.length >= 1_000_000
                            ? `${(pdfSource.text.length / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
                            : pdfSource.text.length >= 1000
                              ? `${(pdfSource.text.length / 1000).toFixed(1).replace(/\.0$/, '')}K`
                              : pdfSource.text.length.toLocaleString()}{' '}
                          characters
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPdfSource(null)}
                        className="p-2.5 rounded-xl hover:opacity-80 transition-opacity"
                        style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--text-secondary)' }}
                        aria-label="Remove PDF"
                      >
                        <X size={20} />
                      </button>
                    </div>
                  )}
                  {pdfParseError && (
                    <div className="px-5 py-2 text-sm" style={{ color: 'var(--aurora-pink)' }}>
                      {pdfParseError}
                    </div>
                  )}
                  {isPdfParsing && (
                    <div className="flex items-center gap-2 px-5 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <Loader2 size={16} className="animate-spin" />
                      <span>Reading PDF...</span>
                    </div>
                  )}
                  {/* Text Area */}
                  <textarea
                    placeholder={pdfSource ? "Optionally edit the course title above, or add more context..." : "What would you like to explore? Try 'How does quantum entanglement work?' or drop a PDF..."}
                    className="w-full px-7 pt-6 pb-4 text-lg transition-all resize-none"
                    rows={3}
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleStart(e);
                      }
                    }}
                    style={{
                      fontFamily: 'Satoshi, sans-serif',
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: 'var(--text-primary)'
                    }}
                  />
                  
                  {/* Bottom Bar */}
                  <div className="flex items-center justify-end px-5 py-4 border-t" style={{ borderColor: 'var(--border-primary)' }}>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isPdfParsing}
                        className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
                        style={{ padding: '10px 18px', borderRadius: '14px' }}
                        title="Upload PDF"
                      >
                        <Upload size={18} style={{ color: 'var(--aurora-cyan)' }} />
                        <span>Upload PDF</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const randomTopic = RANDOM_TOPICS[Math.floor(Math.random() * RANDOM_TOPICS.length)];
                          setTopic(randomTopic);
                        }}
                        className="btn-ghost flex items-center gap-2 text-sm"
                        style={{ padding: '10px 18px', borderRadius: '14px' }}
                      >
                        <Sparkles size={18} style={{ color: 'var(--aurora-violet)' }} />
                        <span>Inspire me</span>
                      </button>
                      <button
                        type="submit"
                        disabled={!canStart || isPdfParsing}
                        className="btn-glow flex items-center gap-2 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ padding: '12px 24px', borderRadius: '14px' }}
                      >
                        <span>Begin Journey</span>
                        <Search size={18} />
                      </button>
                    </div>
                  </div>
                </div>
                {isPdfDragging && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-[26px] pointer-events-none" style={{ background: 'rgba(0, 245, 255, 0.12)' }}>
                    <span className="text-lg font-medium" style={{ color: 'var(--aurora-cyan)' }}>Drop PDF here</span>
                  </div>
                )}
              </div>
            </form>

            {/* Feature Pills - enhanced design */}
            <div className="flex flex-wrap justify-center gap-4 slide-in-up stagger-4 mb-12">
              <div className="feature-pill">
                <div className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ background: '#4285f4', boxShadow: '0 0 10px #4285f4' }}></div>
                <span>AI-Crafted Lessons</span>
              </div>
              <div className="feature-pill">
                <div className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ background: '#34a853', boxShadow: '0 0 10px #34a853', animationDelay: '0.5s' }}></div>
                <span>3D Simulations</span>
              </div>
              <div className="feature-pill">
                <div className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ background: '#4285f4', boxShadow: '0 0 10px #4285f4', animationDelay: '1s' }}></div>
                <span>Adaptive Quizzes</span>
              </div>
            </div>

            {/* Tech stack footer */}
            <div className="fixed bottom-6 right-6 text-base font-mono slide-in-up stagger-5">
              <span className="px-4 py-2 rounded-lg font-semibold" style={{
                background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)',
                color: 'white',
                boxShadow: '0 4px 15px rgba(66, 133, 244, 0.3)'
              }}>
                Powered by Gemini
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (appState === AppState.GENERATING_SYLLABUS || appState === AppState.LOADING_SECTION) {
    // Build pipeline step component
    const PipelineStep = ({ 
      step, 
      icon: Icon, 
      label, 
      status,
      color,
      isLast = false 
    }: { 
      step: number;
      icon: any;
      label: string;
      status: StepStatus;
      color: string;
      isLast?: boolean;
    }) => {
      const isComplete = status === 'complete';
      const isActive = status === 'in-progress';

      return (
        <div className="flex items-center">
          {/* Step Node */}
          <div className="relative flex flex-col items-center">
            {/* Glow effect for active/complete */}
            {(isActive || isComplete) && (
              <div 
                className={`absolute inset-0 rounded-2xl transition-opacity duration-500 ${isActive ? 'animate-pulse' : ''}`}
                style={{ 
                  background: color,
                  opacity: isComplete ? 0.3 : 0.5,
                  transform: 'scale(1.8)',
                  filter: 'blur(20px)'
                }}
              />
            )}
            
            {/* Icon Container */}
            <div 
              className={`relative w-18 h-18 rounded-2xl flex items-center justify-center transition-all duration-500`}
              style={{
                width: '72px',
                height: '72px',
                background: isComplete || isActive 
                  ? `linear-gradient(135deg, ${color}, ${color}dd)` 
                  : 'rgba(18, 18, 45, 0.6)',
                border: isComplete || isActive ? 'none' : '2px solid var(--border-primary)',
                boxShadow: isComplete || isActive 
                  ? `0 8px 32px ${color}50` 
                  : 'none'
              }}
            >
              {isComplete ? (
                <Check size={32} className="text-white" strokeWidth={2.5} />
              ) : isActive ? (
                <Loader2 size={32} className="text-white animate-spin" strokeWidth={2} />
              ) : (
                <Icon size={28} style={{ color: 'var(--text-muted)' }} strokeWidth={1.5} />
              )}
            </div>

            {/* Label */}
            <span 
              className="mt-4 text-sm font-semibold tracking-wide transition-colors duration-300"
              style={{ color: isComplete || isActive ? 'var(--text-primary)' : 'var(--text-muted)' }}
            >
              {label}
            </span>

            {/* Status text */}
            <span
              className="mt-1 text-xs font-mono transition-colors duration-300"
              style={{
                color: isComplete ? '#4285f4' : isActive ? '#ffbe0b' : 'var(--text-muted)'
              }}
            >
              {isComplete ? 'Complete' : isActive ? 'Generating...' : 'Pending'}
            </span>
          </div>

          {/* Connector Line */}
          {!isLast && (
            <div className="relative w-24 h-1 mx-6">
              {/* Background track */}
              <div className="absolute inset-0 rounded-full" style={{ background: 'var(--border-primary)' }} />
              {/* Progress fill */}
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
                style={{
                  width: isComplete ? '100%' : '0%',
                  background: `linear-gradient(90deg, ${color}, #34a853)`
                }}
              />
              {/* Animated dot for active */}
              {isActive && (
                <div 
                  className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full animate-pulse"
                  style={{ 
                    background: color,
                    left: '0%',
                    boxShadow: `0 0 15px ${color}`
                  }}
                />
              )}
            </div>
          )}
        </div>
      );
    };

    return (
      <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden gradient-bg">
        {/* Cosmic background */}
        <div className="starfield"></div>
        <div className="aurora-bg"></div>
        <div className="noise-overlay"></div>
        <div className="blob blob-3 float-animation"></div>

        <div className="relative z-10 text-center space-y-12 px-6">
          {/* Header */}
          <div className="space-y-4">
            <h2 className="font-display text-4xl md:text-5xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              {loadingMessage}
            </h2>
            <p className="text-base font-mono tracking-wider" style={{ color: 'var(--text-muted)' }}>
              {appState === AppState.GENERATING_SYLLABUS 
                ? 'Analyzing topic and structuring curriculum...' 
                : 'Building your personalized learning experience'}
            </p>
          </div>

          {/* Pipeline Progress - Only show for section generation */}
          {appState === AppState.LOADING_SECTION && (
            <>
              <div className="flex items-start justify-center py-8 flex-wrap gap-y-8">
                {(() => {
                  // Build pipeline steps dynamically based on voice setting
                  const steps = [
                    { icon: FileText, label: 'Slides', status: generationProgress.slides, color: '#4285f4' },
                    ...(courseVoiceEnabled ? [{ icon: Mic, label: 'Voice', status: generationProgress.voice, color: '#ffbe0b' }] : []),
                    { icon: Box, label: '3D Simulation', status: generationProgress.simulation, color: '#4285f4' },
                    { icon: HelpCircle, label: 'Quiz', status: generationProgress.quiz, color: '#34a853' },
                  ];
                  return steps.map((s, idx) => (
                    <PipelineStep
                      key={s.label}
                      step={idx + 1}
                      icon={s.icon}
                      label={s.label}
                      status={s.status}
                      color={s.color}
                      isLast={idx === steps.length - 1}
                    />
                  ));
                })()}
              </div>
              {/* As soon as slides are ready, allow fullscreen view while rest generates */}
              {course && activeSectionId && (() => {
                const loadingSection = course.sections.find(s => s.id === activeSectionId);
                const slides = loadingSection?.partialContent?.slides;
                if (!slides?.length) return null;
                return (
                  <div className="flex flex-col items-center gap-3">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                      Slides ready — view them now while {courseVoiceEnabled ? 'voice, ' : ''}3D & quiz generate in the background
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setFullscreenSlideIndex(0);
                        setSlidesFullscreen({
                          sectionId: activeSectionId,
                          title: loadingSection!.title,
                          slides
                        });
                      }}
                      className="flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-white shadow-lg transition-all hover:scale-105"
                      style={{ background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' }}
                    >
                      <Maximize size={20} />
                      View slides in fullscreen
                    </button>
                  </div>
                );
              })()}
            </>
          )}

          {/* Syllabus loading animation */}
          {appState === AppState.GENERATING_SYLLABUS && (
            <div className="flex justify-center py-8">
              <div className="relative">
                <div className="absolute inset-0 rounded-full animate-pulse" style={{
                  background: 'linear-gradient(135deg, #4285f4, #34a853)',
                  transform: 'scale(2.5)',
                  filter: 'blur(40px)',
                  opacity: 0.4
                }}></div>
                <div className="relative p-6 rounded-full" style={{
                  background: 'rgba(18, 18, 45, 0.8)',
                  border: '2px solid var(--border-primary)'
                }}>
                  <Loader2 className="animate-spin" size={56} style={{ color: '#4285f4' }} strokeWidth={1.5} />
                </div>
              </div>
            </div>
          )}

          {/* Subtle footer text */}
          <p className="text-sm font-mono" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
            Powered by <span style={{ color: '#4285f4' }}>{getProviderDisplayName()}</span>
          </p>
        </div>
      </div>
    );
  }

  if (appState === AppState.COURSE_OVERVIEW && course) {
    return (
      <div className="min-h-screen p-8 relative overflow-hidden gradient-bg">
        {/* Cosmic background */}
        <div className="starfield"></div>
        <div className="aurora-bg"></div>
        <div className="noise-overlay"></div>
        <div className="blob blob-2 float-animation"></div>

        <header className="max-w-6xl mx-auto mb-12 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 relative z-10">
          <div className="slide-in-up">
            <h1 className="font-display text-5xl md:text-6xl font-semibold mb-4 title-shimmer">
              {course.topic}
            </h1>
            <div className="flex items-center gap-4">
              <p className="text-lg font-medium" style={{ color: 'var(--text-tertiary)' }}>Your Learning Journey</p>
              <span className="px-4 py-1.5 rounded-full text-sm font-semibold flex items-center gap-2" style={{
                background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)',
                color: 'white',
                boxShadow: '0 4px 20px rgba(66, 133, 244, 0.3)'
              }}>
                <span>{LEARNING_LEVELS.find(l => l.id === courseLevel)?.icon}</span>
                <span>{LEARNING_LEVELS.find(l => l.id === courseLevel)?.label}</span>
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 slide-in-up stagger-1">
            <button
              onClick={handleDownload}
              disabled={isDownloading || !hasAnyContent}
              className="px-4 py-3 rounded-xl transition-all flex items-center gap-2 font-medium back-button disabled:opacity-50 disabled:cursor-not-allowed"
              title="Download all generated content"
            >
              {isDownloading ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
              Download
            </button>
            <button
              onClick={() => { devLogger.endSession(); setAppState(AppState.IDLE); setCourse(null); setGeneratingSections(new Set()); }}
              className="px-5 py-3 rounded-xl transition-all flex items-center gap-2 font-medium back-button"
            >
              <ArrowLeft size={18} /> New Topic
            </button>
          </div>
        </header>

        {/* Download Progress Overlay */}
        {downloadProgress && (
          <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0, 0, 0, 0.7)', backdropFilter: 'blur(8px)' }}>
            <div className="rounded-3xl p-8 w-full max-w-md text-center space-y-6" style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)',
              boxShadow: '0 25px 80px rgba(0, 0, 0, 0.5)'
            }}>
              <div>
                <h3 className="font-display text-2xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                  Preparing Download
                </h3>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{downloadProgress.step}</p>
              </div>
              <div className="w-full h-3 rounded-full overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out"
                  style={{
                    width: `${downloadProgress.percent}%`,
                    background: 'linear-gradient(90deg, #4285f4, #34a853)',
                  }}
                />
              </div>
              <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                {downloadProgress.percent}%
              </p>
            </div>
          </div>
        )}

        <div className="max-w-6xl mx-auto grid gap-6 relative z-10">
          {course.sections.map((section, index) => {
            const isGenerating = generatingSections.has(section.id);
            const hasContent = !!section.content;

            return (
              <div
                key={section.id}
                className={`relative overflow-hidden rounded-3xl transition-all duration-500 slide-in-up card-hover course-card ${
                  section.isLocked ? 'course-card-locked' : ''
                }`}
                style={{ animationDelay: `${index * 0.1}s` }}
              >
                {/* Gradient accent line on hover */}
                {!section.isLocked && (
                  <div className="absolute top-0 left-0 right-0 h-1 opacity-0 hover:opacity-100 transition-opacity" style={{
                    background: 'linear-gradient(90deg, #4285f4, #34a853)'
                  }}></div>
                )}

                <div className="p-8 flex items-start justify-between gap-8">
                  <div className="flex-grow space-y-4">
                    {/* Badges */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="px-4 py-1.5 rounded-full text-xs font-bold font-mono uppercase tracking-wider section-badge">
                        Chapter {index + 1}
                      </span>
                      {section.isCompleted && (
                        <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider border" style={{
                          background: 'rgba(0, 212, 170, 0.1)',
                          color: '#00d4aa',
                          borderColor: 'rgba(0, 212, 170, 0.3)'
                        }}>
                          <CheckCircle size={14} /> Completed
                        </span>
                      )}
                      {isGenerating && (
                        <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider animate-pulse border" style={{
                          background: 'rgba(66, 133, 244, 0.1)',
                          color: '#4285f4',
                          borderColor: 'rgba(66, 133, 244, 0.3)'
                        }}>
                          <CloudLightning size={14} /> Generating...
                        </span>
                      )}
                      {!isGenerating && hasContent && !section.isCompleted && (
                        <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider border" style={{
                          background: 'rgba(52, 168, 83, 0.1)',
                          color: '#34a853',
                          borderColor: 'rgba(52, 168, 83, 0.3)'
                        }}>
                          <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#34a853' }}></span>
                          Ready
                        </span>
                      )}
                    </div>

                    {/* Title and Description */}
                    <h3 className="font-display text-3xl font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>{section.title}</h3>
                    <p className="leading-relaxed text-lg" style={{ color: 'var(--text-secondary)' }}>{section.description}</p>
                  </div>

                  {/* Action Buttons: View slides (when slides ready) + Start / Play */}
                  <div className="flex-shrink-0 flex flex-col sm:flex-row items-center gap-3">
                    {section.isLocked ? (
                      <div className="h-16 w-16 rounded-2xl flex items-center justify-center locked-icon">
                        <Lock size={28} />
                      </div>
                    ) : (
                      <>
                        {(section.partialContent?.slides?.length || section.content?.slides?.length) ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const slides = section.content?.slides ?? section.partialContent!.slides;
                              setFullscreenSlideIndex(0);
                              setSlidesFullscreen({ sectionId: section.id, title: section.title, slides });
                            }}
                            className="flex items-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm transition-all border-2 hover:scale-105"
                            style={{
                              borderColor: 'var(--aurora-cyan)',
                              color: 'var(--aurora-cyan)',
                              background: 'rgba(0, 245, 255, 0.08)'
                            }}
                          >
                            <FileText size={18} />
                            View slides
                          </button>
                        ) : null}
                        <button
                          onClick={() => handleLoadSection(section)}
                          disabled={isGenerating && !section.partialContent?.slides?.length}
                          className="h-16 w-16 rounded-2xl flex items-center justify-center text-white shadow-xl transition-all hover:scale-110 relative group disabled:opacity-70 disabled:cursor-wait"
                          style={{
                            background: section.isCompleted
                              ? 'linear-gradient(135deg, #00d4aa 0%, #00a896 100%)'
                              : isGenerating
                              ? 'var(--bg-elevated)'
                              : 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)'
                          }}
                        >
                          {!section.isCompleted && !isGenerating && (
                            <div className="absolute inset-0 rounded-2xl blur-xl opacity-50 group-hover:opacity-75 transition-opacity" style={{
                              background: 'linear-gradient(135deg, #4285f4, #34a853)'
                            }}></div>
                          )}
                          <div className="relative">
                            {isGenerating ? <Loader2 className="animate-spin" size={28} /> :
                             section.isCompleted ? <CheckCircle size={28} /> : <PlayCircle size={32} fill="white" />}
                          </div>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (appState === AppState.LEARNING_MODE && activeContent) {
    const isQuizMode = viewMode === 'quiz';

    // Fullscreen Simulation View
    if (isSimFullscreen) {
      return (
        <div className="fixed inset-0 z-50 gradient-bg flex">
          {/* Main Simulation Area */}
          <div className="flex-grow relative">
            {/* 3D Canvas - Full Area */}
            <ThreeSandbox
              code={activeContent.interactiveConfig.code}
              params={paramValues}
              onError={handleSimulationError}
            />

            {/* Retry Indicator Overlay */}
            {simulationRetryState.isRetrying && simulationRetryState.sectionId === activeSectionId && (
              <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-10">
                <div className="text-center space-y-4 animate-in fade-in">
                  <Loader2 className="w-12 h-12 text-[#4285f4] animate-spin mx-auto" />
                  <div className="text-white font-semibold text-xl">
                    Fixing Simulation Error...
                  </div>
                  <div className="text-gray-300 text-sm max-w-md px-4">
                    Automatically regenerating code with error correction
                  </div>
                </div>
              </div>
            )}

            {/* Top Bar */}
            <div className="absolute top-0 left-0 right-0 flex items-center justify-between p-4 bg-gradient-to-b from-black/50 to-transparent">
              {/* Label */}
              <div className="px-4 py-2 rounded-xl text-xs font-bold font-mono tracking-wider text-white border-2 shadow-lg"
                   style={{ background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)', borderColor: 'rgba(255, 255, 255, 0.2)' }}>
                LIVE 3D SIMULATION
              </div>

              {/* Section Title */}
              <h2 className="text-white font-bold text-lg hidden md:block">
                {course?.sections.find(s => s.id === activeSectionId)?.title}
              </h2>

              {/* Exit Fullscreen Button */}
              <button
                onClick={() => setIsSimFullscreen(false)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-white transition-all hover:scale-105"
                style={{ background: 'rgba(255, 255, 255, 0.15)', backdropFilter: 'blur(10px)' }}
              >
                <Minimize size={18} />
                Exit Fullscreen
              </button>
            </div>
          </div>

          {/* Right Side Controls Panel */}
          <div className="w-80 flex-shrink-0 border-l flex flex-col" style={{ 
            background: 'var(--bg-secondary)', 
            borderColor: 'var(--border-primary)' 
          }}>
            {/* Controls */}
            <div className="flex-grow overflow-y-auto p-4 custom-scrollbar">
              <Controls
                config={activeContent.interactiveConfig.params}
                values={paramValues}
                onChange={handleParamChange}
              />
            </div>

            {/* Footer with keyboard hint */}
            <div className="p-4 border-t text-center" style={{ borderColor: 'var(--border-primary)' }}>
              <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                Press <kbd className="px-2 py-1 rounded bg-black/20 mx-1">ESC</kbd> to exit fullscreen
              </p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="h-screen flex flex-col overflow-hidden gradient-bg">
        {/* Header */}
        <header className="h-20 border-b backdrop-blur-sm flex items-center justify-between px-8 flex-shrink-0 learning-header">
           <div className="flex items-center gap-5">
             <button
               onClick={() => setAppState(AppState.COURSE_OVERVIEW)}
               className="p-2.5 rounded-xl transition-all hover:scale-105 header-back-btn"
             >
               <ArrowLeft size={22} />
             </button>
             <h2 className="font-bold text-xl" style={{ color: 'var(--text-primary)' }}>{course?.sections.find(s => s.id === activeSectionId)?.title}</h2>
           </div>

           <div className="flex items-center rounded-2xl p-1.5 border view-mode-toggle">
             <button
               onClick={() => setViewMode('content')}
               className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${!isQuizMode ? 'text-white shadow-lg' : 'hover-text'}`}
               style={!isQuizMode ? { background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' } : { color: 'var(--text-tertiary)' }}
             >
               Learn
             </button>
             <button
               onClick={() => setViewMode('quiz')}
               className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${isQuizMode ? 'text-white shadow-lg' : 'hover-text'}`}
               style={isQuizMode ? { background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' } : { color: 'var(--text-tertiary)' }}
             >
               Quiz
             </button>
           </div>
        </header>

        {/* Content Body */}
        <main className="flex-grow flex overflow-hidden">
          {isQuizMode ? (
            <div className="w-full h-full p-8">
              <QuizModule
                questions={activeContent.quiz}
                onComplete={handleSectionComplete}
              />
            </div>
          ) : (
            <div className="w-full h-full flex flex-col md:flex-row p-6 gap-6">
              {/* Left: Slides (Flexible Width) */}
              <div className={`flex flex-col h-full transition-all duration-500 ease-in-out ${isSimulationVisible ? 'md:w-1/3' : 'md:w-full'}`}>
                <SlideViewer
                  slides={activeContent.slides}
                  currentSlideIndex={activeSlideIndex}
                  onNext={() => setActiveSlideIndex(Math.min(activeContent.slides.length - 1, activeSlideIndex + 1))}
                  onPrev={() => setActiveSlideIndex(Math.max(0, activeSlideIndex - 1))}
                  isSimVisible={isSimulationVisible}
                  onToggleSim={() => {
                    // Focus Mode → enter fullscreen slides overlay
                    const section = course?.sections.find(s => s.id === activeSectionId);
                    if (section && activeContent) {
                      setFullscreenSlideIndex(activeSlideIndex);
                      setSlidesFullscreen({
                        sectionId: section.id,
                        title: section.title,
                        slides: activeContent.slides
                      });
                    }
                  }}
                />
              </div>

              {/* Right: Interactive 3D (Hidden if toggled off) */}
              {isSimulationVisible && (
                <div className="w-full md:w-2/3 flex flex-col h-full gap-6 animate-in fade-in slide-in-from-right-8 duration-500">
                  <div className="flex-grow relative rounded-2xl overflow-hidden border-2 border-[#252b5c] shadow-2xl">
                     {/* 3D Canvas */}
                     <ThreeSandbox
                        code={activeContent.interactiveConfig.code}
                        params={paramValues}
                        onError={handleSimulationError}
                     />

                     {/* Retry Indicator Overlay */}
                     {simulationRetryState.isRetrying && simulationRetryState.sectionId === activeSectionId && (
                       <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-10">
                         <div className="text-center space-y-4 animate-in fade-in">
                           <Loader2 className="w-12 h-12 text-[#4285f4] animate-spin mx-auto" />
                           <div className="text-white font-semibold text-xl">
                             Fixing Simulation Error...
                           </div>
                           <div className="text-gray-300 text-sm max-w-md px-4">
                             Automatically regenerating code with error correction
                           </div>
                         </div>
                       </div>
                     )}

                     {/* Overlay Label */}
                     <div className="absolute top-5 left-5 px-4 py-2 rounded-xl text-xs font-bold font-mono tracking-wider text-white border-2 shadow-lg"
                          style={{ background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)', borderColor: 'rgba(255, 255, 255, 0.2)' }}>
                       LIVE 3D SIMULATION
                     </div>

                     {/* Fullscreen Button */}
                     <button
                       onClick={() => setIsSimFullscreen(true)}
                       className="absolute top-5 right-5 p-3 rounded-xl text-white transition-all hover:scale-110 group"
                       style={{ background: 'rgba(0, 0, 0, 0.5)', backdropFilter: 'blur(10px)' }}
                       title="Enter Fullscreen"
                     >
                       <Maximize size={20} />
                       <span className="absolute right-full mr-2 top-1/2 -translate-y-1/2 px-2 py-1 rounded-lg text-xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity"
                             style={{ background: 'rgba(0, 0, 0, 0.8)' }}>
                         Fullscreen
                       </span>
                     </button>
                  </div>

                  {/* Controls Area */}
                  <div className="h-96 flex-shrink-0">
                    <Controls
                      config={activeContent.interactiveConfig.params}
                      values={paramValues}
                      onChange={handleParamChange}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    );
  }

  return null;
};

export default App;