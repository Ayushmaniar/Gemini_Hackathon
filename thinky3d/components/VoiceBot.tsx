import React, { useState, useRef, useEffect } from 'react';
import { Slide, VoiceSettings, DEFAULT_VOICE_SETTINGS } from '../types';
import { createAudioBlobUrl } from '../services/geminiService';

interface VoiceBotProps {
  slide: Slide;
  slideIndex: number;
  onSubtitleChange?: (subtitle: string | null) => void;
  isVoiceEnabled?: boolean;
}

export const VoiceBot: React.FC<VoiceBotProps> = ({ 
  slide, 
  slideIndex,
  onSubtitleChange,
  isVoiceEnabled = false
}) => {
  // Voice settings state
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  
  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null);
  
  // Audio element ref
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  // Track current slide to detect changes
  const prevSlideIndexRef = useRef<number>(slideIndex);
  
  // Subtitle sentences array
  const subtitleSentencesRef = useRef<string[]>([]);

  // Check if narration is available for this slide
  const hasNarration = !!(slide.speakerNotes && slide.audioData);
  
  // Split speaker notes into sentences for subtitle synchronization
  useEffect(() => {
    if (slide.speakerNotes) {
      // Split by sentence endings (. ! ?) but keep the punctuation
      const sentences = slide.speakerNotes
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
      subtitleSentencesRef.current = sentences;
    } else {
      subtitleSentencesRef.current = [];
    }
  }, [slide.speakerNotes]);
  
  // Track audio playback time and update subtitles
  useEffect(() => {
    if (!isVoiceEnabled || !isPlaying || !audioRef.current || subtitleSentencesRef.current.length === 0) {
      setCurrentSubtitle(null);
      onSubtitleChange?.(null);
      return;
    }

    const updateSubtitle = () => {
      if (!audioRef.current) return;
      
      const currentTime = audioRef.current.currentTime;
      const duration = audioRef.current.duration || 0;
      
      if (duration === 0) return;
      
      // Calculate which sentence to show based on playback progress
      // Use word count to weight sentence timing (longer sentences get more time)
      const totalWords = subtitleSentencesRef.current.reduce((sum, s) => sum + s.split(/\s+/).length, 0);
      let accumulatedWords = 0;
      let sentenceIndex = 0;
      
      for (let i = 0; i < subtitleSentencesRef.current.length; i++) {
        const sentenceWords = subtitleSentencesRef.current[i].split(/\s+/).length;
        const sentenceStartProgress = accumulatedWords / totalWords;
        const sentenceEndProgress = (accumulatedWords + sentenceWords) / totalWords;
        
        if (currentTime >= sentenceStartProgress * duration && currentTime <= sentenceEndProgress * duration) {
          sentenceIndex = i;
          break;
        }
        
        accumulatedWords += sentenceWords;
        // If we've passed this sentence, continue to next
        if (currentTime > sentenceEndProgress * duration) {
          sentenceIndex = i;
        }
      }
      
      const subtitle = subtitleSentencesRef.current[sentenceIndex] || null;
      setCurrentSubtitle(subtitle);
      onSubtitleChange?.(subtitle);
    };

    const interval = setInterval(updateSubtitle, 100); // Update every 100ms for smooth transitions
    
    // Initial update
    updateSubtitle();

    return () => clearInterval(interval);
  }, [isPlaying, isVoiceEnabled, onSubtitleChange]);
  
  // Reset subtitle when voice is disabled or slide changes
  useEffect(() => {
    if (!isVoiceEnabled || !hasNarration) {
      setCurrentSubtitle(null);
      onSubtitleChange?.(null);
    }
  }, [isVoiceEnabled, hasNarration, onSubtitleChange]);

  // Create audio URL from pre-generated audio data when slide changes
  useEffect(() => {
    // Clean up previous audio URL
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }

    // Stop playback if slide changed
    if (prevSlideIndexRef.current !== slideIndex) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      setIsPlaying(false);
      setError(null);
      prevSlideIndexRef.current = slideIndex;
    }

    // Create new audio URL if audio data is available
    if (slide.audioData) {
      try {
        const url = createAudioBlobUrl(slide.audioData);
        setAudioUrl(url);
        setError(null);
      } catch (err) {
        console.error('Error creating audio URL:', err);
        setError('Failed to load audio');
      }
    }

    // Cleanup on unmount
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [slideIndex, slide.audioData, settings.autoPlay, isVoiceEnabled]);

  // React to voice being enabled/disabled to control playback
  useEffect(() => {
    if (!audioRef.current || !audioUrl) {
      return;
    }

    if (!isVoiceEnabled || !hasNarration) {
      // Stop and reset when voice is disabled or narration missing
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
      setCurrentSubtitle(null);
      onSubtitleChange?.(null);
      return;
    }

    // Start playback from beginning when voice is enabled
    audioRef.current.src = audioUrl;
    audioRef.current.volume = settings.volume;
    audioRef.current.currentTime = 0;
    audioRef.current
      .play()
      .then(() => setIsPlaying(true))
      .catch(err => {
        console.error('Playback failed:', err);
        setError('Playback failed');
      });
  }, [isVoiceEnabled, audioUrl, hasNarration, settings.volume, onSubtitleChange]);

  // Audio event handlers
  const handleAudioEnded = () => {
    setIsPlaying(false);
  };

  return (
    <audio 
      ref={audioRef} 
      onEnded={handleAudioEnded}
      onError={() => {
        setError('Audio playback error');
        setIsPlaying(false);
      }}
    />
  );
};
