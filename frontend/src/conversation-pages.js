// Earlier pages of a long conversation, loaded on request ("Load earlier
// messages"). The server pages by message id (GET .../conversations/:id
// ?before=<id>); these helpers put a page in place without repeats and keep
// the reader where they were.

// An older page goes in front of what is already shown. Anything already
// shown (by id) is left where it is, so a repeat can never appear twice.
export function mergeOlderPage(current = [], page = []) {
  const shown = new Set(current.map((message) => message?.id).filter(Boolean));
  const older = page.filter((message) => !message?.id || !shown.has(message.id));
  return [...older, ...current];
}

// A message's React key: its saved id, or the key it was given when it was
// added on this screen. Never its position, which moves when a page is added.
export function messageKey(message) {
  return message?.id ?? message?.clientKey;
}

// Where to scroll after a page is added above: the same distance from the
// bottom as before, so the message the reader was looking at stays put.
export function restoredScrollTop({ beforeHeight, beforeTop, afterHeight }) {
  return afterHeight - beforeHeight + beforeTop;
}
