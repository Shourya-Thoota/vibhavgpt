import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, MoreHorizontal, Orbit, Pencil, Plus, SquarePen, Trash2,
} from "lucide-react";
import { Field, Menu, MenuItem, MenuSeparator, Modal } from "./ui.jsx";
import "../library.css";

/* ==========================================================================
   The Chat and Study sidebar library: projects, folders, and the main list.

   A project groups chats and can carry instructions the model follows in
   every chat inside it; a folder only groups, and can sit inside a project.
   Chats filed in either leave the main list ("Recent chats" / "Study
   sessions") and live under their group. Deleting a group never deletes a
   chat: its chats go back to the main list.
   ========================================================================== */

export function relativeConversationTime(value) {
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

const openKey = (mode) => `vibhavgpt-groups-open:${mode}`;
function readOpen(mode) {
  try { return new Set(JSON.parse(localStorage.getItem(openKey(mode)) ?? "[]")); } catch { return new Set(); }
}
function writeOpen(mode, ids) {
  try { localStorage.setItem(openKey(mode), JSON.stringify([...ids])); } catch { /* storage blocked */ }
}

function ConversationRow({ conversation, active, onOpen, onRename, onMove, onDelete }) {
  return (
    <div className="conversation-item" data-active={active || undefined}>
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
        <MenuItem icon={<Pencil size={15} />} onSelect={() => onRename(conversation)}>Rename</MenuItem>
        <MenuItem icon={<FolderInput size={15} />} onSelect={() => onMove(conversation)}>Move to…</MenuItem>
        <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => onDelete(conversation)}>Delete</MenuItem>
      </Menu>
    </div>
  );
}

function GroupRow({ group, open, count, onToggle, children, menu }) {
  const Icon = group.kind === "project" ? Orbit : open ? FolderOpen : Folder;
  return (
    <div className="library-group" data-kind={group.kind} data-open={open || undefined}>
      <div className="library-group__row">
        <button type="button" className="library-group__toggle" aria-expanded={open} onClick={onToggle}>
          <ChevronRight className="library-group__caret" size={14} strokeWidth={2.2} aria-hidden="true" />
          <Icon className="library-group__icon" size={15} strokeWidth={1.9} aria-hidden="true" />
          <span className="library-group__name">{group.name}</span>
          {count > 0 && <small className="library-group__count">{count}</small>}
        </button>
        <Menu
          label={`Actions for ${group.name}`}
          align="end"
          trigger={({ ref, open: menuOpen, toggle }) => (
            <button ref={ref} type="button" className="conversation-item__actions" aria-label={`Actions for ${group.name}`} aria-expanded={menuOpen} onClick={toggle}>
              <MoreHorizontal size={17} strokeWidth={2} />
            </button>
          )}
        >
          {menu}
        </Menu>
      </div>
      {open && <div className="library-group__children">{children}</div>}
    </div>
  );
}

export default function ConversationLibrary({
  api,
  activeId,
  revision,
  onOpen,
  onNew,
  onNewInGroup,
  productMode = "chat",
  heading = "Recent chats",
  emptyLabel = "Your past chats will appear here.",
}) {
  const [conversations, setConversations] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openIds, setOpenIds] = useState(() => readOpen(productMode));
  // One dialog at a time: { type: "rename" | "move" | "group", ... }.
  const [dialog, setDialog] = useState(null);
  const [draft, setDraft] = useState({ name: "", instructions: "", target: "" });
  const [saving, setSaving] = useState(false);
  const closeDialog = useCallback(() => { setDialog(null); setSaving(false); }, []);

  useEffect(() => { setOpenIds(readOpen(productMode)); }, [productMode]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api("/api/chat/conversations"),
      // A failed group load must not hide the chats themselves.
      api(`/api/chat/groups?mode=${productMode}`).catch(() => ({ groups: [] })),
    ])
      .then(([result, groupResult]) => {
        if (cancelled) return;
        setConversations((result.conversations ?? []).filter((item) => (item.mode ?? "chat") === productMode));
        setGroups(groupResult.groups ?? []);
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision, productMode]);

  const { projects, looseFolders, foldersIn, chatsIn, unfiled } = useMemo(() => {
    const known = new Set(groups.map((group) => group.id));
    const chatsByGroup = new Map();
    const loose = [];
    for (const conversation of conversations) {
      if (conversation.groupId && known.has(conversation.groupId)) {
        if (!chatsByGroup.has(conversation.groupId)) chatsByGroup.set(conversation.groupId, []);
        chatsByGroup.get(conversation.groupId).push(conversation);
      } else {
        loose.push(conversation);
      }
    }
    return {
      projects: groups.filter((group) => group.kind === "project"),
      looseFolders: groups.filter((group) => group.kind === "folder" && !group.parentId),
      foldersIn: (projectId) => groups.filter((group) => group.parentId === projectId),
      chatsIn: (groupId) => chatsByGroup.get(groupId) ?? [],
      unfiled: loose,
    };
  }, [conversations, groups]);

  const countIn = (group) => chatsIn(group.id).length
    + (group.kind === "project" ? foldersIn(group.id).reduce((sum, folder) => sum + chatsIn(folder.id).length, 0) : 0);

  const toggle = (id) => setOpenIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    writeOpen(productMode, next);
    return next;
  });
  const reveal = (id) => setOpenIds((current) => {
    if (current.has(id)) return current;
    const next = new Set(current).add(id);
    writeOpen(productMode, next);
    return next;
  });

  /* -- Chat actions ------------------------------------------------------- */

  const startRename = (conversation) => { setDraft({ name: conversation.title ?? "", instructions: "", target: "" }); setDialog({ type: "rename", conversation }); };
  const startMove = (conversation) => { setDraft({ name: "", instructions: "", target: conversation.groupId ?? "" }); setDialog({ type: "move", conversation }); };

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

  /* -- Group actions ------------------------------------------------------ */

  const startGroup = (kind, { group = null, parentId = null } = {}) => {
    setDraft({ name: group?.name ?? "", instructions: group?.instructions ?? "", target: "" });
    setDialog({ type: "group", kind, group, parentId });
  };

  async function removeGroup(group) {
    const inside = countIn(group);
    const what = group.kind === "project" ? "project" : "folder";
    const note = inside ? ` Its ${inside === 1 ? "chat moves" : `${inside} chats move`} back to ${heading}.` : "";
    if (!window.confirm(`Delete the ${what} “${group.name}”?${note}`)) return;
    try {
      const result = await api(`/api/chat/groups/${group.id}`, { method: "DELETE" });
      const gone = new Set(result.deleted ?? [group.id]);
      setGroups((items) => items.filter((item) => !gone.has(item.id)));
      setConversations((items) => items.map((item) => (gone.has(item.groupId) ? { ...item, groupId: null } : item)));
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitDialog(event) {
    event.preventDefault();
    if (!dialog || saving) return;
    setSaving(true);
    try {
      if (dialog.type === "rename") {
        const result = await api(`/api/chat/conversations/${dialog.conversation.id}`, { method: "PATCH", body: JSON.stringify({ title: draft.name }) });
        setConversations((items) => items.map((item) => (item.id === result.conversation.id ? { ...item, ...result.conversation } : item)));
      } else if (dialog.type === "move") {
        const groupId = draft.target || null;
        const result = await api(`/api/chat/conversations/${dialog.conversation.id}`, { method: "PATCH", body: JSON.stringify({ groupId }) });
        setConversations((items) => items.map((item) => (item.id === dialog.conversation.id ? { ...item, groupId: result.conversation?.groupId ?? groupId } : item)));
        if (groupId) {
          reveal(groupId);
          const parent = groups.find((group) => group.id === groupId)?.parentId;
          if (parent) reveal(parent);
        }
      } else if (dialog.group) {
        const body = { name: draft.name, ...(dialog.kind === "project" ? { instructions: draft.instructions } : {}) };
        const result = await api(`/api/chat/groups/${dialog.group.id}`, { method: "PATCH", body: JSON.stringify(body) });
        setGroups((items) => items.map((item) => (item.id === result.group.id ? result.group : item)));
      } else {
        const body = { kind: dialog.kind, mode: productMode, name: draft.name, ...(dialog.kind === "project" ? { instructions: draft.instructions } : {}), ...(dialog.parentId ? { parentId: dialog.parentId } : {}) };
        const result = await api("/api/chat/groups", { method: "POST", body: JSON.stringify(body) });
        setGroups((items) => [...items, result.group].sort((a, b) => a.name.localeCompare(b.name)));
        if (dialog.parentId) reveal(dialog.parentId);
      }
      closeDialog();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  /* -- Render ------------------------------------------------------------- */

  const rowProps = { onOpen, onRename: startRename, onMove: startMove, onDelete: remove };
  const chatRows = (items) => items.map((conversation) => (
    <ConversationRow key={conversation.id} conversation={conversation} active={conversation.id === activeId} {...rowProps} />
  ));
  const emptyGroup = (text) => <p className="library-group__empty">{text}</p>;
  const newChatLabel = productMode === "study" ? "New study session here" : "New chat here";

  const folderNode = (folder) => (
    <GroupRow
      key={folder.id}
      group={folder}
      open={openIds.has(folder.id)}
      count={chatsIn(folder.id).length}
      onToggle={() => toggle(folder.id)}
      menu={<>
        <MenuItem icon={<SquarePen size={15} />} onSelect={() => onNewInGroup?.(folder)}>{newChatLabel}</MenuItem>
        <MenuItem icon={<Pencil size={15} />} onSelect={() => startGroup("folder", { group: folder })}>Rename folder</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => removeGroup(folder)}>Delete folder</MenuItem>
      </>}
    >
      {chatsIn(folder.id).length ? chatRows(chatsIn(folder.id)) : emptyGroup(productMode === "study" ? "No sessions yet. Use Move to… on any session." : "No chats yet. Use Move to… on any chat.")}
    </GroupRow>
  );

  const moveTargets = [
    { id: "", label: heading, depth: 0 },
    ...projects.flatMap((project) => [
      { id: project.id, label: project.name, depth: 0, kind: "project" },
      ...foldersIn(project.id).map((folder) => ({ id: folder.id, label: folder.name, depth: 1, kind: "folder" })),
    ]),
    ...looseFolders.map((folder) => ({ id: folder.id, label: folder.name, depth: 0, kind: "folder" })),
  ];

  return (
    <section className="conversation-history library" aria-label={`Projects, folders and ${heading.toLowerCase()}`}>
      <div className="conversation-history__list">
        <div className="library__section">
          <div className="library__head">
            <span>Projects</span>
            <button type="button" className="library__add" aria-label="New project" title="New project" onClick={() => startGroup("project")}>
              <Plus size={15} strokeWidth={2.2} />
            </button>
          </div>
          {projects.map((project) => (
            <GroupRow
              key={project.id}
              group={project}
              open={openIds.has(project.id)}
              count={countIn(project)}
              onToggle={() => toggle(project.id)}
              menu={<>
                <MenuItem icon={<SquarePen size={15} />} onSelect={() => onNewInGroup?.(project)}>{newChatLabel}</MenuItem>
                <MenuItem icon={<FolderPlus size={15} />} onSelect={() => startGroup("folder", { parentId: project.id })}>New folder inside</MenuItem>
                <MenuItem icon={<Pencil size={15} />} onSelect={() => startGroup("project", { group: project })}>Edit project</MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => removeGroup(project)}>Delete project</MenuItem>
              </>}
            >
              {project.instructions && <p className="library-group__note" title={project.instructions}>{project.instructions}</p>}
              {foldersIn(project.id).map(folderNode)}
              {chatRows(chatsIn(project.id))}
              {!countIn(project) && !foldersIn(project.id).length && emptyGroup("Start a chat here from the project menu.")}
            </GroupRow>
          ))}
          {!loading && !projects.length && (
            <button type="button" className="library__hint" onClick={() => startGroup("project")}>
              {productMode === "study" ? "Group related sessions and give them shared instructions." : "Group related chats and give them shared instructions."}
            </button>
          )}
        </div>

        <div className="library__section">
          <div className="library__head">
            <span>Folders</span>
            <button type="button" className="library__add" aria-label="New folder" title="New folder" onClick={() => startGroup("folder")}>
              <Plus size={15} strokeWidth={2.2} />
            </button>
          </div>
          {looseFolders.map(folderNode)}
        </div>

        <div className="library__section">
          <div className="library__head">
            <span>{heading}</span>
            {loading && <small>Loading…</small>}
          </div>
          {error && <p className="conversation-history__error">{error}</p>}
          {!loading && !unfiled.length && (
            <p className="conversation-history__empty">{conversations.length ? `Every ${productMode === "study" ? "session" : "chat"} here is in a project or folder.` : emptyLabel}</p>
          )}
          {chatRows(unfiled)}
        </div>
      </div>

      <Modal
        open={dialog?.type === "rename"}
        onClose={closeDialog}
        title="Rename chat"
        description="Choose a short title you’ll recognize later."
        onSubmit={submitDialog}
      >
        <Field label="Title">
          <input className="input" autoFocus maxLength={120} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
        </Field>
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--quiet" onClick={closeDialog}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!draft.name.trim() || saving}>Save name</button>
        </div>
      </Modal>

      <Modal
        open={dialog?.type === "move"}
        onClose={closeDialog}
        title="Move chat"
        description={dialog?.conversation?.title}
        onSubmit={submitDialog}
      >
        <div className="move-list" role="radiogroup" aria-label="Destination">
          {moveTargets.map((target) => {
            const Icon = target.kind === "project" ? Orbit : target.kind === "folder" ? Folder : null;
            return (
              <button
                key={target.id || "main"}
                type="button"
                role="radio"
                aria-checked={draft.target === target.id}
                className="move-list__option"
                style={{ "--depth": target.depth }}
                onClick={() => setDraft((current) => ({ ...current, target: target.id }))}
              >
                <span className="move-list__dot" aria-hidden="true" />
                {Icon && <Icon size={15} strokeWidth={1.9} aria-hidden="true" />}
                <span>{target.label}</span>
              </button>
            );
          })}
        </div>
        {moveTargets.length === 1 && <p className="move-list__empty">Create a project or folder from the sidebar first.</p>}
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--quiet" onClick={closeDialog}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={saving || draft.target === (dialog?.conversation?.groupId ?? "")}>Move chat</button>
        </div>
      </Modal>

      <Modal
        open={dialog?.type === "group"}
        onClose={closeDialog}
        title={dialog?.group ? (dialog.kind === "project" ? "Edit project" : "Rename folder") : dialog?.kind === "project" ? "New project" : "New folder"}
        description={dialog?.kind === "project"
          ? "Chats in a project stay together, and every one of them follows the project’s instructions."
          : dialog?.parentId ? `Inside ${groups.find((group) => group.id === dialog.parentId)?.name ?? "this project"}.` : "A place to keep related chats together."}
        onSubmit={submitDialog}
      >
        <Field label="Name">
          <input className="input" autoFocus maxLength={80} value={draft.name} placeholder={dialog?.kind === "project" ? "Thesis research" : "Drafts"} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
        </Field>
        {dialog?.kind === "project" && (
          <Field label="Instructions" hint={`Optional. ${draft.instructions.length}/2000`}>
            <textarea
              className="input library__instructions"
              rows={5}
              maxLength={2000}
              value={draft.instructions}
              placeholder="Cite sources in APA. Assume I know undergraduate biology."
              onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))}
            />
          </Field>
        )}
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--quiet" onClick={closeDialog}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!draft.name.trim() || saving}>
            {dialog?.group ? "Save changes" : dialog?.kind === "project" ? "Create project" : "Create folder"}
          </button>
        </div>
      </Modal>
    </section>
  );
}
