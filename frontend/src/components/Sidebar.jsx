import { useEffect, useState } from "react";
import {
  BarChart3, Brain, ChevronDown, Code, CreditCard, FileText,
  LogOut, MessageSquare, Monitor, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus,
  Settings as SettingsIcon, Smartphone, Sun, Trash2, X,
} from "lucide-react";
import { SOURCE_REPO_URL } from "../source-repo.js";
import { Field, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, Modal } from "./ui.jsx";
import { AccountBillingMenu } from "./AccountBillingMenu.jsx";
import ConversationLibrary from "./ConversationLibrary.jsx";
import { visibleAppLinks, WINDOWS_DOWNLOAD_PATH } from "../desktop-app.js";

const YOUTUBE_CHANNEL_URL = "https://www.youtube.com/@vibhavthoota";

function relativeConversationTime(value) {
  if (!value) return "";
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// One session list, reused by every sidebar variant, scoped to a single
// productMode's own conversations — this is what keeps "Image sessions" and
// "Study sessions" from ever showing each other's (or Chat's) history.
function ConversationHistory({ api, activeId, revision, onOpen, onNew, productMode = "chat", heading = "Recent chats", emptyLabel = "Your past chats will appear here." }) {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [title, setTitle] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api("/api/chat/conversations")
      .then((result) => { if (!cancelled) setConversations((result.conversations ?? []).filter((item) => (item.mode ?? "chat") === productMode)); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision, productMode]);

  async function saveRename(event) {
    event.preventDefault();
    if (!renaming) return;
    try {
      const result = await api(`/api/chat/conversations/${renaming.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      setConversations((items) => items.map((item) => item.id === result.conversation.id ? result.conversation : item));
      setRenaming(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(conversation) {
    if (!window.confirm(`Delete “${conversation.title}”? This cannot be undone.`)) return;
    try {
      await api(`/api/chat/conversations/${conversation.id}`, { method: "DELETE" });
      setConversations((items) => items.filter((item) => item.id !== conversation.id));
      if (activeId === conversation.id) onNew();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="conversation-history" aria-label={heading}>
      <div className="conversation-history__head">
        <span>{heading}</span>
        {loading && <small>Loading…</small>}
      </div>
      {error && <p className="conversation-history__error">{error}</p>}
      {!loading && !conversations.length && <p className="conversation-history__empty">{emptyLabel}</p>}
      <div className="conversation-history__list">
        {conversations.map((conversation) => (
          <div className="conversation-item" key={conversation.id} data-active={conversation.id === activeId || undefined}>
            <button type="button" className="conversation-item__open" onClick={() => onOpen(conversation.id)}>
              <span>{conversation.title || "Untitled chat"}</span>
              <small>{relativeConversationTime(conversation.updatedAt)}</small>
            </button>
            <Menu
              label={`Actions for ${conversation.title}`}
              align="end"
              trigger={({ ref, open, toggle }) => (
                <button ref={ref} type="button" className="conversation-item__actions" aria-label={`Actions for ${conversation.title}`} aria-expanded={open} onClick={toggle}>
                  <MoreHorizontal size={17} strokeWidth={2} />
                </button>
              )}
            >
              <MenuItem icon={<Pencil size={15} />} onSelect={() => { setRenaming(conversation); setTitle(conversation.title); }}>Rename</MenuItem>
              <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => remove(conversation)}>Delete</MenuItem>
            </Menu>
          </div>
        ))}
      </div>
      <Modal
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        eyebrow="Conversation"
        title="Rename chat"
        description="Choose a short title you’ll recognize later."
        onSubmit={saveRename}
      >
        <Field label="Title">
          <input className="input" autoFocus maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--quiet" onClick={() => setRenaming(null)}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!title.trim()}>Save name</button>
        </div>
      </Modal>
    </section>
  );
}

// lucide-react 1.x dropped brand icons, so YouTube is drawn here in the same
// 24px, round-stroked style as the lucide icons beside it.
function YoutubeIcon({ size = 24, strokeWidth = 2 }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
      <path d="m10 15 5-3-5-3z" />
    </svg>
  );
}

const CHAT_LINKS = () => [
  { id: "chat", label: "Chat", icon: <MessageSquare size={17} strokeWidth={1.9} /> },
  { id: "memory", label: "Memory", icon: <Brain size={17} strokeWidth={1.9} /> },
  { id: "billing", label: "Plan", icon: <CreditCard size={17} strokeWidth={1.9} /> },
];

// The native apps' public download pages: plain links, outside the app. The
// public source code and the YouTube channel open in a new tab.
// Inside the Windows app, its own download link is left out (desktop-app.js).
const APP_LINKS = [
  { href: "/android", label: "Android", icon: <Smartphone size={17} strokeWidth={1.9} /> },
  { href: WINDOWS_DOWNLOAD_PATH, label: "Windows", icon: <Monitor size={17} strokeWidth={1.9} /> },
  { href: SOURCE_REPO_URL, label: "Source code", icon: <Code size={17} strokeWidth={1.9} />, external: true },
  { href: YOUTUBE_CHANNEL_URL, label: "YouTube", icon: <YoutubeIcon size={17} strokeWidth={1.9} />, external: true },
];

/**
 * One shell, three variants (chat/study/image) driven by `variant`. The head
 * (mode switcher + collapse/close) and the foot (plan nudge + account menu)
 * never change — only the middle section does:
 *   - chat:  "New chat" + the full nav (Chat/Memory/Plan), the Apps links
 *            (Android, Windows) + history.
 *   - study: "New study session" + history only. No main-nav links: those
 *            pages live one mode-switch away in Chat, not duplicated here.
 *   - image: history only. There's no sidebar-level "new" action distinct
 *            from the page's own always-visible "New image" button, so
 *            adding a second one here would just be a confusing duplicate.
 * Opening a past Image session hands off to the Chat thread viewer (via
 * `onOpenImageSession`, which switches productMode) since ImageWorkspace
 * itself has no per-conversation thread view — the image page's own gallery
 * stays a flat, all-sessions grid, and the sidebar is how you get back to
 * one specific conversation.
 */
export default function Sidebar({
  variant,
  api,
  user,
  appearance,
  rail,
  sidebarOpen,
  setSidebarOpen,
  setCollapsed,
  brand,
  tierKey,
  tierLabel,
  page,
  go,
  newChat,
  newChatInGroup,
  openConversation,
  onOpenImageSession,
  activeConversationId,
  historyRevision,
  onSignOut,
}) {
  const navigate = (event, page) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); go(page);
  };
  const displayName = user.name?.trim() || user.email.split("@")[0];
  const initials = displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const newLabel = variant === "study" ? "New study session" : "New chat";
  const historyProps = {
    chat: { heading: "Recent chats", emptyLabel: "Your past chats will appear here.", onOpen: openConversation },
    study: { heading: "Study sessions", emptyLabel: "Your study sessions will appear here.", onOpen: openConversation },
    image: { heading: "Image sessions", emptyLabel: "Your image sessions will appear here.", onOpen: onOpenImageSession },
  }[variant];

  return (
    <aside className="sidebar" data-open={sidebarOpen} data-variant={variant}>
      <div className="sidebar__head">
        {brand}
        <IconButton
          className="sidebar__toggle"
          label={rail ? "Expand navigation" : "Collapse navigation"}
          onClick={() => setCollapsed((value) => !value)}
        >
          {rail ? <PanelLeftOpen size={18} strokeWidth={1.9} /> : <PanelLeftClose size={18} strokeWidth={1.9} />}
        </IconButton>
        <IconButton className="sidebar__close" label="Close navigation" onClick={() => setSidebarOpen(false)}>
          <X size={18} strokeWidth={1.9} />
        </IconButton>
      </div>

      {variant !== "image" && (
        <button className="sidebar__new" type="button" onClick={newChat} title={newLabel}>
          <Plus size={17} strokeWidth={2.2} />
          {!rail && <span>{newLabel}</span>}
        </button>
      )}

      {variant === "chat" && (
        <nav className="sidebar__nav">
          {CHAT_LINKS().map((link) => (
            <a
              key={link.id}
              href={link.id === "chat" ? "/app/chat" : `/app/${link.id}`}
              className="sidebar__link"
              data-active={page === link.id || undefined}
              title={rail ? link.label : undefined}
              aria-current={page === link.id ? "page" : undefined}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault(); go(link.id);
              }}
            >
              {link.icon}
              {!rail && <span>{link.label}</span>}
            </a>
          ))}
        </nav>
      )}

      {variant === "chat" && (
        <nav className="sidebar__nav sidebar__apps" aria-label="Apps">
          {!rail && <span className="sidebar__apps-label">Apps</span>}
          {visibleAppLinks(APP_LINKS).map((link) => (
            <a key={link.href} href={link.href} className="sidebar__link" title={rail ? link.label : undefined}
              {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {link.icon}
              {!rail && <span>{link.label}</span>}
            </a>
          ))}
        </nav>
      )}

      {!rail && variant !== "image" && (
        <ConversationLibrary
          api={api}
          productMode={variant}
          activeId={activeConversationId}
          revision={historyRevision}
          onNew={newChat}
          onNewInGroup={newChatInGroup}
          {...historyProps}
        />
      )}
      {!rail && variant === "image" && (
        <ConversationHistory
          api={api}
          productMode={variant}
          activeId={activeConversationId}
          revision={historyRevision}
          onNew={newChat}
          {...historyProps}
        />
      )}

      <div className="sidebar__foot">
        {!rail && tierKey === "free" && (
          <div className="plan-nudge">
            <strong>You're on Free</strong>
            <small>Get higher token allowances and included image and document generations.</small>
            <button type="button" className="btn btn--secondary" onClick={() => go("billing")} style={{ minHeight: 34, fontSize: "0.83rem" }}>
              See plans
            </button>
          </div>
        )}
        <Menu
          label="Account"
          placement="top"
          align="start"
          panelClassName="account-menu"
          trigger={({ ref, open, toggle }) => (
            <button ref={ref} type="button" className="account" aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
              <span className="avatar" aria-hidden="true">{initials || "V"}</span>
              {!rail && (
                <>
                  <span className="account__copy">
                    <strong>{displayName}</strong>
                    <small>{tierLabel} plan</small>
                  </span>
                  <ChevronDown className="account__caret" size={15} strokeWidth={2} />
                </>
              )}
            </button>
          )}
        >
          <MenuLabel>{user.email}</MenuLabel>
          <MenuItem icon={<SettingsIcon size={16} />} href="/app/settings/account" target="_self" onSelect={(event) => navigate(event, "settings")}>Settings</MenuItem>
          <MenuItem icon={<BarChart3 size={16} />} href="/app/usage" target="_self" onSelect={(event) => navigate(event, "usage")}>Usage & limits</MenuItem>
          <MenuItem icon={<CreditCard size={16} />} href="/app/billing" target="_self" onSelect={(event) => navigate(event, "billing")}>Plan and billing</MenuItem>
          <AccountBillingMenu api={api} userId={user.id} />
          <MenuSeparator />
          <MenuItem
            icon={appearance.resolved === "light" ? <Moon size={16} /> : <Sun size={16} />}
            onSelect={() => appearance.setThemeId(appearance.resolved === "light" ? "dark" : "light")}
          >
            {appearance.resolved === "light" ? "Switch to Deep Space" : "Switch to Daybreak"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<LogOut size={16} />} tone="danger" onSelect={onSignOut}>Sign out</MenuItem>
        </Menu>
      </div>
    </aside>
  );
}
