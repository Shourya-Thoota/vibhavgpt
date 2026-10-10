function taskLabel(query) {
  const text = String(query ?? "").trim();
  if (/\b(compare|comparison|versus|\bvs\.?\b|difference between|which is better)\b/i.test(text)) return "Compared the options";
  if (/\b(geometry|triangle|polygon|angle|radius|diameter|circumference|coordinate plane)\b/i.test(text)) return "Reviewed your geometry problem";
  if (/\b(calculate|compute|work out|solve|equation|percent(?:age)?|area of|perimeter|sum|multiply|divide)\b|[0-9]\s*[+*/=×÷-]\s*[0-9]/i.test(text)) return "Worked through the calculation";
  if (/\b(code|program|javascript|typescript|python|sql|debug|error message|stack trace)\b/i.test(text)) return "Reviewed your coding question";
  if (/\bvibhavgpt\b/i.test(text)) return "Answered a VibhavGPT question";
  if (/\b(summarize|summary|key points|main ideas)\b/i.test(text)) return "Summarized the information you provided";
  if (/\b(draft|write|rewrite|edit|compose|wording)\b/i.test(text)) return "Prepared a draft for your request";
  if (/\b(explain|what is|what are|how does|how do|why does|why is)\b/i.test(text)) return "Explained the topic you asked about";
  return "Analyzed your question";
}

/** Build concise disclosure labels from observed execution facts only. */
export function buildActivitySummary({ query = "", actions = {} } = {}) {
  const steps = [];
  if (actions.productContext) steps.push("Reviewed VibhavGPT product information");
  if (actions.memory) steps.push("Reviewed saved memory");
  if (actions.memorySaved) steps.push("Saved to memory");
  if (actions.history) steps.push("Reviewed previous conversation context");
  if (actions.attachedDocuments) steps.push("Reviewed attached documents");
  if (actions.attachedImages) steps.push("Reviewed the attached image");
  if (actions.savedDocuments) steps.push("Reviewed saved conversation documents");
  if (actions.webSearch) steps.push("Searched the web");
  if (actions.currentSources) steps.push("Reviewed current sources");
  if (actions.weather) steps.push("Checked the requested weather information");
  if (actions.currentTime) steps.push("Checked the current date and time");
  if (actions.imageGenerated) steps.push("Created the requested image");
  if (actions.documentGenerated) steps.push("Created the requested document");
  if (actions.codeExecuted) steps.push("Ran the requested calculation");

  if (steps.length) {
    if (!actions.imageGenerated && !actions.documentGenerated) steps.push("Prepared response");
    return [...new Set(steps)];
  }
  return [taskLabel(query)];
}
