import { useEffect, useRef, useState } from "react";
import { BookOpen, FileText, Plus, ArrowUpRight, PenLine } from "lucide-react";
import { Modal, Select } from "./ui.jsx";
import { STUDY_ACTIONS } from "../product-modes.js";
import StudyWritingTools from "./StudyWritingTools.jsx";

export default function StudyWorkspace({ api, apiBase, conversationId, model, onSession, renderChat }) {
  const [session, setSession] = useState(conversationId);
  const [materials, setMaterials] = useState([]);
  const [selected, setSelected] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [action, setAction] = useState(null);
  // "chat" or "writing" (VibhavGPT Writing Tools in place of the conversation).
  const [view, setView] = useState("chat");
  const input = useRef(null);
  const pendingSession = useRef(null);
  const active = materials.find((item) => item.id === selected) ?? materials[0];
  async function ensureSession() {
    if (session) return session;
    if (!pendingSession.current) pendingSession.current = api("/api/chat/study", { method: "POST", body: JSON.stringify({ model }) })
      .then(({ conversation }) => { setSession(conversation.id); onSession(conversation.id); return conversation.id; })
      .finally(() => { pendingSession.current = null; });
    return pendingSession.current;
  }
  async function refresh(id) {
    const result = await api(`/api/chat/conversations/${id}/materials`);
    setMaterials(result.materials);
  }
  useEffect(() => { if (session) refresh(session).catch((err) => setError(err.message)); }, [session]);
  async function upload(event) {
    const files = [...event.target.files];
    event.target.value = "";
    if (!files.length) return;
    setUploading(true); setError("");
    let uploaded = [];
    let bound = false;
    try {
      const id = await ensureSession();
      const data = new FormData(); files.forEach((file) => data.append("files", file));
      const result = await api("/api/uploads", { method: "POST", body: data });
      uploaded = result.attachments;
      await api(`/api/chat/conversations/${id}/materials`, { method: "POST", body: JSON.stringify({ attachmentIds: uploaded.map((file) => file.id) }) });
      bound = true;
      await refresh(id); setSelected(uploaded[0].id);
    } catch (err) {
      setError(err.message);
      if (!bound) await Promise.all(uploaded.map((file) => api(`/api/uploads/${file.id}`, { method: "DELETE" }).catch(() => {})));
    } finally { setUploading(false); }
  }
  function startAction(item) {
    const prompt = active ? `${item.prompt}\nFocus on the material named "${active.name}".` : `${item.prompt}\nI haven't uploaded material yet. Ask me which topic I want to study.`;
    setAction({ prompt, label: item.label, id: Date.now() }); setDrawer(false); setView("chat");
  }
  const panel = <>
    <div className="study-materials__title"><BookOpen size={19} /><h2>Your materials</h2><span>{materials.length}</span></div>
    <p className="study-muted">Keep your notes beside the conversation. They stay with this study session.</p>
    <button type="button" className="btn btn--secondary" disabled={uploading} onClick={() => input.current?.click()}><Plus size={16} />{uploading ? "Reading documents…" : "Add study material"}</button>
    {error && <p className="banner banner--error" role="alert">{error}</p>}
    {materials.length > 0 ? <>
      <Select label="Study material" value={active?.id ?? ""} onChange={setSelected} options={materials.map((file) => ({ value: file.id, label: file.name }))} />
      <details className="study-excerpt" open><summary><FileText size={15} /> Extracted text</summary><pre>{active?.text}</pre><a href={`${apiBase}${active?.downloadUrl}`} target="_blank" rel="noreferrer">Open original <ArrowUpRight size={13} /></a></details>
      <p className="study-muted">Text extraction may not capture diagrams. The assistant will flag missing details.</p>
    </> : <div className="study-materials__empty"><FileText size={28} /><strong>A place for your notes</strong><span>Add a PDF, Word document, Markdown or text file, or start with a topic.</span></div>}
    <h3>Work with your material</h3>
    <div className="study-actions">{STUDY_ACTIONS.map((item) => <button type="button" key={item.label} disabled={uploading} onClick={() => startAction(item)}>{item.label}<ArrowUpRight size={14} /></button>)}</div>
    <h3>Writing tools</h3>
    <div className="study-actions"><button type="button" aria-pressed={view === "writing"} onClick={() => { setView(view === "writing" ? "chat" : "writing"); setDrawer(false); }}>{view === "writing" ? "Back to study chat" : "AI Detector and Humanizer"}<PenLine size={14} /></button></div>
  </>;
  return <section className="study-workspace">
    {/* No header bar: on wide viewports the materials panel is always
        visible as the aside below, so a toggle would do nothing there. On
        narrow viewports (where the aside hides) this floats over the
        conversation instead of reserving a dedicated row for it. */}
    <button type="button" className="btn btn--secondary study-materials-toggle" onClick={() => setDrawer(true)}><BookOpen size={17} />Materials ({materials.length})</button>
    <div className="study-layout"><div className="study-conversation">{view === "writing" ? <StudyWritingTools api={api} onBack={() => setView("chat")} /> : renderChat({ ensureSession, action, onMaterialSaved: (id) => refresh(id).catch((err) => setError(err.message)), studyMode: true })}</div><aside className="study-materials">{panel}</aside></div>
    <input ref={input} hidden type="file" multiple accept=".pdf,.docx,.md,.txt" onChange={upload} disabled={uploading} aria-label="Upload study materials" />
    <Modal open={drawer} onClose={() => setDrawer(false)} title="Study materials"><button autoFocus type="button" className="btn btn--quiet" onClick={() => setDrawer(false)}>Close materials</button><div className="study-materials-drawer">{panel}</div></Modal>
  </section>;
}
