import { Coins, Moon, Settings, Sun } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "../router.jsx";
import { useSession } from "../session.jsx";
import { applyTheme, readTheme } from "../theme.js";

export function BrandMark({ size = 30 }) {
  return (
    <span className="brand__mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 64 64" width={size * 0.72} height={size * 0.72}><path d="M15 12h17c11.6 0 19 7.6 19 20s-7.4 20-19 20H15z" fill="none" stroke="currentColor" strokeWidth="7" strokeLinejoin="round" /><circle cx="32" cy="32" r="6" fill="#9fd0ff" /></svg>
    </span>
  );
}

export function Brand({ showBy = true }) {
  const { account } = useSession();
  return (
    <Link to={account ? "/dashboard" : "/"} className="brand">
      <BrandMark />
      DECANet
      {showBy && <span className="brand__by">by VibhavGPT</span>}
    </Link>
  );
}

function ThemeButton() {
  const [theme, setTheme] = useState(readTheme);
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <button className="icon-btn" type="button" aria-label={dark ? "Use light mode" : "Use dark mode"} title={dark ? "Light mode" : "Dark mode"}
      onClick={() => { const next = dark ? "light" : "dark"; applyTheme(next); setTheme(next); }}>
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

export function Nav() {
  const { account, credits } = useSession();
  const { path } = useLocation();
  const current = (to) => (path === to || path.startsWith(`${to}/`) ? "page" : undefined);
  return (
    <header className="nav">
      <div className="nav__row">
        <Brand />
        {account && (
          <nav className="nav__links" aria-label="Main">
            {account.role === "participant" && <Link to="/dashboard" aria-current={current("/dashboard")}>Role-plays</Link>}
            <Link to="/chapter" aria-current={current("/chapter")}>{account.role === "advisor" ? "My chapter" : "Chapter"}</Link>
            {account.role === "participant" && <Link to="/credits" aria-current={current("/credits")}>Credits</Link>}
          </nav>
        )}
        <span className="nav__spacer" />
        <ThemeButton />
        {account ? (
          <>
            {account.role === "participant" && (
              <Link to="/credits" className="pill pill--blue" title="Your credits"><Coins size={14} /> {credits}</Link>
            )}
            <Link to="/settings" className="icon-btn" aria-label="Settings" title="Settings"><Settings size={17} /></Link>
          </>
        ) : (
          path !== "/login" && path !== "/signup" && (
            <>
              <Link to="/login" className="btn btn--quiet btn--sm">Sign in</Link>
              <Link to="/signup" className="btn btn--primary btn--sm">Get started</Link>
            </>
          )
        )}
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer__row">
        <span>© {new Date().getFullYear()} DECANet, a VibhavGPT product by Pansophy LLC.</span>
        <span className="row" style={{ gap: 16 }}>
          <a href="https://vibhavgpt.com/terms">Terms</a>
          <a href="https://vibhavgpt.com/privacy">Privacy</a>
          <a href="mailto:support@pansophy.com">Support</a>
        </span>
      </div>
      <div className="footer__row tiny" style={{ paddingTop: 0 }}>
        DECANet is an independent practice tool and is not affiliated with or endorsed by DECA Inc. Role-plays are original scenarios written for practice.
      </div>
    </footer>
  );
}
