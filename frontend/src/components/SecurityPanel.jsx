import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { devicePasskeysAvailable, passkeysSupported, registerPasskey } from "../passkey-auth.js";
import { Field, SettingsSelect } from "./ui.jsx";
import { copyText } from "../clipboard.js";
import { authenticatorSetupKey } from "../authenticator-setup.js";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  // An unreadable body is reported in the reader's terms, never as the
  // parser's own message.
  const data = response.status === 204 ? null : await response.json().catch(() => {
    if (response.ok) throw new Error("Something went wrong. Please try again.");
    return null;
  });
  if (!response.ok) {
    const error = new Error(data?.error ?? "Something went wrong. Please try again.");
    error.code = data?.code;
    throw error;
  }
  return data;
}

export default function SecurityPanel({ user }) {
  const [method, setMethod] = useState("totp");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState("");
  const [backupCodes, setBackupCodes] = useState([]);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(Boolean(user.twoFactorEnabled));
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [recoveryComplete, setRecoveryComplete] = useState(Boolean(user.twoFactorRecoveryRequired));
  const [passkeys, setPasskeys] = useState([]);
  const [passkeyName, setPasskeyName] = useState("");
  const [passkeyType, setPasskeyType] = useState("");
  const [setupKeyCopied, setSetupKeyCopied] = useState(false);
  const [setupKeyCopyError, setSetupKeyCopyError] = useState(false);
  const setupKey = authenticatorSetupKey(setup?.totpURI);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeyError, setPasskeyError] = useState("");
  const webAuthnAvailable = passkeysSupported();

  useEffect(() => {
    if (user.twoFactorRecoveryRequired) return;
    request("/api/security/two-factor/status")
      .then((result) => setRecoveryRequired(result?.state === "recovery-required"))
      .catch(() => null);
  }, [user.id, user.twoFactorRecoveryRequired]);

  useEffect(() => {
    setQr("");
    setSetupKeyCopied(false);
    setSetupKeyCopyError(false);
    let cancelled = false;
    if (setup?.totpURI) QRCode.toDataURL(setup.totpURI, { margin: 1, width: 220 }).then(value => { if (!cancelled) setQr(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [setup]);

  async function loadPasskeys() {
    setPasskeyLoading(true);
    setPasskeyError("");
    try {
      const result = await request("/api/auth/passkey/list-user-passkeys", { cache: "no-store" });
      if (!Array.isArray(result)) throw new Error("Passkeys could not be loaded. Refresh and try again.");
      setPasskeys(result);
    } catch (e) {
      setPasskeys([]);
      setPasskeyError(e.message || "Passkeys could not be loaded. Refresh and try again.");
    } finally {
      setPasskeyLoading(false);
    }
  }

  useEffect(() => {
    if (webAuthnAvailable) void loadPasskeys();
  }, [user.id, webAuthnAvailable]);

  async function addPasskey() {
    if (!webAuthnAvailable) return;
    setPasskeyBusy(true);
    setError("");
    setPasskeyError("");
    try {
      // "This device" needs a built-in authenticator. Without one the browser
      // refuses at once with a bare "not allowed", so say what's missing first.
      if (passkeyType === "platform" && !(await devicePasskeysAvailable())) {
        throw Object.assign(new Error("This device has no built-in passkey support turned on. Enable your device PIN or biometrics, or choose Device or phone to use another authenticator."), { name: "PasskeyError" });
      }
      await registerPasskey({
        name: passkeyName.trim() || "My passkey",
        authenticatorAttachment: passkeyType,
      });
      setPasskeyName("");
      await loadPasskeys();
    } catch (e) {
      // Only our own wording reaches the page, never library or spec text.
      setPasskeyError(e?.name === "PasskeyError" ? e.message : "The passkey couldn't be added. Try again.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function deletePasskey(id) {
    setPasskeyBusy(true);
    setPasskeyError("");
    try {
      await request("/api/auth/passkey/delete-passkey", { method: "POST", body: JSON.stringify({ id }) });
      await loadPasskeys();
    } catch (e) {
      setPasskeyError("Your passkey could not be removed. Try again.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function enable() {
    setBusy(true);
    setError("");
    try {
      const result = await request("/api/auth/two-factor/enable", {
        method: "POST",
        body: JSON.stringify({ password, method: recoveryComplete ? "totp" : method, issuer: "VibhavGPT" }),
      });
      if (result.method === "otp") {
        setActive(true);
        setSetup({ ...result, verified: true });
      } else {
        setSetup(result);
        setBackupCodes(result.backupCodes ?? []);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function recoverEnrollment() {
    setBusy(true);
    setError("");
    try {
      const result = await request("/api/security/two-factor/recover", { method: "POST" });
      if (result?.state === "healthy") {
        setError("Your authenticator setup is still active. Try the current code again.");
        setRecoveryRequired(false);
        return;
      }
      setActive(false);
      setSetup(null);
      setBackupCodes([]);
      setPassword("");
      setCode("");
      setRecoveryRequired(false);
      setRecoveryComplete(true);
    } catch (e) {
      setError(e.message || "We couldn't renew your authenticator setup. Please sign in with an email code and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError("");
    try {
      await request("/api/auth/two-factor/verify-totp", { method: "POST", body: JSON.stringify({ code, trustDevice: false }) });
      setActive(true);
      setSetup(null);
      setBackupCodes(setup.backupCodes ?? []);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError("");
    try {
      await request("/api/auth/two-factor/disable", { method: "POST", body: JSON.stringify({ password }) });
      setActive(false);
      setSetup(null);
      setPassword("");
      setCode("");
      setBackupCodes([]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function exportCodes() {
    setBusy(true);
    setError("");
    try {
      const result = await request("/api/security/backup-codes");
      const codes = result.backupCodes ?? [];
      setBackupCodes(codes);
      // Copying is a convenience; a refused clipboard must not stop the
      // download, which is the part the user actually needs.
      await copyText(codes.join("\n"));
      const blob = new Blob([codes.join("\n") + "\n"], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "vibhavgpt-backup-codes.txt";
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function savePassword() {
    if (newPassword.length < 8 || newPassword !== confirmPassword) {
      setError(newPassword !== confirmPassword ? "Passwords do not match." : "Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request("/api/security/set-password", { method: "POST", body: JSON.stringify({ newPassword }) });
      window.location.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const passwordPrompt = !user.hasPassword && (
    <div className="card__body">
      <p className="note note--info">
        Add a password to sign in with your email and confirm sensitive security changes.
      </p>
      <Field label="New password" htmlFor="security-new-password">
        <input
          id="security-new-password"
          className="input"
          type="password"
          minLength="8"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          placeholder="At least 8 characters"
        />
      </Field>
      <Field label="Confirm password" htmlFor="security-confirm-password">
        <input
          id="security-confirm-password"
          className="input"
          type="password"
          minLength="8"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder="Repeat your password"
        />
      </Field>
      <div>
        <button className="btn btn--secondary" disabled={busy || !newPassword || !confirmPassword} onClick={savePassword}>
          {busy ? "Saving…" : "Set password"}
        </button>
      </div>
    </div>
  );

  return (
    // Two groups, the way Settings lays out every section: a title and a
    // line of help above, the controls in a panel below.
    <div className="settings-stack">
      <section className="settings-group" aria-labelledby="security-passkeys-title">
      <header className="settings-group__head">
        <h3 id="security-passkeys-title">Passkeys</h3>
        <p>Sign in with your device biometrics, PIN, or a security key. There's no password to type.</p>
      </header>

      <div className="settings-group__panel">
      {webAuthnAvailable ? (
        <div className="card__body security-passkeys">
          <Field label="Passkey name">
            <input
              className="input"
              value={passkeyName}
              maxLength="80"
              onChange={(event) => setPasskeyName(event.target.value)}
              placeholder="My laptop"
            />
          </Field>
          <Field label="Passkey type">
            <SettingsSelect
              label="Passkey type"
              value={passkeyType}
              onChange={setPasskeyType}
              options={[
                { value: "", label: "Device or phone", description: "Let your browser offer compatible passkeys." },
                { value: "platform", label: "This device", description: "Biometrics or your device PIN." },
                { value: "cross-platform", label: "Security key", description: "A hardware key you plug in or tap." },
              ]}
            />
          </Field>
          <div>
            <button className="btn btn--secondary" disabled={passkeyBusy} onClick={addPasskey}>
              {passkeyBusy ? "Waiting for your device…" : "Add a passkey"}
            </button>
          </div>

          {passkeyError && <p className="note note--error" role="alert">{passkeyError}</p>}
          {passkeyLoading ? (
            <p className="muted">Loading passkeys…</p>
          ) : passkeys.length > 0 ? (
            <div className="key-list">
              {passkeys.map((passkey) => (
                <div className="key-row" key={passkey.id}>
                  <span>
                    <strong>{passkey.name || "Passkey"}</strong>
                    <small>Added {passkey.createdAt ? new Date(passkey.createdAt).toLocaleDateString() : "recently"}</small>
                  </span>
                  <button className="btn btn--quiet" disabled={passkeyBusy} onClick={() => deletePasskey(passkey.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : !passkeyError ? (
            <p className="muted">No passkeys registered yet.</p>
          ) : null}
        </div>
      ) : (
        <div className="card__body">
          <p className="note note--error">
            Passkeys are not supported in this browser. Try an up-to-date browser.
          </p>
        </div>
      )}
      </div>
      </section>

      <section className="settings-group" aria-labelledby="security-two-step-title">
      <header className="settings-group__head">
        <h3 id="security-two-step-title">Two-step verification</h3>
        <p>Protect your account with an authenticator app or a security code sent by email.</p>
      </header>
      <div className="settings-group__panel">
      {passwordPrompt}

      {recoveryRequired && (
        <div className="card__body">
          <p className="note note--error">
            Your previous authenticator setup can no longer be read. Sign in with an email code, then renew it here.
          </p>
          <button className="btn btn--primary" disabled={busy} onClick={recoverEnrollment}>
            {busy ? "Renewing…" : "Renew authenticator setup"}
          </button>
        </div>
      )}

      {!recoveryRequired && (active ? (
        <div className="card__body">
          <p className="note note--good">Two-step verification is on.</p>
          <Field label="Current password" htmlFor="security-disable-password">
            <input
              id="security-disable-password"
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password to turn it off"
            />
          </Field>
          <div className="button-row">
            <button className="btn btn--secondary" disabled={busy} onClick={exportCodes}>
              Export backup codes
            </button>
            <button className="btn btn--danger" disabled={!password || busy || !user.hasPassword} onClick={disable}>
              {busy ? "Updating…" : "Turn off two-step verification"}
            </button>
          </div>
          {backupCodes.length > 0 && (
            <div className="backup-codes">
              {backupCodes.map((value) => (
                <code key={value}>{value}</code>
              ))}
            </div>
          )}
        </div>
      ) : !setup ? (
        <div className="card__body">
          {!recoveryComplete && (
            <Field label="Security method">
              <SettingsSelect
                label="Security method"
                value={method}
                onChange={setMethod}
                options={[
                  { value: "totp", label: "Authenticator app", description: "A rotating code on your phone.", badge: "Best" },
                  { value: "otp", label: "Email security code", description: "A code sent to your inbox each time." },
                ]}
              />
            </Field>
          )}
          {recoveryComplete && <p className="note note--info">Your old setup was removed after email recovery. Set up a new authenticator now.</p>}
          <Field label="Current password" htmlFor="security-enable-password">
            <input
              id="security-enable-password"
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your current password"
            />
          </Field>
          <div>
            <button className="btn btn--primary" disabled={busy || (user.hasPassword ? !password : !recoveryComplete)} onClick={enable}>
              {busy ? "Setting up…" : method === "totp" ? "Set up authenticator" : "Turn on email codes"}
            </button>
          </div>
        </div>
      ) : (
        <div className="card__body">
          <div className="steps">
            <p className="step">Scan this code in your authenticator app.</p>
            <div className="authenticator-enrollment">
            {qr && <img className="qr" src={qr} alt="Authenticator setup QR code" />}
            {setupKey && (
              <div className="authenticator-manual">
                <p className="ui-field__label" id="authenticator-setup-key-label">Manual setup key</p>
                <p className="muted">Cannot scan? Enter this key in your authenticator app. Choose a time-based code.</p>
                <code id="authenticator-setup-key" aria-labelledby="authenticator-setup-key-label" className="input authenticator-manual__key" tabIndex={0}>{setupKey}</code>
                <button type="button" className="btn btn--secondary" onClick={async () => {
                  const copied = await copyText(setupKey);
                  setSetupKeyCopied(copied);
                  setSetupKeyCopyError(!copied);
                }}>{setupKeyCopied ? "Copied" : "Copy setup key"}</button>
                <p className="muted" role="status">{setupKeyCopyError ? "Select the key above and copy it manually." : "Keep this key private. It gives access to your security codes."}</p>
              </div>
            )}
            </div>
            <p className="step">Enter the current six-digit code to activate it.</p>
          </div>
          <Field label="Authenticator code" htmlFor="security-totp-code">
            <input
              id="security-totp-code"
              className="input input--code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength="6"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              placeholder="000000"
            />
          </Field>
          <div>
            <button className="btn btn--primary" disabled={code.length !== 6 || busy} onClick={verify}>
              {busy ? "Verifying…" : "Activate authenticator"}
            </button>
          </div>
          {backupCodes.length > 0 && (
            <div className="backup-codes">
              <strong>Save these backup codes somewhere safe.</strong>
              {backupCodes.map((value) => (
                <code key={value}>{value}</code>
              ))}
            </div>
          )}
        </div>
      ))}
      </div>
      </section>

      {error && (
        <p className="note note--error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
