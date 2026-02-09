export interface Course {
  topic: string;
  sections: Section[];
}

export interface Section {
  id: number;
  title: string;
  description: string;
  isLocked: boolean;
  isCompleted: boolean;
  content?: SectionContent;
  /** When slides are ready before sim/quiz, allow viewing in fullscreen */
  partialContent?: { slides: Slide[] };
}

export interface SectionContent {
  slides: Slide[];
  interactiveConfig: InteractiveConfig;
  quiz: QuizQuestion[];
}

export interface Slide {
  title: string;
  content: string; // HTML string with Tailwind classes
  speakerNotes?: string; // Conversational narration for TTS
  audioData?: string; // Base64 encoded audio (PCM 24kHz)
  backgroundColor?: string; // Hex color (e.g., "#1C2833")
  backgroundGradient?: {
    type: 'linear' | 'radial';
    colors: string[]; // Array of hex colors
    direction?: string; // e.g., "135deg" for linear gradients, "50% 50%" for radial
  };
  // Text theme: 'light' = light text (for dark backgrounds), 'dark' = dark text (for light backgrounds), 'auto' = auto-detect
  theme?: 'light' | 'dark' | 'auto';
}

export interface ControlParam {
  name: string;
  label: string;
  controlType: 'slider' | 'toggle' | 'button';
  min?: number;
  max?: number;
  step?: number;
  defaultValue: number;
}

export interface InteractiveConfig {
  prompt: string; // The prompt used to generate this
  code: string; // The React component code body
  params: ControlParam[];
}

// ============================================================================
// Simulation Edit Types (for LLM-based code editing)
// ============================================================================

export interface SimulationEdit {
  old_code: string;
  new_code: string;
}

export interface SimulationEditResult {
  explanation: string;
  edits: SimulationEdit[];
  params: ControlParam[];
}

// History items shown in the Simulation Edit panel and used
// as conversational context for patch-based code edits.
export interface SimEditHistoryItem {
  /** Original natural-language request from the user. */
  userRequest: string;
  /**
   * Assistant's explanation for what changed.
   * This is also used as part of the LLM conversation history (truncated)
   * when building future simulation edit prompts.
   */
  explanation: string;
  /** Whether this edit completed successfully. Failed edits are still kept in UI history. */
  success: boolean;
  /**
   * True while waiting for API response.
   * Pending items are shown in the UI but explicitly excluded from LLM history
   * to avoid leaking in-flight edits into the conversation context.
   */
  pending?: boolean;
}

export interface QuizQuestion {
  id: number;
  question: string;
  options: string[];
  correctAnswerIndex: number;
}

export enum AppState {
  IDLE,
  GENERATING_SYLLABUS,
  COURSE_OVERVIEW,
  LOADING_SECTION,
  LEARNING_MODE,
}

// Learning level determines complexity of content
export type LearningLevel = 'beginner' | 'highschool' | 'undergraduate' | 'graduate';

export interface LearningLevelConfig {
  id: LearningLevel;
  label: string;
  icon: string;
  ageRange: string;
  description: string;
  mathLevel: string;
  exampleDepth: string;
}

export const LEARNING_LEVELS: LearningLevelConfig[] = [
  {
    id: 'beginner',
    label: 'Beginner',
    icon: '🌱',
    ageRange: 'Ages 10-14',
    description: 'Simple, visual explanations for curious minds',
    mathLevel: 'Basic arithmetic only',
    exampleDepth: 'What is it? How does it work in everyday life?'
  },
  {
    id: 'highschool',
    label: 'High School',
    icon: '🎓',
    ageRange: 'Ages 14-18',
    description: 'Standard curriculum with foundational concepts',
    mathLevel: 'Algebra, basic trigonometry',
    exampleDepth: 'Core formulas, standard derivations'
  },
  {
    id: 'undergraduate',
    label: 'Undergraduate',
    icon: '📖',
    ageRange: 'College',
    description: 'Rigorous theory with deeper mathematical treatment',
    mathLevel: 'Calculus, differential equations',
    exampleDepth: 'Full derivations, theoretical foundations'
  },
  {
    id: 'graduate',
    label: 'Graduate',
    icon: '🔬',
    ageRange: 'Advanced',
    description: 'Research-level depth and cutting-edge topics',
    mathLevel: 'Advanced mathematics, proofs',
    exampleDepth: 'Specialized topics, research frontiers'
  }
];

// ============================================================================
// Slide Chatbot Types
// ============================================================================

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ============================================================================
// Voice Bot Types
// ============================================================================

export interface VoiceSettings {
  voiceName: string;
  autoPlay: boolean;
  volume: number;
}

export interface NarrationState {
  speakerNotes: string;
  audioUrl: string | null;
  isPlaying: boolean;
  isGenerating: boolean;
  error: string | null;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceName: 'Charon',
  autoPlay: false,
  volume: 0.8,
};

// ============================================================================
// Code Validation Types
// ============================================================================

export interface ValidationError {
  type: 'undefined' | 'tdz' | 'syntax';
  variable: string;
  line: number;
  column: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings?: string[];
}
