import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";

// Speech-to-text for the composer, done entirely by the device: the browser's
// built-in speech recognition on the web, and the phone's recognizer through
// the native SpeechRecognition plugin in the Android app (its WebView has no
// web speech API). VibhavGPT never receives audio, only the text the person
// chooses to send, so nothing here touches the server.
const NativeSpeech = registerPlugin("SpeechRecognition");

// Brave has the speech recognition API but no speech service behind it (that service needs a Google key that Brave does not ship), so
// every attempt ends in a "network" error even when the device is online. Verified in Brave: the events are start, audiostart,
// audioend, error "network", end, with navigator.onLine true. The mic is not offered there, rather than offered and failing.
export function isBrave() {
  return typeof navigator !== "undefined" && Boolean(navigator.brave) && typeof navigator.brave.isBrave === "function";
}

function webRecognizer() {
  if (typeof window === "undefined") return null;
  if (isBrave()) return null;
  // The Windows app (Electron) exposes the API, but it has no recognition
  // service behind it and every attempt fails, so the mic stays hidden there.
  if (/\bElectron\//.test(navigator.userAgent)) return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function nativeSpeechAvailable() {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("SpeechRecognition");
}

export function dictationSupported() {
  return nativeSpeechAvailable() || Boolean(webRecognizer());
}

// Appends what was said to what was already typed, with one space between.
export function joinDictation(base, spoken) {
  const text = spoken.trim();
  if (!text) return base;
  if (!base) return text;
  return /\s$/.test(base) ? `${base}${text}` : `${base} ${text}`;
}

// What each reason means, in words. The browser reports one code, "network", both for being offline and for its speech service being
// unreachable, so the device's own online state decides which of the two it is.
export function describeDictationError(code, { online = true, secure = true } = {}) {
  if (!secure) return "Dictation needs a secure (HTTPS) connection to this site.";
  switch (code) {
    case "not-allowed": return "Microphone access is blocked. Allow it in your browser or phone settings to speak a message.";
    case "service-not-allowed": return "This browser doesn't allow speech recognition here. Type your message, or try another browser.";
    case "audio-capture": return "No microphone was found. Check that one is connected and chosen in your system settings.";
    case "no-speech": return "No speech was heard. Check your microphone, then try again.";
    case "network":
      return online
        ? "This browser's speech service isn't available right now, although you are online. Type your message, or try another browser."
        : "You appear to be offline. Dictation needs a connection to your browser's speech service. Check your connection and try again.";
    case "language-not-supported": return "Speech recognition doesn't support your device language yet.";
    case "aborted": return "";
    default: return "Speech recognition stopped unexpectedly. Try again.";
  }
}

// onTranscript receives the full text heard in the current session each time
// it changes; the caller decides how to merge it with the draft.
export function useDictation({ onTranscript, onError }) {
  const [listening, setListening] = useState(false);
  const [supported] = useState(dictationSupported);
  const recognitionRef = useRef(null);
  const listenersRef = useRef([]);
  // Results that land after stop() (or after unmount) are dropped, so a sent
  // message can't be refilled by a late final result.
  const activeRef = useRef(false);
  const callbacks = useRef({ onTranscript, onError });
  callbacks.current = { onTranscript, onError };

  const clearNative = useCallback(() => {
    listenersRef.current.forEach((listener) => listener.remove?.());
    listenersRef.current = [];
  }, []);

  const finish = useCallback(() => {
    activeRef.current = false;
    recognitionRef.current = null;
    clearNative();
    setListening(false);
  }, [clearNative]);

  const fail = useCallback((code) => {
    finish();
    // A manual stop is not an error. Silence is told gently, so the person knows nothing was heard.
    const message = describeDictationError(code, { online: typeof navigator === "undefined" || navigator.onLine !== false, secure: typeof window === "undefined" || window.isSecureContext !== false });
    if (message) callbacks.current.onError?.(message);
  }, [finish]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    activeRef.current = false;
    if (recognition) {
      try { recognition.stop(); } catch { /* already stopped */ }
    } else if (nativeSpeechAvailable()) {
      void NativeSpeech.stop().catch(() => null);
    }
    finish();
  }, [finish]);

  const startNative = useCallback(async () => {
    const permission = await NativeSpeech.checkPermissions().catch(() => null);
    let state = permission?.speechRecognition;
    if (state !== "granted") state = (await NativeSpeech.requestPermissions().catch(() => null))?.speechRecognition;
    if (state !== "granted") return fail("not-allowed");
    const { available } = await NativeSpeech.available().catch(() => ({ available: false }));
    if (!available) return fail("service-not-allowed");

    clearNative();
    activeRef.current = true;
    setListening(true);
    listenersRef.current = await Promise.all([
      NativeSpeech.addListener("partialResults", ({ matches }) => {
        if (activeRef.current && matches?.[0] != null) callbacks.current.onTranscript?.(matches[0]);
      }),
      NativeSpeech.addListener("listeningState", ({ status }) => {
        if (status === "stopped") finish();
      }),
    ]);
    try {
      await NativeSpeech.start({ language: navigator.language || "en-US", partialResults: true, popup: false });
    } catch (error) {
      fail(/permission/i.test(error?.message ?? "") ? "not-allowed" : "unknown");
    }
  }, [clearNative, fail, finish]);

  const startWeb = useCallback(() => {
    const Recognition = webRecognizer();
    if (!Recognition) return fail("service-not-allowed");
    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    // Chrome on Android repeats earlier phrases in continuous mode, so there it
    // listens for one utterance and stops on the pause, like the keyboard mic.
    recognition.continuous = !/Android/i.test(navigator.userAgent);
    recognition.onresult = (event) => {
      if (!activeRef.current) return;
      let text = "";
      for (let index = 0; index < event.results.length; index += 1) text += event.results[index][0].transcript;
      callbacks.current.onTranscript?.(text);
    };
    recognition.onerror = (event) => fail(event.error);
    recognition.onend = () => { if (recognitionRef.current === recognition) finish(); };
    recognitionRef.current = recognition;
    activeRef.current = true;
    setListening(true);
    try {
      recognition.start();
    } catch {
      fail("unknown");
    }
  }, [fail, finish]);

  const start = useCallback(() => {
    if (activeRef.current) return;
    if (nativeSpeechAvailable()) void startNative();
    else startWeb();
  }, [startNative, startWeb]);

  useEffect(() => () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
    if (nativeSpeechAvailable()) void NativeSpeech.stop().catch(() => null);
    listenersRef.current.forEach((listener) => listener.remove?.());
  }, []);

  return { supported, listening, start, stop };
}
