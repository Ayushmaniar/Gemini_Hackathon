# Thinky3D

**Learn anything with AI-crafted lessons and immersive 3D simulations.**

> [**Try it live**](https://thinky3d.vercel.app/)

Thinky3D turns any topic or any PDF into a full interactive course with rich slides, live 3D simulations, an in-context chatbot, and adaptive quizzes. All generated on-the-fly by Google Gemini.

---

## Features

| Feature | Description |
|---|---|
| **AI Course Generation** | Type a topic or drop a PDF Gemini builds a structured, multi-chapter syllabus instantly. |
| **Rich Slide Decks** | Beautifully themed HTML slides with LaTeX math support (MathJax), gradient backgrounds, and smooth transitions. |
| **Live 3D Simulations** | Every chapter gets a unique, interactive React Three Fiber scene with adjustable parameters — generated entirely by AI. |
| **AI Chatbot** | Ask follow-up questions about any slide and get answers grounded in the course content. |
| **Adaptive Quizzes** | Auto-generated quizzes to test understanding after each chapter. |
| **4 Learning Levels** | Beginner, High School, Undergraduate, or Graduate — content depth adapts to your level. |
| **PDF Import** | Upload lecture notes or textbooks; Thinky3D extracts the text and builds a course around it. |
| **Background Prefetch** | Sections generate sequentially in the background so the next chapter is ready when you are. |
| **Auto Error Recovery** | If a 3D simulation throws a runtime error, Gemini automatically regenerates corrected code. |
| **Download** | Export all slides, simulations, and quizzes as a downloadable package. |

---

## Tech Stack

- **Frontend** React 19, TypeScript, Vite
- **3D** Three.js, React Three Fiber, Drei
- **AI** Google Gemini 3.0 Flash (slides, quizzes, chat) + Gemini 3.0 Pro (3D simulation code)
- **Math** MathJax 3
- **PDF** PDF.js
- **Styling** Tailwind CSS, Clash Display + Satoshi fonts
- **Deployment** Vercel

---

## Getting Started

### Prerequisites

- Node.js 18+
- A [Google Gemini API key](https://aistudio.google.com/apikey)

### Setup

```bash
# Clone the repo
git clone https://github.com/<your-username>/thinky3d.git
cd thinky3d

# Install dependencies
npm install

# Add your API key
echo "GEMINI_API_KEY=your_key_here" > .env.local

# Start the dev server
npm run dev
```

The app will be running at **http://localhost:3001**.

---

## How It Works

```
Topic / PDF  ──>  Gemini generates syllabus
                         │
                         ▼
                  For each chapter:
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
        Slides    3D Simulation     Quiz
      (Flash)       (Pro)         (Flash)
           │             │             │
           ▼             ▼             ▼
      Styled HTML   Interactive    Adaptive
      with LaTeX    R3F Scene     Questions
```

1. **Syllabus** Gemini analyzes the topic and outputs a chapter list with descriptions.
2. **Slides** Each chapter's slides are generated as styled HTML with math, diagrams, and examples.
3. **3D Simulation** Gemini Pro writes a self-contained React Three Fiber component with controllable parameters.
4. **Quiz** Multiple-choice questions are generated to reinforce learning.

Sections prefetch in the background so users can start learning immediately while later chapters generate.

---

## Project Structure

```
thinky3d/
├── App.tsx                  # Main app shell & state machine
├── types.ts                 # Shared TypeScript types
├── index.css                # Global styles & cosmic theme
├── components/
│   ├── SlideViewer.tsx      # Slide presentation with navigation
│   ├── ThreeSandbox.tsx     # Sandboxed 3D renderer for AI-generated code
│   ├── Controls.tsx         # Parameter sliders/toggles for simulations
│   ├── QuizModule.tsx       # Interactive quiz UI
│   └── SlideChatbot.tsx     # AI chat panel for asking questions
├── services/
│   ├── geminiService.ts     # All Gemini API calls (slides, sim, quiz, chat)
│   ├── pdfParser.ts         # PDF text extraction via PDF.js
│   ├── downloadService.ts   # Export content as downloadable archive
│   └── devLogger.ts         # Dev-mode logging & diagnostics
├── hooks/
│   └── useSlideStyles.ts    # Dynamic slide theming hook
├── utils/
│   ├── htmlUtils.ts         # HTML compression for slide content
│   └── colors.ts            # Color utilities
└── vite.config.ts           # Vite config with env + chunking
```

---

## License

Built for the Google Gemini API Developer Competition.
