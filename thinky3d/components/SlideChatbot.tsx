import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Send, MessageCircle, Loader2 } from 'lucide-react';
import { ChatMessage, Slide, LearningLevel } from '../types';
import { chatWithSlides } from '../services/geminiService';

interface SlideChatbotProps {
  slides: Slide[];
  currentSlideIndex: number;
  /** Sections the student has seen (current + previous), each with title + slides */
  contextSections: Array<{ title: string; slides: Slide[] }>;
  currentSectionTitle: string;
  courseTopic: string;
  learningLevel: LearningLevel;
  onClose: () => void;
}

export const SlideChatbot: React.FC<SlideChatbotProps> = ({
  slides,
  currentSlideIndex,
  contextSections,
  currentSectionTitle,
  courseTopic,
  learningLevel,
  onClose,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const now = Date.now();
    const userMessage: ChatMessage = {
      id: `user-${now}`,
      role: 'user',
      content: trimmed,
      timestamp: now,
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await chatWithSlides(
        trimmed,
        [...messages, userMessage],
        contextSections,
        currentSectionTitle,
        currentSlideIndex,
        courseTopic,
        learningLevel
      );

      setMessages(prev => [
        ...prev,
        { id: `assistant-${Date.now()}`, role: 'assistant', content: response, timestamp: Date.now() },
      ]);
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: 'Sorry, I encountered an error. Please try again.',
          timestamp: Date.now(),
        },
      ]);
      console.error('Chatbot error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, messages, contextSections, currentSectionTitle, currentSlideIndex, courseTopic, learningLevel]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /** Render markdown-light assistant content (bold, bullets, inline code, math) */
  const renderContent = (content: string) => {
    // Convert markdown-like formatting to HTML
    let html = content
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code class="chatbot-inline-code">$1</code>')
      // Bullet lists: lines starting with "- "
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      // Wrap consecutive <li> in <ul>
      .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul class="chatbot-list">$1</ul>')
      // Paragraphs: double newlines
      .replace(/\n\n/g, '</p><p>')
      // Single newlines within paragraphs
      .replace(/\n/g, '<br/>');

    html = `<p>${html}</p>`;

    return (
      <div
        className="chatbot-message-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  };

  // Trigger MathJax on new assistant messages
  useEffect(() => {
    const MathJax = (window as any).MathJax;
    if (MathJax?.typesetPromise) {
      setTimeout(() => {
        MathJax.typesetPromise().catch(() => {});
      }, 100);
    }
  }, [messages]);

  return (
    <div className="slide-chatbot-panel">
      {/* Header */}
      <div className="slide-chatbot-header">
        <div className="flex items-center gap-2">
          <MessageCircle size={18} />
          <span className="font-bold text-sm">Ask about this section</span>
        </div>
        <button
          onClick={onClose}
          className="slide-chatbot-close-btn"
          title="Close chat"
        >
          <X size={16} />
        </button>
      </div>

      {/* Messages */}
      <div className="slide-chatbot-messages custom-scrollbar">
        {messages.length === 0 && (
          <div className="slide-chatbot-empty">
            <MessageCircle size={32} strokeWidth={1.5} />
            <p className="font-semibold text-sm mt-3">Ask me anything</p>
            <p className="text-xs mt-1 opacity-70">
              I can answer questions about the slides in this section and everything you've covered so far.
            </p>
          </div>
        )}

        {messages.map(msg => (
          <div
            key={msg.id}
            className={`slide-chatbot-message ${
              msg.role === 'user'
                ? 'slide-chatbot-message-user'
                : 'slide-chatbot-message-assistant'
            }`}
          >
            {msg.role === 'user' ? (
              <p>{msg.content}</p>
            ) : (
              renderContent(msg.content)
            )}
          </div>
        ))}

        {isLoading && (
          <div className="slide-chatbot-message slide-chatbot-message-assistant">
            <div className="slide-chatbot-typing">
              <Loader2 size={14} className="animate-spin" />
              <span>Thinking...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="slide-chatbot-input-area">
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question..."
          className="slide-chatbot-input"
          disabled={isLoading}
          rows={2}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isLoading}
          className="slide-chatbot-send-btn"
          title="Send"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};
