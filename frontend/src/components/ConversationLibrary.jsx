import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Briefcase, ChevronRight, FolderInput, GraduationCap, MoreHorizontal, Pencil, Plus, SquarePen, Trash2,
} from "lucide-react";
import { Field, Menu, MenuItem, MenuSeparator, Modal } from "./ui.jsx";
import "../library.css";

/* ==========================================================================
   The Chat and Study sidebar library: projects and the main list.

   A project groups conversations and can carry instructions the model
   follows in every conversation inside it. Learning projects default new
   conversations to Study; Work projects default new conversations to Chat.
   Conversations filed in a project leave the main list ("Recent chats" /
   "Study sessions") and live under their project. Deleting a project never
   deletes a conversation: its conversations go back to the main list.
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

const openKey = () => "vibhavgpt-projects-open";
function readOpen() {
  try {
    const raw = localStorage.getItem(openKey()) ?? localStorage.getItem("vibhavgpt-notebooks-open");
    return new Set(JSON.parse(raw ?? "[]"));
  } catch {
    return new Set();
  }
}
function writeOpen(ids) {
  try {
    localStorage.setItem(openKey(), JSON.stringify([...ids]));
    localStorage.setItem("vibhavgpt-notebooks-open", JSON.stringify([...ids]));
  } catch { /* storage blocked */ }
}

function ConversationRow({ conversation, active, onOpen, onRename, onMove, onDelete }) {
  const name = conversation.title || "Untitled chat";
  return (
    <div className="conversation-item" data-active={active || undefined}>
      <button type="button" className="conversation-item__open" title={name} aria-current={active ? "page" : undefined} onClick={() => onOpen(conversation.id)}>
        <span>{name}</span>
        <small>{relativeConversationTime(conversation.updatedAt)}</small>
      </button>
      <Menu
        label={`Options for ${name}`}
        align="end"
        trigger={({ ref, open, toggle }) => (
          <button ref={ref} type="button" className="conversation-item__actions" aria-label={`Options for ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
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

function ProjectRow({ project, open, count, onToggle, children, menu }) {
  const Icon = project.mode === "study" ? GraduationCap : Briefcase;
  return (
    <div className="library-group" data-kind="project" data-mode={project.mode} data-open={open || undefined}>
      <div className="library-group__row">
        <button type="button" className="library-group__toggle" aria-expanded={open} onClick={onToggle}>
          <ChevronRight className="library-group__caret" size={14} strokeWidth={2.2} aria-hidden="true" />
          <Icon className="library-group__icon" size={15} strokeWidth={1.9} aria-hidden="true" />
          <span className="library-group__name">{project.name}</span>
          <small className="library-group__type-badge" data-mode={project.mode}>
            {project.mode === "study" ? "Learning" : "Work"}
          </small>
          {count > 0 && <small className="library-group__count">{count}</small>}
        </button>
        <Menu
          label={`Actions for ${project.name}`}
          align="end"
          trigger={({ ref, open: menuOpen, toggle }) => (
            <button ref={ref} type="button" className="conversation-item__actions" aria-label={`Actions for ${project.name}`} aria-expanded={menuOpen} onClick={toggle}>
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
  heading = "Your chats",
  showProjects = true,
  emptyLabel = "Your past chats will appear here.",
}) {
  const [conversations, setConversations] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openIds, setOpenIds] = useState(() => readOpen());
  // One dialog at a time: { type: "rename" | "move" | "notebook", ... }.
  const [dialog, setDialog] = useState(null);
  const [draft, setDraft] = useState({ name: "", instructions: "", mode: "chat", target: "", memoryUse: true, memorySave: true });
  const [saving, setSaving] = useState(false);
  const closeDialog = useCallback(() => { setDialog(null); setSaving(false); }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api("/api/chat/conversations"),
      // Shared notebooks list across Chat and Study: load all notebooks
      api("/api/chat/groups").catch(() => ({ groups: [] })),
    ])
      .then(([result, groupResult]) => {
        if (cancelled) return;
        setConversations(result.conversations ?? []);
        setGroups(groupResult.groups ?? []);
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision]);

  const { projects, chatsIn, unfiled } = useMemo(() => {
    // Shared projects across both modes (groups with kind === "project")
    const projectList = groups.filter((group) => group.kind === "project");
    const projectMap = new Map(projectList.map((p) => [p.id, p]));

    // Map any legacy folder to its parent project id (if any) to flatten it
    const folderParentMap = new Map();
    for (const group of groups) {
      if (group.kind === "folder" && group.parentId && projectMap.has(group.parentId)) {
        folderParentMap.set(group.id, group.parentId);
      }
    }

    const chatsByProject = new Map();
    const loose = [];

    for (const conversation of conversations) {
      let targetProjectId = null;
      if (conversation.groupId) {
        if (projectMap.has(conversation.groupId)) {
          targetProjectId = conversation.groupId;
        } else if (folderParentMap.has(conversation.groupId)) {
          // Flatten folder-contained conversation into its owning project
          targetProjectId = folderParentMap.get(conversation.groupId);
        }
      }

      if (targetProjectId) {
        if (!chatsByProject.has(targetProjectId)) chatsByProject.set(targetProjectId, []);
        chatsByProject.get(targetProjectId).push(conversation);
      } else {
        // Items without a project remain accessible in the appropriate global list
        if ((conversation.mode ?? "chat") === productMode) {
          loose.push(conversation);
        }
      }
    }

    return {
      projects: projectList,
      chatsIn: (projectId) => chatsByProject.get(projectId) ?? [],
      unfiled: loose,
    };
  }, [conversations, groups, productMode]);

  const countIn = (project) => chatsIn(project.id).length;

  const toggle = (id) => setOpenIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    writeOpen(next);
    return next;
  });
  const reveal = (id) => setOpenIds((current) => {
    if (current.has(id)) return current;
    const next = new Set(current).add(id);
    writeOpen(next);
    return next;
  });

  /* -- Chat actions ------------------------------------------------------- */

  const startRename = (conversation) => {
    setDraft({ name: conversation.title ?? "", instructions: "", mode: "chat", target: "" });
    setDialog({ type: "rename", conversation });
  };
  const startMove = (conversation) => {
    setDraft({ name: "", instructions: "", mode: "chat", target: conversation.groupId ?? "" });
    setDialog({ type: "move", conversation });
  };

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

  /* -- Project actions ---------------------------------------------------- */

  const startProject = ({ group = null, kind = "project" } = {}) => {
    setDraft({
      name: group?.name ?? "",
      instructions: group?.instructions ?? "",
      memoryUse: group?.memoryUseEnabled !== false,
      memorySave: group?.memorySaveEnabled !== false,
      mode: group?.mode ?? (productMode === "study" ? "study" : "chat"),
      target: "",
    });
    setDialog({ type: "project", kind, group });
  };

  async function removeProject(project) {
    const inside = countIn(project);
    const note = inside ? ` Its ${inside === 1 ? "conversation moves" : `${inside} conversations move`} back to the main list.` : "";
    if (!window.confirm(`Delete the project “${project.name}”?${note}`)) return;
    try {
      const result = await api(`/api/chat/groups/${project.id}`, { method: "DELETE" });
      const gone = new Set(result.deleted ?? [project.id]);
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
        if (groupId) reveal(groupId);
      } else if (dialog.group) {
        const body = { name: draft.name, instructions: draft.instructions, ...(dialog.group.kind === "project" ? { memoryUseEnabled: draft.memoryUse !== false, memorySaveEnabled: draft.memorySave !== false } : {}) };
        const result = await api(`/api/chat/groups/${dialog.group.id}`, { method: "PATCH", body: JSON.stringify(body) });
        setGroups((items) => items.map((item) => (item.id === result.group.id ? result.group : item)));
      } else {
        const body = { kind: "project", mode: draft.mode, notebookType: draft.mode === "study" ? "learning" : "work", name: draft.name, instructions: draft.instructions };
        const result = await api("/api/chat/groups", { method: "POST", body: JSON.stringify(body) });
        setGroups((items) => [...items, result.group].sort((a, b) => a.name.localeCompare(b.name)));
        reveal(result.group.id);
        onNewInGroup?.(result.group);
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

  const moveTargets = [
    { id: "", label: heading, depth: 0, kind: "unfiled" },
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      mode: project.mode,
      depth: 0,
      kind: "project",
    })),
  ];

  return (
    <section className="conversation-history library" aria-label={`Projects and ${heading.toLowerCase()}`}>
      <div className="conversation-history__list" data-projects={showProjects ? undefined : "hidden"}>
        {showProjects && <div className="library__section" data-section="projects">
          <div className="library__head">
            <span>Projects</span>
          </div>
          <button type="button" className="library__new" onClick={() => startProject()}>
            <Plus size={20} strokeWidth={1.6} aria-hidden="true" />
            <span>New project</span>
          </button>
          {projects.map((project) => {
            const newLabel = project.mode === "study" ? "New study session here" : "New chat here";
            return (
              <ProjectRow
                key={project.id}
                project={project}
                open={openIds.has(project.id)}
                count={countIn(project)}
                onToggle={() => toggle(project.id)}
                menu={<>
                  <MenuItem icon={<SquarePen size={15} />} onSelect={() => onNewInGroup?.(project)}>{newLabel}</MenuItem>
                  <MenuItem icon={<Pencil size={15} />} onSelect={() => startProject({ group: project })}>Edit project</MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => removeProject(project)}>Delete project</MenuItem>
                </>}
              >
                {project.instructions && <p className="library-group__note" title={project.instructions}>{project.instructions}</p>}
                {chatRows(chatsIn(project.id))}
                {!countIn(project) && emptyGroup(project.mode === "study" ? "Start a study session here from the project menu." : "Start a chat here from the project menu.")}
              </ProjectRow>
            );
          })}
          {!loading && !projects.length && (
            <button type="button" className="library__hint" onClick={() => startProject()}>
              Group related chats and give them shared instructions.
            </button>
          )}
        </div>}

        {/* The heading sits above the list, never inside it: only the rows scroll, so no row can pass under or through it. */}
        <div className="library__section" data-section="recent">
          <div className="library__head">
            <span>{heading}</span>
            {loading && <small>Loading…</small>}
          </div>
          <div className="library__rows" data-scroll="history">
            {error && <p className="conversation-history__error">{error}</p>}
            {!loading && !unfiled.length && (
              <p className="conversation-history__empty">{conversations.length ? `Every ${productMode === "study" ? "session" : "chat"} here is in a project.` : emptyLabel}</p>
            )}
            {chatRows(unfiled)}
          </div>
        </div>
      </div>

      <Modal
        open={dialog?.type === "rename"}
        onClose={closeDialog}
        title="Rename conversation"
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
        title="Move conversation"
        description={dialog?.conversation?.title}
        onSubmit={submitDialog}
      >
        <div className="move-list" role="radiogroup" aria-label="Destination">
          {moveTargets.map((target) => {
            const Icon = target.id ? (target.mode === "study" ? GraduationCap : Briefcase) : null;
            return (
              <button
                key={target.id || "main"}
                type="button"
                role="radio"
                aria-checked={draft.target === target.id}
                className="move-list__option"
                onClick={() => setDraft((current) => ({ ...current, target: target.id }))}
              >
                <span className="move-list__dot" aria-hidden="true" />
                {Icon && <Icon size={15} strokeWidth={1.9} aria-hidden="true" />}
                <span>{target.label}</span>
                {target.id && <small className={`move-list__badge ${target.mode === "study" ? "move-list__badge--study" : ""}`}>{target.mode === "study" ? "Learning" : "Work"}</small>}
              </button>
            );
          })}
        </div>
        {moveTargets.length === 1 && <p className="move-list__empty">Create a project from the sidebar first.</p>}
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--quiet" onClick={closeDialog}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={saving || draft.target === (dialog?.conversation?.groupId ?? "")}>Move conversation</button>
        </div>
      </Modal>

      <Modal
        open={dialog?.type === "notebook" || dialog?.type === "project"}
        onClose={closeDialog}
        title={dialog?.group ? "Edit project" : "New project"}
        description={dialog?.group ? "Update this project’s name and instructions." : "Keep related chats together with shared instructions."}
        onSubmit={submitDialog}
        size="lg"
      >
        {!dialog?.group && (
          <div
            className="notebook-type-picker project-type-picker"
            role="radiogroup"
            aria-label="Project type"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              const next = draft.mode === "study" ? "chat" : "study";
              setDraft((c) => ({ ...c, mode: next }));
              requestAnimationFrame(() => event.currentTarget?.querySelector('[aria-checked="true"]')?.focus());
            }}
          >
            <button
              type="button"
              role="radio"
              aria-checked={draft.mode === "study"}
              tabIndex={draft.mode === "study" ? 0 : -1}
              className={`notebook-type-card project-type-card ${draft.mode === "study" ? "notebook-type-card--selected project-type-card--selected" : ""}`}
              onClick={() => setDraft((c) => ({ ...c, mode: "study" }))}
            >
              <div className="notebook-type-card__head project-type-card__head">
                <GraduationCap size={18} aria-hidden="true" />
                <strong>Learning project</strong>
              </div>
              <small>For studying, explanations, and practice.</small>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={draft.mode === "chat"}
              tabIndex={draft.mode === "chat" ? 0 : -1}
              className={`notebook-type-card project-type-card ${draft.mode === "chat" ? "notebook-type-card--selected project-type-card--selected" : ""}`}
              onClick={() => setDraft((c) => ({ ...c, mode: "chat" }))}
            >
              <div className="notebook-type-card__head project-type-card__head">
                <Briefcase size={18} aria-hidden="true" />
                <strong>Work project</strong>
              </div>
              <small>For projects, research, and everyday tasks.</small>
            </button>
          </div>
        )}

        <Field label="Project name">
          <input className="input" autoFocus maxLength={80} value={draft.name} placeholder={draft.mode === "study" ? "e.g. Cell Biology" : "e.g. Work research"} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
        </Field>

        <Field
          label="Instructions"
          aside={<span className="library__count" aria-live="off">{draft.instructions.length}/2000</span>}
          hint="Optional. Shown to the assistant in every conversation in this project."
        >
          <textarea
            className="textarea library__instructions"
            rows={4}
            maxLength={2000}
            value={draft.instructions}
            placeholder="Cite sources in APA style, and provide clear summaries."
            onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))}
          />
        </Field>

        {dialog?.group?.kind === "project" && (
          <fieldset className="library__memory">
            <legend>Project memory</legend>
            <p className="library__memory-note">Memories saved in this project's chats are used only here. Your Settings still decide whether memory is used or saved at all.</p>
            <label className="library__memory-row">
              <input type="checkbox" checked={draft.memoryUse !== false} onChange={(event) => setDraft((current) => ({ ...current, memoryUse: event.target.checked }))} />
              <span>Use this project's memories in its chats</span>
            </label>
            <label className="library__memory-row">
              <input type="checkbox" checked={draft.memorySave !== false} onChange={(event) => setDraft((current) => ({ ...current, memorySave: event.target.checked }))} />
              <span>Save new memories to this project</span>
            </label>
          </fieldset>
        )}

        <div className="ui-modal__actions">
          <button type="button" className="btn btn--quiet" onClick={closeDialog}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!draft.name.trim() || saving}>
            {dialog?.group ? "Save changes" : "Create project"}
          </button>
        </div>
      </Modal>
    </section>
  );
}
