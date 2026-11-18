import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { db } from "../db/client.js";
import { requireSession } from "../middleware/require-session.js";
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH, normalizeSearchQuery, searchChats } from "./search.js";

// POST /api/chat/search  { q, limit? }  ->  { results: [...] }
//
// A POST, so what someone searches for is in the request body and never in a URL (URLs are what access logs, proxies, browser
// history and error reports keep). The route logs nothing about the search: no text, no result count; a failure is recorded by
// its error code alone. The account is the verified session's; nothing in the body can name another.

export function createChatSearchRouter({ database = db, session = requireSession, perMinute = 90 } = {}) {
  const router = Router();
  router.use(session);
  router.use(express.json({ limit: "4kb" }));
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: perMinute,
    keyGenerator: (req) => `chat-search:${req.authSession.user.id}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "You are searching very quickly. Please wait a moment.", code: "rate_limited" },
  });

  router.post("/", limiter, async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", Vary: "Cookie" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (typeof body.q !== "string") return res.status(400).json({ error: "Send the text to search for as q.", code: "bad_request" });
    const query = normalizeSearchQuery(body.q);
    // Too short to search is not an error: it simply finds nothing yet.
    if (query.length < SEARCH_MIN_LENGTH) return res.status(200).json({ results: [] });
    if (body.q.trim().length > SEARCH_MAX_LENGTH * 2) return res.status(400).json({ error: "That search is too long.", code: "too_long" });
    try {
      const results = await searchChats({ userId: req.authSession.user.id, query, limit: Number(body.limit) || undefined, scope: body.scope === "build" ? "build" : "chat" }, database);
      return res.status(200).json({ results });
    } catch (error) {
      // 57014: the database stopped a search that was taking too long (see STATEMENT_TIMEOUT).
      const code = error?.code ?? error?.cause?.code ?? "unknown";
      console.error(JSON.stringify({ event: "chat_search_failed", code }));
      if (code === "57014") return res.status(503).json({ error: "That search is too broad. Try a more specific word.", code: "too_broad" });
      return res.status(500).json({ error: "Search is not available right now. Try again in a moment.", code: "unavailable" });
    }
  });

  return router;
}
