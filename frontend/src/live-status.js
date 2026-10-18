// What a reply in progress says it is doing. Every label names a stage the
// app actually reached; none is shown on a timer of its own.
export function liveStatusLabel({ phase, attempt, maxAttempts, seconds = 0 } = {}) {
  if (phase === "attachments") return "Processing attachments...";
  if (phase === "searching") return "Searching the web...";
  if (phase === "retrying") {
    return Number.isInteger(attempt) && Number.isInteger(maxAttempts)
      ? `Provider was slow, trying again (attempt ${attempt} of ${maxAttempts})`
      : "Provider was slow, trying again";
  }
  if (phase === "weather") return "Checking the weather...";
  if (phase === "calculating") return "Calculating...";
  if (phase === "writing") return "Writing your document...";
  if (phase === "saving") return "Almost done";
  return `Thinking... (${Math.max(0, Math.floor(seconds))} s)`;
}

export const thoughtLabel = (seconds) => `Thought for ${Math.max(0, Math.round(seconds))} s`;

// Whole seconds between two times, for the "Thought for" tag.
export const elapsedSeconds = (from, to = Date.now()) => Math.max(0, Math.round((to - from) / 1000));
