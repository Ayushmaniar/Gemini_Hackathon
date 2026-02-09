import React from 'react';
import { ControlParam } from '../types';
import { Sliders, ToggleLeft, MousePointerClick } from 'lucide-react';

interface ControlsProps {
  config: ControlParam[];
  values: Record<string, number>;
  onChange: (name: string, value: number) => void;
}

export const Controls: React.FC<ControlsProps> = ({ config, values, onChange }) => {
  return (
    <div className="rounded-2xl border-2 p-6 flex flex-col h-full shadow-2xl controls-panel">
      <div className="flex items-center gap-3 mb-6" style={{ color: '#ff8a5b' }}>
        <Sliders size={24} strokeWidth={2.5} />
        <h3 className="font-black uppercase tracking-wide text-base">Simulation Controls</h3>
      </div>

      <div className="space-y-5 overflow-y-auto pr-2 custom-scrollbar">
        {config.map((param) => {
          const val = values[param.name] ?? param.defaultValue;

          if (param.controlType === 'toggle') {
            const isOn = val > 0.5;
            return (
              <div key={param.name} className="flex items-center justify-between p-4 rounded-xl border-2 control-toggle">
                <div className="flex items-center gap-3">
                  <ToggleLeft size={22} className={isOn ? "text-[#ff8a5b]" : ""} style={{ color: isOn ? '#ff8a5b' : 'var(--text-muted)' }} strokeWidth={2.5} />
                  <label className="font-bold text-sm control-label">{param.label}</label>
                </div>
                <button
                  onClick={() => onChange(param.name, isOn ? 0 : 1)}
                  className={`relative inline-flex h-7 w-14 items-center rounded-full transition-all ${isOn ? 'shadow-lg' : ''}`}
                  style={{ background: isOn ? 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' : 'var(--bg-elevated)' }}
                >
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform shadow-md ${isOn ? 'translate-x-8' : 'translate-x-1'}`} />
                </button>
              </div>
            );
          }

          if (param.controlType === 'button') {
            return (
              <button
                key={param.name}
                onClick={() => onChange(param.name, val + 1)}
                className="w-full py-3 text-white rounded-xl flex items-center justify-center gap-2 text-sm font-bold transition-all hover:scale-105 shadow-lg"
                style={{ background: 'linear-gradient(135deg, #8b5cf6 0%, #a78bfa 100%)' }}
              >
                <MousePointerClick size={18} />
                {param.label}
              </button>
            );
          }

          // Default: Slider
          return (
            <div key={param.name} className="space-y-3 p-4 rounded-xl border-2 control-slider">
              <div className="flex justify-between text-sm">
                <label className="font-bold control-label">{param.label}</label>
                <span className="font-mono font-bold px-3 py-1 rounded-lg text-white" style={{ background: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)' }}>{val.toFixed(1)}</span>
              </div>
              <div className="relative">
                <input
                  type="range"
                  min={param.min ?? 0}
                  max={param.max ?? 100}
                  step={param.step ?? 1}
                  value={val}
                  onChange={(e) => onChange(param.name, parseFloat(e.target.value))}
                  className="w-full h-3 rounded-lg appearance-none cursor-pointer range-slider"
                  style={{
                    background: `linear-gradient(to right, #4285f4 0%, #34a853 ${((val - (param.min ?? 0)) / ((param.max ?? 100) - (param.min ?? 0))) * 100}%, var(--bg-elevated) ${((val - (param.min ?? 0)) / ((param.max ?? 100) - (param.min ?? 0))) * 100}%, var(--bg-elevated) 100%)`
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
