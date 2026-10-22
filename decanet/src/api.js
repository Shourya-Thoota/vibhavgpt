// DECANet talks to the VibhavGPT API. Its session cookie lives on the API host
// and is sent because both sites are under vibhavgpt.com.
export const API_BASE = import.meta.env.VITE_API_URL
  ?? (["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:3001" : "https://api.vibhavgpt.com");

export const VIBHAVGPT_URL = import.meta.env.VITE_VIBHAVGPT_URL ?? "https://vibhavgpt.com";

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = "GET", body, keepalive } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}/api/decanet${path}`, {
      method,
      credentials: "include",
      keepalive,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Couldn't reach DECANet. Check your connection and try again.", 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error ?? "Something went wrong. Please try again.", response.status, data.code);
  return data;
}

export const formatMoney = (cents) => `$${(cents / 100).toFixed(2)}`;

export function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

export function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function chapterUnitCents(quantity, tiers) {
  return tiers.find((tier) => quantity >= tier.min)?.centsPerCredit ?? tiers.at(-1).centsPerCredit;
}
