import { useState, useRef, useEffect, useCallback } from "react";

const SpeechRecognitionCtor =
  typeof window !== "undefined"
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

export function useSpeechRecognition(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const stoppedByUserRef = useRef(false);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  // Cleanup on unmount — kill any running recognition
  useEffect(() => {
    return () => {
      stoppedByUserRef.current = true;
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch {}
        recognitionRef.current = null;
      }
    };
  }, []);

  const stop = useCallback(() => {
    stoppedByUserRef.current = true;
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
    }
  }, []);

  const toggle = useCallback(() => {
    if (!SpeechRecognitionCtor) return;

    // If already running, stop
    if (recognitionRef.current) {
      stop();
      return;
    }

    stoppedByUserRef.current = false;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognitionRef.current = recognition;

    let lastResultIndex = 0;

    recognition.onresult = (event: any) => {
      for (let i = lastResultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0]?.transcript;
          if (text) onResultRef.current(text);
          lastResultIndex = i + 1;
        }
      }
    };

    recognition.onstart = () => setListening(true);

    recognition.onend = () => {
      if (!stoppedByUserRef.current) {
        // Auto-restart on silence timeout
        try {
          recognition.start();
          return;
        } catch {}
      }
      // Fully stopped
      recognitionRef.current = null;
      setListening(false);
    };

    recognition.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        stoppedByUserRef.current = true;
        recognitionRef.current = null;
        setListening(false);
      }
      // 'no-speech' and 'aborted' are recoverable — let onend handle restart
    };

    recognition.start();
  }, [stop]);

  return {
    listening,
    toggle,
    stop,
    supported: !!SpeechRecognitionCtor,
  };
}
