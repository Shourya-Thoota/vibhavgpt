import "dotenv/config";

const env = (name, fallback) => process.env[name]?.trim() || fallback;

// DECANet's own settings. Its OpenAI key is separate from every VibhavGPT
// inference key, so its spend is visible and capped on its own.
export const decanetConfig = {
  get openaiApiKey() { return env("DECANET_OPENAI_API_KEY"); },
  get openaiBaseUrl() { return env("DECANET_OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""); },
  get realtimeModel() { return env("DECANET_REALTIME_MODEL", "gpt-realtime-2.1-mini"); },
  get transcriptionModel() { return env("DECANET_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"); },
  get graderModel() { return env("DECANET_GRADER_MODEL", "o4-mini"); },
  get appUrl() { return env("DECANET_APP_URL", "https://decanet.vibhavgpt.com").replace(/\/+$/, ""); },
  get vibhavgptUrl() { return env("DECANET_VIBHAVGPT_URL", "https://vibhavgpt.com").replace(/\/+$/, ""); },
  get emailFrom() { return env("DECANET_EMAIL_FROM", "DECANet by VibhavGPT <support@pansophy.com>"); },
  // Price per million tokens, used only to estimate and log each role-play's
  // cost. Set them from OpenAI's pricing page for the models in use.
  get prices() {
    const number = (name, fallback) => Number(env(name, String(fallback)));
    return {
      audioIn: number("DECANET_PRICE_AUDIO_IN", 10), audioInCached: number("DECANET_PRICE_AUDIO_IN_CACHED", 0.3),
      audioOut: number("DECANET_PRICE_AUDIO_OUT", 20), textIn: number("DECANET_PRICE_TEXT_IN", 0.6),
      textInCached: number("DECANET_PRICE_TEXT_IN_CACHED", 0.06), textOut: number("DECANET_PRICE_TEXT_OUT", 2.4),
    };
  },
};

export class DecanetError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
