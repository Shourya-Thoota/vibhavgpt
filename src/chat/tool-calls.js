const TOOL_CALL_OPEN = /<\s*tool(?:[_\s-]?call)\b[^>]*>/gi;
const TOOL_CALL_CLOSE = /<\s*\/\s*tool(?:[_\s-]?call)\s*>/gi;
const STANDALONE_FUNCTION_BLOCK = /<\s*function(?:\s*=|\s+name\s*=)[^>]*>[\s\S]*?<\s*\/\s*function\s*>/gi;
const CURRENT_TIME_TERMS = /\b(?:current|today(?:'s)?|now|right\s+now)\b/i;
const TIME_QUESTION_TERMS = /\b(?:utc|date|time)\b/i;

export const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "weather",
      description: "Get current weather for a named city or location. Use this instead of web search for current weather and conditions.",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City, region, or country to check." } },
        required: ["location"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Create an image when the user clearly asks you to generate, draw, make, or create an image or picture.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "A self-contained image prompt." } },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_document",
      description: "Create a downloadable file when the user asks for one. Supported types are Word DOCX, PowerPoint PPTX, PDF, Markdown, plain text TXT, CSV, JSON, and HTML. For Google Docs, use docx (it opens in Google Docs).",
      parameters: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["docx", "pptx", "pdf", "md", "txt", "csv", "json", "html"] },
          prompt: { type: "string", description: "A self-contained description of the document content." },
        },
        required: ["format", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web for current events, recent news, live facts, prices, schedules, sports scores, or other information that may have changed after your knowledge cutoff. Do not use this for stable general knowledge or casual conversation.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A focused web-search query." } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save or update a lasting fact about the user in their VibhavGPT memory. Use it when the user asks you to remember, note, keep in mind, or update something about themselves (a preference, a detail about them, their studies, interests, work, tools or a project), or corrects something you already remember. Write the fact about the user in the third person, one fact per call. Never save passwords, secrets, payment details, or facts about you or other people.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update"], description: "create for a new fact; update to change one already in memory." },
          content: { type: "string", description: "The fact, e.g. \"User prefers metric units.\"" },
          category: { type: "string", enum: ["preferences", "profile", "academics", "interests", "recent_work", "tools", "area"], description: "Where it belongs. Use area for a named recurring project or topic." },
          area: { type: "string", description: "The project or topic name, only when category is area." },
          replaces: { type: "string", description: "For update: the remembered fact being changed, as it appears in memory." },
        },
        required: ["action", "content", "category"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "utc_time",
      description: "Get the server's current UTC date and time when the user needs the current date or time.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "find_repository",
      description: "Search for a repository in the user's connected GitHub account.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Repository search query, e.g. org/repo or keyword." } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file_contents",
      description: "Read a source file from a repository in the user's connected GitHub account.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository name, e.g. owner/repo." },
          path: { type: "string", description: "Path to file inside the repository." },
          ref: { type: "string", description: "Git branch, tag or commit hash (optional)." },
        },
        required: ["repo", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stage_commit_edit",
      description: "Stage a structured code edit or commit to a GitHub repository. Requires explicit human-in-the-loop approval before execution.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository name, e.g. owner/repo." },
          branch: { type: "string", description: "Branch name." },
          path: { type: "string", description: "File path." },
          content: { type: "string", description: "File contents to commit." },
          message: { type: "string", description: "Commit message." },
        },
        required: ["repo", "branch", "path", "content", "message"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_emails",
      description: "Search Gmail messages in the user's connected Google Workspace account.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Gmail search query." } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_email",
      description: "Read an email message from the user's connected Gmail account.",
      parameters: {
        type: "object",
        properties: { messageId: { type: "string", description: "ID of the email message." } },
        required: ["messageId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_email",
      description: "Save a DRAFT email in the user's connected Gmail account, without sending it. Use only when the user asks for a draft. If the user asks to send or mail something, use gmail_send_email instead. Requires the user's approval first.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject line." },
          body: { type: "string", description: "Email body content." },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_send_email",
      description: "Send an email from the user's connected Gmail account to one recipient. Use when the user asks to send or mail something. Write the subject and the full message yourself if the user left them to you. The user sees the exact sender, recipient, subject and text and must approve before anything is sent.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "One recipient email address." },
          subject: { type: "string", description: "Email subject line." },
          body: { type: "string", description: "The full plain-text message." },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_calendar_events",
      description: "Query calendar schedule and upcoming meetings from the user's connected Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "ISO 8601 start date-time." },
          timeMax: { type: "string", description: "ISO 8601 end date-time." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Schedule a calendar event in Google Calendar. Requires explicit human-in-the-loop approval before creation.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title." },
          startTime: { type: "string", description: "ISO 8601 start time." },
          endTime: { type: "string", description: "ISO 8601 end time." },
          description: { type: "string", description: "Optional description or meeting notes." },
        },
        required: ["title", "startTime", "endTime"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_google_doc",
      description: "Read content from a Google Doc in the user's connected Google Workspace account.",
      parameters: {
        type: "object",
        properties: { documentId: { type: "string", description: "Google Doc file or document ID." } },
        required: ["documentId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_to_google_doc",
      description: "Append notes or text to a Google Doc. Requires explicit human-in-the-loop approval before mutation.",
      parameters: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Google Doc ID." },
          text: { type: "string", description: "Text content to append." },
        },
        required: ["documentId", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_drive_search",
      description: "Search files in the user's connected Google Drive. Read-only.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "File name or search text." } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_drive_upload_file",
      description: "Create or upload a text file into the user's connected Google Drive. This prepares a confirmation card; nothing is written until the user approves. Use the actual chat text or the single attached file as content. Do not tell the user to install Python or create OAuth credentials.",
      parameters: {
        type: "object",
        properties: {
          fileName: { type: "string", description: "File name including extension, e.g. notes.txt." },
          content: { type: "string", description: "Exact text to store. Omit only when a single attachment should be used." },
          folderName: { type: "string", description: "Destination folder name. Defaults to My Drive." },
        },
        required: ["fileName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_docs_create_document",
      description: "Create a new document in Google Docs with title and substantive formatted content. Requires explicit human-in-the-loop approval before creation.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title of the new Google Doc." },
          content: { type: "string", description: "Substantive, comprehensive body content of the document." },
        },
        required: ["title", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "googleslides_get_presentation",
      description: "Read a Google Slides presentation by its id or exact name. Provide presentationId or presentationName.",
      parameters: {
        type: "object",
        properties: {
          presentationId: { type: "string", description: "Google Slides presentation id." },
          presentationName: { type: "string", description: "Exact presentation name when the id is unknown." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "googleslides_create_presentation",
      description: "Create a blank Google Slides presentation. Requires explicit human approval before anything is created.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title of the new presentation." },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "googletasks_list_task_lists",
      description: "List the connected user's Google Task lists.",
      parameters: {
        type: "object",
        properties: {
          maxResults: { type: "integer", description: "Maximum lists to return, up to 100." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "googletasks_list_tasks",
      description: "List Google Tasks across the connected user's task lists.",
      parameters: {
        type: "object",
        properties: {
          showCompleted: { type: "boolean", description: "Include completed tasks. Defaults to true." },
          max_tasks_total: { type: "integer", description: "Maximum tasks to return." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "googletasks_insert_task",
      description: "Add a task to a Google Task list. Requires explicit human approval before the task is created. Use tasklist_id '@default' for the primary list.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title." },
          notes: { type: "string", description: "Plain-text notes." },
          due: { type: "string", description: "Due date. The date portion is kept." },
          tasklist_id: { type: "string", description: "Task list id, or @default." },
        },
        required: ["title", "tasklist_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "asana_list_workspaces",
      description: "List Asana workspaces the connected account can access.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Page size from 1 to 100." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "asana_list_tasks",
      description: "List Asana tasks in one scope: a project, or the current user in a workspace.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project GID. Do not combine with assignee." },
          assignee: { type: "string", description: "Use me for the connected user. Requires workspace." },
          workspace: { type: "string", description: "Workspace GID. Required with assignee." },
          limit: { type: "integer", description: "Page size from 1 to 100." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todoist_list_projects",
      description: "List active Todoist projects for the connected account.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Projects per page." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todoist_list_tasks",
      description: "List incomplete Todoist tasks. Filters must use Todoist syntax such as today, overdue, or search: keyword.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Optional Todoist filter. Do not use completed." },
          limit: { type: "integer", description: "Tasks per page." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todoist_create_task",
      description: "Create a Todoist task. Requires explicit human approval before the task is created.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Task title." },
          description: { type: "string", description: "Optional notes." },
          project_id: { type: "string", description: "Project id. Omit to use the inbox." },
          due_string: { type: "string", description: "Natural-language due date, such as tomorrow." },
          priority: { type: "integer", description: "Priority from 1 (normal) to 4 (urgent)." },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendly_get_user",
      description: "Read the connected Calendly user. Omit uuid to read the current user.",
      parameters: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "User UUID, or me." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendly_list_events",
      description: "List scheduled Calendly events. user, organization, or group must be a full Calendly API URI from calendly_get_user.",
      parameters: {
        type: "object",
        properties: {
          user: { type: "string", description: "Full user URI, https://api.calendly.com/users/{uuid}." },
          organization: { type: "string", description: "Full organization URI." },
          min_start_time: { type: "string", description: "UTC ISO start bound." },
          max_start_time: { type: "string", description: "UTC ISO end bound." },
          status: { type: "string", description: "active or canceled." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "figma_discover",
      description: "Resolve a Figma file, team, or project from a URL or id the connected account can access.",
      parameters: {
        type: "object",
        properties: {
          figma_url: { type: "string", description: "Full Figma URL." },
          file_key: { type: "string", description: "File key when a URL is not available." },
          team_id: { type: "string", description: "Team id, to list projects." },
          project_id: { type: "string", description: "Project id, to list files." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "zoom_list_meetings",
      description: "List scheduled Zoom meetings. Use user_id me for the connected account.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "Zoom user id, email, or me." },
          type: { type: "string", description: "scheduled, live, or upcoming." },
        },
        required: ["user_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clickup_list_workspaces",
      description: "List ClickUp workspaces the connected account can access.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "youtube_get_my_channel",
      description: "Get the connected account's own YouTube channel: its name, handle, and statistics. Use this for questions like \"what is my YouTube channel called\". It cannot list videos, find the latest upload, or read analytics, so do not call it for those; say plainly that this connection cannot do that. Takes no arguments.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "youtube_list_playlists",
      description: "List playlists on the connected YouTube channel.",
      parameters: {
        type: "object",
        properties: {
          maxResults: { type: "integer", description: "Maximum playlists to return." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "youtube_search",
      description: "Search YouTube videos, channels, or playlists.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search query." },
          type: { type: "string", description: "video, channel, playlist, or a comma-separated combination." },
          maxResults: { type: "integer", description: "Results per page." },
        },
        required: ["q"],
        additionalProperties: false,
      },
    },
  },
];

function normalizedName(name) {
  const value = String(name ?? "").trim().toLowerCase();
  if (["web_search", "search_web", "search"].includes(value)) return "web_search";
  if (["utc_time", "current_time", "get_current_time"].includes(value)) return "utc_time";
  if (["generate_image", "create_image", "image_generation"].includes(value)) return "generate_image";
  if (["generate_document", "create_document", "make_document", "document_generation"].includes(value)) return "generate_document";
  if (["weather", "get_weather", "current_weather"].includes(value)) return "weather";
  if (["save_memory", "remember", "update_memory", "add_memory", "memory_write", "write_memory"].includes(value)) return "save_memory";
  if (["find_repository", "search_repositories", "github_search_repo"].includes(value)) return "find_repository";
  if (["read_file_contents", "read_github_file", "github_read_file"].includes(value)) return "read_file_contents";
  if (["stage_commit_edit", "stage_commit", "github_commit", "create_commit"].includes(value)) return "stage_commit_edit";
  if (["search_emails", "gmail_search", "search_gmail"].includes(value)) return "search_emails";
  if (["read_email", "gmail_read", "read_gmail"].includes(value)) return "read_email";
  if (["draft_email", "gmail_draft", "create_email_draft"].includes(value)) return "draft_email";
  if (["gmail_send_email", "send_email", "gmail_send", "send_gmail"].includes(value)) return "gmail_send_email";
  if (["list_calendar_events", "google_calendar_list", "calendar_events"].includes(value)) return "list_calendar_events";
  if (["create_calendar_event", "google_calendar_create", "add_calendar_event"].includes(value)) return "create_calendar_event";
  if (["read_google_doc", "gdoc_read", "read_gdoc"].includes(value)) return "read_google_doc";
  if (["append_to_google_doc", "gdoc_append", "append_gdoc"].includes(value)) return "append_to_google_doc";
  if (["google_docs_create_document", "create_google_doc", "create_gdoc", "make_google_doc"].includes(value)) return "google_docs_create_document";
  if (["google_drive_search", "search_drive", "drive_search"].includes(value)) return "google_drive_search";
  if (["google_drive_upload_file", "upload_to_drive", "drive_upload", "push_to_drive"].includes(value)) return "google_drive_upload_file";
  if (CONNECTOR_TOOL_NAMES.has(value)) return value;
  return null;
}

const CONNECTOR_TOOL_NAMES = new Set([
  "googleslides_get_presentation",
  "googleslides_create_presentation",
  "googletasks_list_task_lists",
  "googletasks_list_tasks",
  "googletasks_insert_task",
  "asana_list_workspaces",
  "asana_list_tasks",
  "todoist_list_projects",
  "todoist_list_tasks",
  "todoist_create_task",
  "calendly_get_user",
  "calendly_list_events",
  "figma_discover",
  "zoom_list_meetings",
  "clickup_list_workspaces",
  "youtube_get_my_channel",
  "youtube_list_playlists",
  "youtube_search",
]);

export function isImageGenerationRequest(message) {
  const text = String(message ?? "").trim();
  if (!text || /\b(?:how|what|where|can you explain)\b[\s\S]{0,30}\b(?:image generation|generating images)\b/i.test(text)) return false;
  return /\b(?:create|generate|make|draw|illustrate|render|produce)\b[\s\S]{0,100}\b(?:an?\s+)?(?:image|picture|illustration|photo|artwork)\b/i.test(text)
    || /\b(?:image|picture|illustration|photo|artwork)\s+of\b/i.test(text);
}

// Google Docs has no file format of its own to download; a Word .docx opens
// and converts in Google Docs, so that's what a Google Docs request gets.
export const GOOGLE_DOCS_REQUEST = /\bgoogle\s*docs?\b|\bgdocs?\b/i;

export function documentFormatFromRequest(message) {
  const text = String(message ?? "");
  if (GOOGLE_DOCS_REQUEST.test(text)) return "docx";
  if (/\b(?:word\s+(?:doc|document)|docx)\b/i.test(text)) return "docx";
  if (/\b(?:powerpoint|power\s*point|slide\s+deck|presentation|pptx)\b/i.test(text)) return "pptx";
  if (/\bpdf\b/i.test(text)) return "pdf";
  if (/\bmarkdown\b|\.md\b/i.test(text)) return "md";
  if (/\b(?:plain\s+)?text\s+file\b|\.txt\b/i.test(text)) return "txt";
  if (/\b(?:csv|comma[- ]separated)\b/i.test(text)) return "csv";
  if (/\bjson\b|\.json\b/i.test(text)) return "json";
  if (/\bhtml\b|(?:web\s*page|webpage)\s+file|\.html?\b/i.test(text)) return "html";
  return null;
}

export function isDocumentGenerationRequest(message) {
  const text = String(message ?? "").trim();
  if (!text || !documentFormatFromRequest(text)) return false;
  return /\b(?:create|make|generate|write|prepare|produce|build|put|convert|export|turn|save)\b/i.test(text)
    && !/^\s*(?:what|how|can you explain|where)\b/i.test(text);
}

function toolCallBlocks(content) {
  const blocks = [];
  TOOL_CALL_OPEN.lastIndex = 0;
  let open;
  while ((open = TOOL_CALL_OPEN.exec(content))) {
    TOOL_CALL_CLOSE.lastIndex = TOOL_CALL_OPEN.lastIndex;
    const close = TOOL_CALL_CLOSE.exec(content);
    const end = close ? TOOL_CALL_CLOSE.lastIndex : content.length;
    blocks.push(content.slice(open.index, end));
    // An unclosed marker is considered unsafe markup through the end of output.
    if (!close) break;
    TOOL_CALL_OPEN.lastIndex = end;
  }
  return blocks;
}

function functionNameFromRaw(block) {
  const candidates = [
    /(?:<\s*)?function\s*=\s*["']?([a-zA-Z0-9_.:-]+)["']?/i,
    /<\s*function\s+name\s*=\s*["']?([a-zA-Z0-9_.:-]+)["']?/i,
    /["']?(?:name|function)["']?\s*:\s*["']([a-zA-Z0-9_.:-]+)["']/i,
    /<\s*function\s*>\s*([a-zA-Z0-9_.:-]+)\s*<\s*\/\s*function\s*>/i,
  ];
  return candidates.map((pattern) => block.match(pattern)?.[1]).find(Boolean) ?? null;
}

function argumentsFromRaw(body, fallbackQuery) {
  const json = body.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json);
      // Memory fields may sit at the top level or under "arguments" (an
      // object or a JSON string), depending on the provider's raw syntax.
      let memory = parsed?.arguments ?? parsed;
      if (typeof memory === "string") { try { memory = JSON.parse(memory); } catch { memory = null; } }
      if (typeof memory?.content === "string" && memory.content.trim()) {
        return { action: memory.action === "update" ? "update" : "create", content: memory.content.trim().slice(0, 500), category: memory.category, area: memory.area, replaces: memory.replaces, query: fallbackQuery };
      }
      if (typeof parsed?.query === "string" && parsed.query.trim()) return { query: parsed.query.trim().slice(0, 500) };
      if (typeof parsed?.location === "string" && parsed.location.trim()) return { location: parsed.location.trim().slice(0, 120), query: fallbackQuery };
      if (typeof parsed?.prompt === "string" && parsed.prompt.trim()) return { prompt: parsed.prompt.trim().slice(0, 8_000), format: ["docx", "pptx", "pdf", "md", "txt", "csv", "json", "html"].includes(parsed.format) ? parsed.format : /google|gdoc/i.test(String(parsed.format ?? "")) ? "docx" : null };
    } catch {
      // Fall through to XML-style parameter parsing used by some compatible APIs.
    }
  }
  const parameter = body.match(/<\s*(?:parameter\s*=\s*(?:query|prompt)|query|prompt)\s*>\s*([\s\S]*?)\s*<\s*\/\s*(?:parameter|query|prompt)\s*>/i)?.[1];
  return { query: parameter?.trim().slice(0, 500) || fallbackQuery, location: parameter?.trim().slice(0, 120) || "", prompt: parameter?.trim().slice(0, 8_000) || fallbackQuery };
}

export function rawToolCalls(content, fallbackQuery) {
  if (typeof content !== "string") return [];
  return toolCallBlocks(content).map((block, index) => ({
    id: `raw-tool-${index}`,
    name: normalizedName(functionNameFromRaw(block)),
    originalName: functionNameFromRaw(block),
    arguments: argumentsFromRaw(block, fallbackQuery),
    raw: block,
    format: "raw",
  }));
}

export function structuredToolCalls(data, fallbackQuery) {
  return (data?.choices?.[0]?.message?.tool_calls ?? []).map((call, index) => {
    let args = {};
    try { args = JSON.parse(call.function?.arguments ?? "{}"); } catch { /* use fallback below */ }
    const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim().slice(0, 8_000) : fallbackQuery;
    return {
      id: call.id ?? `structured-tool-${index}`,
      name: normalizedName(call.function?.name),
      originalName: call.function?.name,
      arguments: { ...args, query: typeof args.query === "string" && args.query.trim() ? args.query.trim().slice(0, 500) : fallbackQuery, location: typeof args.location === "string" && args.location.trim() ? args.location.trim().slice(0, 120) : "", prompt, format: ["docx", "pptx", "pdf", "md", "txt", "csv", "json", "html"].includes(args.format) ? args.format : /google|gdoc/i.test(String(args.format ?? "")) ? "docx" : null },
      raw: call,
      format: "structured",
      ...(call.extra_content ? { extra_content: call.extra_content } : {}),
    };
  });
}

export function requestedToolCall(data, fallbackQuery) {
  const structured = structuredToolCalls(data, fallbackQuery)[0];
  if (structured) return structured;
  return rawToolCalls(data?.choices?.[0]?.message?.content, fallbackQuery)[0] ?? null;
}

export function stripRawToolCalls(content) {
  if (typeof content !== "string") return "";
  let clean = content;
  for (const block of toolCallBlocks(clean)) clean = clean.replace(block, "");
  // Defensive fallback for a provider that omits the outer tool-call marker.
  return clean.replace(STANDALONE_FUNCTION_BLOCK, "").trim();
}

export function currentUtcTimeResult() {
  return { utc: new Date().toISOString() };
}

export function needsCurrentUtcTime(message) {
  const text = String(message ?? "");
  return CURRENT_TIME_TERMS.test(text) && TIME_QUESTION_TERMS.test(text);
}
