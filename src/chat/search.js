import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

// Search across one person's own chats and study sessions: their titles and the text of their messages.
//
// - It runs in PostgreSQL, on two full-text indexes (drizzle/0038): messages are stored as plain text, so the database can search
//   them directly, and the search text goes nowhere else: no other service, no log, no URL (the route takes a POST body).
// - Every query is scoped to the signed-in person's id, in the SQL itself, before anything is matched.
// - The text is turned into a query by websearch_to_tsquery, which accepts any characters (quotes, operators, punctuation, emoji)
//   without error; it is always passed as a parameter, never joined into the SQL.
// - Results are the title matches first, then the chats whose most recent matching message is newest. (Ranking by relevance
//   would mean recomputing a text vector for every match of a common word; recency is cheap and is what people expect here.)
// - A snippet comes back as plain segments, [{ text, match }], never as HTML, so a highlight is never a way to inject markup.

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 200;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 30;
// A search that cannot finish quickly (a very common word across a very long history) is stopped rather than left to load the database.
const STATEMENT_TIMEOUT = "4000ms";
const MODES = ["chat", "study"];
// "Search builds" looks only at Build conversations; the ordinary search (Chat and Study) never includes them.
const BUILD_MODES = ["build"];
const MARK_START = "\u0001";
const MARK_END = "\u0002";

export function normalizeSearchQuery(value) {
  if (typeof value !== "string") return "";
  // Control characters have no place in a search and two of them are this module's highlight markers.
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH);
}

// % and _ and \ mean something to LIKE; here they are just characters the person typed.
const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

// "a \u0001b\u0002 c" becomes [{ text: "a ", match: false }, { text: "b", match: true }, { text: " c", match: false }].
export function highlightSegments(text) {
  const segments = [];
  let match = false;
  for (const part of String(text ?? "").split(/([\u0001\u0002])/)) {
    if (part === MARK_START) { match = true; continue; }
    if (part === MARK_END) { match = false; continue; }
    if (part) segments.push({ text: part, match });
  }
  return segments;
}

const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

export async function searchChats({ userId, query, limit = SEARCH_DEFAULT_LIMIT, scope = "chat" }, database = db) {
  const scopeModes = scope === "build" ? BUILD_MODES : MODES;
  const text = normalizeSearchQuery(query);
  if (typeof userId !== "string" || !userId || text.length < SEARCH_MIN_LENGTH) return [];
  const cap = Math.min(Math.max(Math.trunc(Number(limit)) || SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
  const like = `%${escapeLike(text)}%`;
  const modes = sql.join(scopeModes.map((mode) => sql`${mode}`), sql`, `);
  const result = await database.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
    return tx.execute(sql`
      WITH message_hits AS (
        SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.created_at AS message_at, m.content
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.user_id = ${userId}
          AND c.mode IN (${modes})
          AND c.temporary = false
          AND to_tsvector('english', m.content) @@ websearch_to_tsquery('english', ${text})
        ORDER BY m.conversation_id, m.created_at DESC
      ),
      matched AS (
        SELECT c.id, c.title, c.mode, c.updated_at, h.message_at, h.content,
               (to_tsvector('english', c.title) @@ websearch_to_tsquery('english', ${text}) OR c.title ILIKE ${like} ESCAPE '\\') AS title_match
        FROM conversations c
        LEFT JOIN message_hits h ON h.conversation_id = c.id
        WHERE c.user_id = ${userId}
          AND c.mode IN (${modes})
          -- Temporary chats are never listed, so they are never found by search either.
          AND c.temporary = false
          AND (h.conversation_id IS NOT NULL
               OR to_tsvector('english', c.title) @@ websearch_to_tsquery('english', ${text})
               OR c.title ILIKE ${like} ESCAPE '\\')
        ORDER BY (to_tsvector('english', c.title) @@ websearch_to_tsquery('english', ${text}) OR c.title ILIKE ${like} ESCAPE '\\') DESC,
                 COALESCE(h.message_at, c.updated_at) DESC
        LIMIT ${cap}
      )
      SELECT id, title, mode, updated_at, message_at, title_match,
             ts_headline('english', title, websearch_to_tsquery('english', ${text}),
               'StartSel=' || chr(1) || ', StopSel=' || chr(2) || ', HighlightAll=true') AS title_marked,
             CASE WHEN content IS NULL THEN NULL
                  ELSE ts_headline('english', translate(content, chr(1) || chr(2), '  '), websearch_to_tsquery('english', ${text}),
                    'StartSel=' || chr(1) || ', StopSel=' || chr(2) || ', MaxWords=22, MinWords=8, ShortWord=2, MaxFragments=1')
             END AS snippet_marked
      FROM matched
      ORDER BY title_match DESC, COALESCE(message_at, updated_at) DESC
    `);
  });
  const rows = result.rows ?? result;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    titleSegments: highlightSegments(row.title_marked),
    mode: row.mode,
    // The date shown is the matching message's, or the chat's own last activity for a title match.
    date: new Date(row.message_at ?? row.updated_at).toISOString(),
    snippet: row.snippet_marked ? highlightSegments(squash(row.snippet_marked)) : null,
  }));
}
