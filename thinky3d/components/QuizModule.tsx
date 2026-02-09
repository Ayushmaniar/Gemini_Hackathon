import React, { useState, useEffect, useRef } from 'react';
import { QuizQuestion } from '../types';
import { CheckCircle, AlertCircle, Award, ArrowRight, RotateCcw } from 'lucide-react';

interface QuizModuleProps {
  questions: QuizQuestion[];
  onComplete: () => void;
}

export const QuizModule: React.FC<QuizModuleProps> = ({ questions, onComplete }) => {
  const [currentQIndex, setCurrentQIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [score, setScore] = useState(0);
  const [showResult, setShowResult] = useState(false);
  
  const quizContentRef = useRef<HTMLDivElement>(null);

  const currentQuestion = questions[currentQIndex];

  // Trigger MathJax typesetting when question changes
  useEffect(() => {
    if (showResult) return;
    
    const renderMath = async () => {
      if (!quizContentRef.current) return;
      
      const MathJax = (window as any).MathJax;
      if (!MathJax || !MathJax.typesetPromise) {
        // Retry after a short delay if MathJax isn't ready
        setTimeout(renderMath, 200);
        return;
      }

      try {
        if (MathJax.startup?.promise) {
          await MathJax.startup.promise;
        }
        
        if (MathJax.typesetClear) {
          MathJax.typesetClear([quizContentRef.current]);
        }
        
        await MathJax.typesetPromise([quizContentRef.current]);
      } catch (err) {
        console.warn("MathJax typeset error in quiz:", err);
      }
    };

    // Small delay to ensure DOM is updated
    const timer = setTimeout(renderMath, 100);
    return () => clearTimeout(timer);
  }, [currentQIndex, showResult]);

  const handleOptionClick = (index: number) => {
    if (isAnswered) return;
    setSelectedOption(index);
  };

  const checkAnswer = () => {
    if (selectedOption === null) return;
    
    setIsAnswered(true);
    if (selectedOption === currentQuestion.correctAnswerIndex) {
      setScore(s => s + 1);
    }
  };

  const nextQuestion = () => {
    if (currentQIndex < questions.length - 1) {
      setCurrentQIndex(prev => prev + 1);
      setSelectedOption(null);
      setIsAnswered(false);
    } else {
      setShowResult(true);
    }
  };

  if (showResult) {
    const passed = score === questions.length;
    return (
      <div className="flex flex-col items-center justify-center h-full p-12 text-center rounded-3xl border-2 quiz-result">
        <div className={`p-6 rounded-3xl mb-8 relative ${passed ? 'bg-gradient-to-br from-emerald-500/20 to-green-500/20' : 'bg-gradient-to-br from-yellow-500/20 to-orange-500/20'}`}>
          <div className={`absolute inset-0 rounded-3xl blur-2xl opacity-50 ${passed ? 'bg-emerald-500' : 'bg-yellow-500'}`}></div>
          <Award size={80} className={`relative ${passed ? 'text-emerald-400' : 'text-yellow-400'}`} strokeWidth={2.5} />
        </div>
        <h2 className="text-5xl font-black mb-4 quiz-title">Quiz Complete!</h2>
        <p className="mb-10 text-2xl quiz-score-text">
          You scored <span className="font-black px-4 py-2 rounded-xl text-white mx-2" style={{ background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' }}>{score}</span>
          out of <strong className="quiz-total">{questions.length}</strong>
        </p>

        <div className="flex gap-5">
          <button
            onClick={() => {
              setCurrentQIndex(0);
              setScore(0);
              setShowResult(false);
              setSelectedOption(null);
              setIsAnswered(false);
            }}
            className="flex items-center gap-2 px-8 py-4 rounded-2xl font-bold transition-all hover:scale-105 border-2 quiz-retry-btn"
          >
            <RotateCcw size={22} />
            Retry Quiz
          </button>

          <button
            onClick={onComplete}
            className="flex items-center gap-2 px-8 py-4 text-white rounded-2xl font-bold transition-all hover:scale-105 shadow-2xl"
            style={{ background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' }}
          >
            Continue to Next Chapter
            <ArrowRight size={22} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto py-4 overflow-y-auto custom-scrollbar">
      <div className="mb-8 flex justify-between items-center text-base font-bold flex-shrink-0">
        <span className="px-4 py-2 rounded-xl border-2 quiz-progress-badge">
          Question {currentQIndex + 1} of {questions.length}
        </span>
        <span className="px-4 py-2 rounded-xl text-white" style={{ background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' }}>
          Score: {score}/{questions.length}
        </span>
      </div>

      <div ref={quizContentRef} className="p-12 rounded-3xl border-2 shadow-2xl flex-grow flex flex-col quiz-card min-h-0 mathjax-process">
        <h3 className="text-3xl font-bold mb-10 leading-relaxed quiz-question">
          {currentQuestion.question}
        </h3>

        <div className="space-y-4 flex-grow overflow-y-auto custom-scrollbar">
          {currentQuestion.options.map((option, idx) => {
            let className = "w-full p-6 rounded-2xl text-left transition-all border-2 text-lg font-medium ";
            let style: React.CSSProperties = {};

            if (isAnswered) {
              if (idx === currentQuestion.correctAnswerIndex) {
                className += "border-emerald-500 text-emerald-300";
                style.background = 'rgba(16, 185, 129, 0.1)';
              } else if (idx === selectedOption) {
                className += "border-red-500 text-red-300";
                style.background = 'rgba(239, 68, 68, 0.1)';
              } else {
                className += "quiz-option-disabled";
              }
            } else {
               if (selectedOption === idx) {
                 className += "quiz-option-selected";
               } else {
                 className += "quiz-option";
               }
            }

            return (
              <button
                key={idx}
                onClick={() => handleOptionClick(idx)}
                className={className}
                style={style}
                disabled={isAnswered}
              >
                <div className="flex items-center justify-between">
                  <span>{option}</span>
                  {isAnswered && idx === currentQuestion.correctAnswerIndex && <CheckCircle size={28} strokeWidth={2.5} />}
                  {isAnswered && idx === selectedOption && idx !== currentQuestion.correctAnswerIndex && <AlertCircle size={28} strokeWidth={2.5} />}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-12 flex justify-end">
          {!isAnswered ? (
            <button
              onClick={checkAnswer}
              disabled={selectedOption === null}
              className={`px-10 py-4 rounded-2xl font-bold transition-all text-lg shadow-xl ${
                selectedOption === null
                  ? 'cursor-not-allowed quiz-check-disabled'
                  : 'text-white hover:scale-105'
              }`}
              style={selectedOption !== null ? { background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' } : {}}
            >
              Check Answer
            </button>
          ) : (
            <button
              onClick={nextQuestion}
              className="px-10 py-4 text-white rounded-2xl font-bold transition-all text-lg shadow-2xl hover:scale-105"
              style={{ background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' }}
            >
              {currentQIndex < questions.length - 1 ? "Next Question" : "See Results"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
