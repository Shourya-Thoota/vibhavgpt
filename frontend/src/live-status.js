// What a reply in progress says it is doing. Every label names a stage the
// app actually reached; none is shown on a timer of its own.
export function liveStatusLabel({ phase, attempt, maxAttempts, service, tier, seconds = 0 } = {}) {
  // Connector steps: sent by the server only after the step ran (done) or
  // returned an error or notice (failed). Without a service name there is no
  // supported claim to make, so it falls through to the generic label.
  if (service && phase === "connector_reading") return `Reading from ${service}...`;
  if (service && phase === "connector_done") return `Got a response from ${service}. Writing the reply...`;
  if (service && phase === "connector_failed") return `Could not read from ${service}. Writing the reply...`;
  if (phase === "attachments") return "Processing attachments...";
  if (phase === "searching") return "Searching the web...";
  if (phase === "retrying") {
    return Number.isInteger(attempt) && Number.isInteger(maxAttempts)
      ? `Provider was slow, trying again (attempt ${attempt} of ${maxAttempts})`
      : "Provider was slow, trying again";
  }
  // Every slot on this tier is taken: the reply is waiting its turn (the server says so, and for how long it has waited).
  if (phase === "queued") return `${tier || "This model"} is in high demand. Waiting for a free slot... (${Math.max(0, Math.floor(seconds))} s)`;
  // The host refused for load, and the reply is trying once more after the wait it asked for.
  if (phase === "busy") {
    return Number.isInteger(attempt) && Number.isInteger(maxAttempts)
      ? `High demand, trying again (attempt ${attempt} of ${maxAttempts})`
      : "High demand, trying again";
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
