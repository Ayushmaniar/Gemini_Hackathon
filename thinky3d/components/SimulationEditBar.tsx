import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, Send, X, Loader2 } from 'lucide-react';
import { SimEditHistoryItem } from '../types';

interface SimulationEditBarProps {
  onSubmit: (request: string) => void;
  isLoading: boolean;
  history: SimEditHistoryItem[];
}

export const SimulationEditBar: React.FC<SimulationEditBarProps> = ({
  onSubmit,
  isLoading,
  history
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, isLoading]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.stopImmediatePropagation();
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen]);

  const submit = () => {
    const t = inputValue.trim();
    if (t && !isLoading) {
      onSubmit(t);
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="sim-edit-fab"
      >
        <Sparkles size={18} />
        Edit Simulation
      </button>
    );
  }

  return (
    <div className="sim-edit-panel">
      <div className="sim-edit-header">
        <div className="flex items-center gap-2">
          <Sparkles size={18} />
          <span className="font-bold text-sm">Edit Simulation</span>
        </div>
        <button
          onClick={() => setIsOpen(false)}
          className="sim-edit-close-btn"
          title="Close"
          aria-label="Close edit panel"
        >
          <X size={16} />
        </button>
      </div>

      <div className="sim-edit-messages custom-scrollbar">
        {history.length === 0 && !isLoading && (
          <div className="sim-edit-empty">
            <Sparkles size={28} strokeWidth={1.5} />
            <p className="font-semibold text-sm mt-3">Describe your changes</p>
            <p className="text-xs mt-1 opacity-70">
              e.g., &quot;Make the balls bigger&quot; or &quot;Add a slider for mass&quot;
            </p>
          </div>
        )}

        {history.flatMap((item, i) => [
          <div key={`user-${i}`} className="sim-edit-message sim-edit-message-user">
            <p>{item.userRequest}</p>
          </div>,
          item.pending ? (
            <div key={`assistant-${i}`} className="sim-edit-message sim-edit-message-assistant sim-edit-typing">
              <Loader2 size={14} className="animate-spin" />
              <span>Editing...</span>
            </div>
          ) : (
            <div
              key={`assistant-${i}`}
              className={`sim-edit-message sim-edit-message-assistant ${item.success ? 'sim-edit-message-success' : 'sim-edit-message-error'}`}
            >
              <p>{item.explanation}</p>
            </div>
          )
        ])}

        <div ref={messagesEndRef} />
      </div>

      <div className="sim-edit-input-area">
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g., Make the balls bigger..."
          disabled={isLoading}
          autoFocus
          autoComplete="off"
          className="sim-edit-input"
          rows={2}
        />
        <button
          onClick={submit}
          disabled={!inputValue.trim() || isLoading}
          className="sim-edit-send-btn"
          title="Apply"
          aria-label="Apply edit"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};
