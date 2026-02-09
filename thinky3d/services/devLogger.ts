// ============================================================================
// Developer Logger — Invisible per-topic logging for Three.js & simulation
// ============================================================================
// Captures console output, simulation code, errors, and auto-fixes.
// Auto-downloads a JSON log file when a topic session ends.
// No UI elements — completely invisible to end users.
//
// Hidden developer shortcuts:
//   Ctrl+Shift+L  — Manually download the current session log
//   Ctrl+Shift+K  — Clear current session log
// ============================================================================

export interface LogEntry {
  timestamp: string;       // ISO timestamp
  elapsed: number;         // ms since session start
  level: 'log' | 'warn' | 'error' | 'info' | 'sim-code' | 'sim-error' | 'sim-retry' | 'sim-autofix' | 'sim-edit';
  source: string;          // e.g. 'ThreeSandbox', 'App', 'console', 'sanitize'
  message: string;
  data?: any;              // Optional structured data (code, params, stack trace, etc.)
}

export interface LogSession {
  topic: string;
  level: string;           // LearningLevel
  startedAt: string;       // ISO timestamp
  endedAt?: string;
  entries: LogEntry[];
  metadata: {
    userAgent: string;
    url: string;
    screenSize: string;
  };
}

// ============================================================================
// Prefixes we intercept from console methods
// ============================================================================
const CAPTURE_PREFIXES = [
  '[ThreeSandbox]',
  '[SIMULATION',
  '[sanitizeSimulationCode]',
  '[GeminiService]',
  '[LLM]',
  '[ERROR CORRECTION]',
  '[RETRY WRAPPER]',
  // Three.js internal warnings
  'THREE.',
  'THREE.WebGLRenderer',
  'THREE.BufferGeometry',
];

// Patterns that indicate a Three.js-related message even without prefix
const CAPTURE_PATTERNS = [
  /three/i,
  /webgl/i,
  /shader/i,
  /frustum/i,
  /bounding/i,
  /geometry/i,
  /material/i,
  /render/i,
  /simulation/i,
  /scene/i,
  /mesh/i,
  /buffer/i,
];

class DevLoggerService {
  private session: LogSession | null = null;
  private sessionStart: number = 0;
  private isIntercepting = false;

  // Original console methods (saved before patching)
  private origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };

  // Track window error listener
  private errorHandler: ((event: ErrorEvent) => void) | null = null;
  private rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;

  // ============================
  // Session Lifecycle
  // ============================

  /** Start a new logging session for a topic. Ends any previous session. */
  startSession(topic: string, level: string): void {
    const now = new Date();
    this.sessionStart = performance.now();

    this.session = {
      topic,
      level,
      startedAt: now.toISOString(),
      entries: [],
      metadata: {
        userAgent: navigator.userAgent,
        url: window.location.href,
        screenSize: `${window.innerWidth}x${window.innerHeight}`,
      },
    };

    this.addEntry('info', 'DevLogger', `Session started for topic: "${topic}" (level: ${level})`);
    this.startIntercepting();
  }

  /** End the current session. */
  endSession(): void {
    if (!this.session) return;

    this.session.endedAt = new Date().toISOString();
    this.addEntry('info', 'DevLogger', 'Session ended');

    this.stopIntercepting();
    this.session = null;
  }

  /** Check if a session is active */
  get isActive(): boolean {
    return this.session !== null;
  }

  get currentTopic(): string | null {
    return this.session?.topic ?? null;
  }

  // ============================
  // Logging Methods
  // ============================

  /** Add a structured log entry */
  addEntry(
    level: LogEntry['level'],
    source: string,
    message: string,
    data?: any
  ): void {
    if (!this.session) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      elapsed: Math.round(performance.now() - this.sessionStart),
      level,
      source,
      message,
    };

    if (data !== undefined) {
      // Avoid logging huge strings directly — truncate if needed
      if (typeof data === 'string' && data.length > 50_000) {
        entry.data = data.substring(0, 50_000) + '\n... [TRUNCATED]';
      } else {
        entry.data = data;
      }
    }

    this.session.entries.push(entry);
  }

  /** Log simulation code that was generated */
  logSimulationCode(sectionId: number, sectionTitle: string, code: string, params: any[]): void {
    this.addEntry('sim-code', 'SimGeneration', `Section ${sectionId}: ${sectionTitle}`, {
      code,
      params,
      codeLength: code.length,
    });
  }

  /** Log a simulation runtime error */
  logSimulationError(sectionId: number, error: Error, code?: string): void {
    this.addEntry('sim-error', 'SimRuntime', `Section ${sectionId}: ${error.message}`, {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      code: code?.substring(0, 10_000),
    });
  }

  /** Log a simulation auto-retry/correction */
  logSimulationRetry(sectionId: number, originalError: string, correctedCode: string): void {
    this.addEntry('sim-retry', 'SimRetry', `Section ${sectionId}: Retrying after "${originalError}"`, {
      originalError,
      correctedCode,
      correctedCodeLength: correctedCode.length,
    });
  }

  /** Log a user-initiated simulation edit (via fullscreen edit bar) */
  logSimulationEdit(
    sectionId: number,
    userRequest: string,
    editedCode: string,
    explanation: string,
    params: unknown[]
  ): void {
    this.addEntry('sim-edit', 'SimEdit', `Section ${sectionId}: "${userRequest}"`, {
      userRequest,
      editedCode: editedCode.length > 10_000 ? editedCode.slice(0, 10_000) + '\n... [TRUNCATED]' : editedCode,
      explanation,
      params,
      editedCodeLength: editedCode.length,
    });
  }

  /** Log a ThreeSandbox auto-fix (e.g. geometry/material conversion) */
  logAutoFix(fixType: string, details: string): void {
    this.addEntry('sim-autofix', 'ThreeSandbox', `Auto-fix: ${fixType}`, { details });
  }

  // ============================
  // Console Interception
  // ============================

  private startIntercepting(): void {
    if (this.isIntercepting) return;
    this.isIntercepting = true;

    // Patch console methods
    const self = this;

    console.log = function (...args: any[]) {
      self.origConsole.log(...args);
      self.captureConsole('log', args);
    };

    console.warn = function (...args: any[]) {
      self.origConsole.warn(...args);
      self.captureConsole('warn', args);
    };

    console.error = function (...args: any[]) {
      self.origConsole.error(...args);
      self.captureConsole('error', args);
    };

    console.info = function (...args: any[]) {
      self.origConsole.info(...args);
      self.captureConsole('info', args);
    };

    // Catch uncaught errors (Three.js often throws these)
    this.errorHandler = (event: ErrorEvent) => {
      const msg = event.message || String(event.error);
      if (this.isRelevantMessage(msg)) {
        this.addEntry('error', 'window.onerror', msg, {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error?.stack,
        });
      }
    };
    window.addEventListener('error', this.errorHandler);

    // Catch unhandled promise rejections
    this.rejectionHandler = (event: PromiseRejectionEvent) => {
      const msg = event.reason?.message || String(event.reason);
      if (this.isRelevantMessage(msg)) {
        this.addEntry('error', 'unhandledrejection', msg, {
          stack: event.reason?.stack,
        });
      }
    };
    window.addEventListener('unhandledrejection', this.rejectionHandler);

    // Hidden keyboard shortcuts
    this.keyHandler = (event: KeyboardEvent) => {
      // Ctrl+Shift+L — Download log
      if (event.ctrlKey && event.shiftKey && event.key === 'L') {
        event.preventDefault();
        this.downloadLog();
      }
      // Ctrl+Shift+K — Clear session log
      if (event.ctrlKey && event.shiftKey && event.key === 'K') {
        event.preventDefault();
        if (this.session) {
          const count = this.session.entries.length;
          this.session.entries = [];
          this.origConsole.log(`[DevLogger] Cleared ${count} log entries`);
        }
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  private stopIntercepting(): void {
    if (!this.isIntercepting) return;
    this.isIntercepting = false;

    // Restore original console methods
    console.log = this.origConsole.log;
    console.warn = this.origConsole.warn;
    console.error = this.origConsole.error;
    console.info = this.origConsole.info;

    // Remove event listeners
    if (this.errorHandler) {
      window.removeEventListener('error', this.errorHandler);
      this.errorHandler = null;
    }
    if (this.rejectionHandler) {
      window.removeEventListener('unhandledrejection', this.rejectionHandler);
      this.rejectionHandler = null;
    }
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
  }

  /** Check if a message string is relevant to capture */
  private isRelevantMessage(msg: string): boolean {
    // Check prefixes
    for (const prefix of CAPTURE_PREFIXES) {
      if (msg.startsWith(prefix)) return true;
    }
    // Check patterns
    for (const pattern of CAPTURE_PATTERNS) {
      if (pattern.test(msg)) return true;
    }
    return false;
  }

  /** Process a captured console call */
  private captureConsole(level: 'log' | 'warn' | 'error' | 'info', args: any[]): void {
    if (!this.session) return;

    // Stringify the message
    const msgParts = args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack}`;
      try {
        return JSON.stringify(arg, null, 0);
      } catch {
        return String(arg);
      }
    });
    const fullMsg = msgParts.join(' ');

    // For errors, always capture. For other levels, filter by relevance.
    if (level === 'error' || this.isRelevantMessage(fullMsg)) {
      // Determine source from message prefix
      let source = 'console';
      if (fullMsg.includes('[ThreeSandbox]')) source = 'ThreeSandbox';
      else if (fullMsg.includes('[SIMULATION')) source = 'SimRuntime';
      else if (fullMsg.includes('[sanitizeSimulationCode]')) source = 'Sanitizer';
      else if (fullMsg.includes('[GeminiService]')) source = 'GeminiService';
      else if (fullMsg.includes('[LLM]')) source = 'LLM';
      else if (fullMsg.includes('[ERROR CORRECTION]')) source = 'ErrorCorrection';
      else if (fullMsg.includes('THREE.')) source = 'Three.js';

      this.addEntry(level, source, fullMsg);
    }
  }

  // ============================
  // Download
  // ============================

  /** Download the current session log as a JSON file */
  downloadLog(): void {
    if (!this.session || this.session.entries.length === 0) {
      this.origConsole.log('[DevLogger] No log entries to download');
      return;
    }

    const sanitizedTopic = this.session.topic
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .substring(0, 40);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `devlog_${sanitizedTopic}_${timestamp}.json`;

    // Build a summary for quick scanning
    const summary = {
      totalEntries: this.session.entries.length,
      errors: this.session.entries.filter(e => e.level === 'error' || e.level === 'sim-error').length,
      warnings: this.session.entries.filter(e => e.level === 'warn').length,
      simCodes: this.session.entries.filter(e => e.level === 'sim-code').length,
      simRetries: this.session.entries.filter(e => e.level === 'sim-retry').length,
      simEdits: this.session.entries.filter(e => e.level === 'sim-edit').length,
      autoFixes: this.session.entries.filter(e => e.level === 'sim-autofix').length,
      durationMs: Math.round(performance.now() - this.sessionStart),
    };

    const logData = {
      _format: 'thinky3d-devlog-v1',
      summary,
      session: this.session,
    };

    const blob = new Blob([JSON.stringify(logData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.origConsole.log(`[DevLogger] Downloaded log: ${filename} (${summary.totalEntries} entries, ${summary.errors} errors)`);
  }
}

// Singleton instance
export const devLogger = new DevLoggerService();
