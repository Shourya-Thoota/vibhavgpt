import { api } from "./api.js";

// The live role-play. The browser holds a WebRTC call with the judge model and
// directs it like a stage manager: the judge never answers a pause on its own
// (the server session sets create_response: false). It speaks only on cue:
//   greet -> (answers the participant's questions) -> question 1 -> question 2 -> close.
// That keeps the judge realistic (mostly listening) and the call cheap.

const DIRECTIONS = {
  greet: "Stage direction: the participant has just walked in. Greet them, introduce yourself by your full name and your role, and ask to hear their ideas. Two short sentences.",
  answer: "Stage direction: the participant just asked you something. Answer briefly and in character, in one or two sentences, then let them continue.",
  nudge: "Stage direction: the participant has gone quiet for a while. In one short sentence, invite them to continue or ask whether there is anything else they would like to cover.",
  q1: "Stage direction: the participant has finished presenting. Ask your first prepared question now, in your own natural words. You may react to their presentation in a few words first. Ask only that one question.",
  wrap: "Stage direction: time is running short. Politely say that in the interest of time you would like to ask a couple of questions, then ask your first prepared question. Ask only that one question.",
  q2: "Stage direction: acknowledge their answer in a few words, then ask your second prepared question. Ask only that one question.",
  close: "Stage direction: thank the participant for their time and ideas and conclude the meeting in one or two sentences. Do not ask anything else.",
};

const DONE_PHRASES = /\b(that (concludes|is all|'s all|wraps up)|those are (all )?my (ideas|recommendations)|do you have any questions|any questions for me|i('m| am) (happy|glad|ready) to (answer|take) (any )?questions|thank you for your time)\b/i;
const SILENCE_NUDGE_MS = 14_000;
const ANSWER_SETTLE_MS = 3_200;

export class JudgeCall {
  constructor({ attemptId, transcript = [], startedAt = performance.now(), offsetSeconds = 0, onChange, onFinished }) {
    this.attemptId = attemptId;
    this.segments = transcript.slice();
    this.offsetSeconds = offsetSeconds;
    this.startedAt = startedAt;
    this.onChange = onChange;
    this.onFinished = onFinished;
    this.phase = transcript.length ? "presenting" : "connecting";
    this.judgeSpeaking = false;
    this.userSpeaking = false;
    this.responding = false;
    this.queue = [];
    this.lastActivity = performance.now();
    this.lastNudge = 0;
    this.spokenMs = 0;
    this.speechStart = 0;
    this.usage = { audioIn: 0, audioInCached: 0, audioOut: 0, textIn: 0, textInCached: 0, textOut: 0, transcriptionSeconds: 0, responses: 0 };
    this.saveTimer = null;
    this.answerTimer = null;
    this.closed = false;
  }

  state() {
    return { phase: this.phase, judgeSpeaking: this.judgeSpeaking, userSpeaking: this.userSpeaking, segments: this.segments };
  }

  emit() { this.onChange?.(this.state()); }

  elapsed() { return this.offsetSeconds + (performance.now() - this.startedAt) / 1000; }

  async connect() {
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.pc = new RTCPeerConnection();
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.pc.ontrack = (event) => { this.audio.srcObject = event.streams[0]; };
    this.pc.addTrack(this.mic.getAudioTracks()[0], this.mic);
    this.pc.onconnectionstatechange = () => {
      if (["failed", "disconnected"].includes(this.pc.connectionState) && !this.closed) { this.phase = "dropped"; this.emit(); }
    };
    this.channel = this.pc.createDataChannel("oai-events");
    this.channel.onmessage = (message) => { try { this.handle(JSON.parse(message.data)); } catch {} };
    const resumed = this.phase === "presenting";
    this.channel.onopen = () => {
      if (resumed) { this.emit(); return; }
      this.phase = "greeting";
      this.direct("greet");
      this.emit();
    };
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const answer = await api(`/attempts/${this.attemptId}/connect`, { method: "POST", body: { sdp: offer.sdp } });
    await this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    this.silenceWatch = setInterval(() => this.watchSilence(), 1000);
    return answer;
  }

  send(event) {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
  }

  // Each cue is a system note in the conversation followed by a response.
  direct(kind) {
    if (this.closed) return;
    if (this.responding) { this.queue.push(kind); return; }
    this.responding = true;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: DIRECTIONS[kind] }] } });
    this.send({ type: "response.create" });
  }

  addSegment(speaker, text) {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    this.segments = [...this.segments, { speaker, text: clean, t: Math.round(this.elapsed()) }];
    this.lastActivity = performance.now();
    this.emit();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      api(`/attempts/${this.attemptId}/transcript`, { method: "PUT", body: { segments: this.segments } }).catch(() => {});
    }, 1500);
  }

  handle(event) {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.userSpeaking = true;
        this.speechStart = performance.now();
        clearTimeout(this.answerTimer);
        this.lastActivity = performance.now();
        this.emit();
        break;
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        this.spokenMs += performance.now() - this.speechStart;
        this.lastActivity = performance.now();
        this.emit();
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.addSegment("participant", event.transcript);
        if (event.usage?.type === "duration") this.usage.transcriptionSeconds += Number(event.usage.seconds) || 0;
        this.afterParticipantTurn(String(event.transcript ?? ""));
        break;
      case "response.output_audio_transcript.done":
        this.addSegment("judge", event.transcript);
        break;
      case "output_audio_buffer.started":
        this.judgeSpeaking = true;
        this.emit();
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.judgeSpeaking = false;
        this.lastActivity = performance.now();
        this.emit();
        if (this.phase === "closing-done") this.finish();
        break;
      case "response.done":
        this.addUsage(event.response?.usage);
        this.responding = false;
        this.afterJudgeTurn(event.response?.status);
        if (this.queue.length) this.direct(this.queue.shift());
        break;
      default:
        break;
    }
  }

  addUsage(usage) {
    if (!usage) return;
    const input = usage.input_token_details ?? {}, output = usage.output_token_details ?? {}, cached = input.cached_tokens_details ?? {};
    this.usage.audioInCached += cached.audio_tokens ?? 0;
    this.usage.textInCached += cached.text_tokens ?? 0;
    this.usage.audioIn += Math.max(0, (input.audio_tokens ?? 0) - (cached.audio_tokens ?? 0));
    this.usage.textIn += Math.max(0, (input.text_tokens ?? 0) - (cached.text_tokens ?? 0));
    this.usage.audioOut += output.audio_tokens ?? 0;
    this.usage.textOut += output.text_tokens ?? 0;
    this.usage.responses += 1;
  }

  afterJudgeTurn(status) {
    if (status === "cancelled") return; // the participant talked over the judge
    if (this.phase === "greeting") this.phase = "presenting";
    else if (this.phase === "q1") this.phase = "answer1";
    else if (this.phase === "q2") this.phase = "answer2";
    else if (this.phase === "closing") {
      this.phase = "closing-done";
      // If the audio-stopped event never arrives, finish anyway.
      setTimeout(() => this.finish(), 9000);
    }
    this.emit();
  }

  afterParticipantTurn(text) {
    if (this.phase === "presenting") {
      if (DONE_PHRASES.test(text)) this.startQuestions();
      else if (/\?\s*$/.test(text)) this.direct("answer");
    } else if (this.phase === "answer1" || this.phase === "answer2") {
      // Wait until the participant has really finished answering.
      clearTimeout(this.answerTimer);
      this.answerTimer = setTimeout(() => {
        if (this.userSpeaking || this.closed) return;
        if (this.phase === "answer1") { this.phase = "q2"; this.direct("q2"); }
        else if (this.phase === "answer2") { this.phase = "closing"; this.direct("close"); }
        this.emit();
      }, ANSWER_SETTLE_MS);
    }
  }

  watchSilence() {
    if (this.phase !== "presenting" || this.userSpeaking || this.judgeSpeaking || this.responding) return;
    const now = performance.now();
    if (this.spokenMs > 20_000 && now - this.lastActivity > SILENCE_NUDGE_MS && now - this.lastNudge > 45_000) {
      this.lastNudge = now;
      this.direct("nudge");
    }
  }

  // Called by the participant ("I'm ready for questions") or by the clock.
  startQuestions(reason = "participant") {
    if (this.phase !== "presenting" && this.phase !== "greeting") return;
    this.phase = "q1";
    this.direct(reason === "time" ? "wrap" : "q1");
    this.emit();
  }

  async finish() {
    if (this.closed) return;
    this.close();
    this.phase = "done";
    this.emit();
    this.onFinished?.({ segments: this.segments, usage: this.usage });
  }

  close() {
    this.closed = true;
    clearInterval(this.silenceWatch);
    clearTimeout(this.answerTimer);
    clearTimeout(this.saveTimer);
    try { this.channel?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.mic?.getTracks().forEach((track) => track.stop());
    if (this.audio) this.audio.srcObject = null;
  }
}
