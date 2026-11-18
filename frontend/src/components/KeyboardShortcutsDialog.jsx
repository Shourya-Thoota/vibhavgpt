import { Modal } from "./ui.jsx";
import { shortcutRows } from "../keyboard-shortcuts.js";
import "./KeyboardShortcutsDialog.css";

// Ctrl+/ (Cmd+/ on a Mac): every keyboard shortcut the workspace has, with the keys as this platform names them.
export default function KeyboardShortcutsDialog({ open, onClose }) {
  const rows = shortcutRows();
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts">
      <dl className="shortcuts-list">
        {rows.map((row) => (
          <div className="shortcuts-list__row" key={row.action} data-action={row.action}>
            <dt>{row.label}</dt>
            <dd>{row.keys.map((key, index) => <kbd key={index}>{key}</kbd>)}</dd>
          </div>
        ))}
      </dl>
      <p className="shortcuts-list__note">Shortcuts wait while you type in a field. Your browser keeps some keys for itself, such as Ctrl+N for a new window; those work in the Windows app.</p>
      <div className="ui-modal__actions">
        <button type="button" className="btn btn--secondary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
