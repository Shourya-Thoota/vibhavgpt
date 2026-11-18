import { useState, useEffect } from "react";

const BRAND_ICON = "/brand/vibhavgpt-icon-64.png";

export function PublicNav({ current = "" }) {
  const [authState, setAuthState] = useState({ loading: true, signedIn: false, user: null });
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    if (typeof window === "undefined") return;
    fetch("/api/auth/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((session) => {
        if (!mounted) return;
        const user = session?.user ?? null;
        setAuthState({ loading: false, signedIn: Boolean(user), user });
      })
      .catch(() => {
        if (mounted) setAuthState({ loading: false, signedIn: false, user: null });
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const handleClickOutside = (e) => {
      const sheet = document.getElementById("site-sheet");
      const toggle = document.querySelector(".menu-toggle");
      if (sheet && !sheet.contains(e.target) && (!toggle || !toggle.contains(e.target))) {
        setMenuOpen(false);
      }
    };
    const handleResize = () => {
      if (window.innerWidth >= 768) setMenuOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("click", handleClickOutside);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("click", handleClickOutside);
      window.removeEventListener("resize", handleResize);
    };
  }, [menuOpen]);

  const { signedIn, user } = authState;

  return (
    <div className="public-nav-wrap">
      <header className="public-nav lg lg-m" id="top-nav" aria-label="Main navigation">
        <a className="brand" href="/home" aria-label="VibhavGPT home">
          <img src={BRAND_ICON} width="22" height="22" alt="" />
          <span>VibhavGPT</span>
        </a>

        <nav className="public-nav__links nav-links" aria-label="Main navigation">
          <a href="/pricing" aria-current={current === "pricing" ? "page" : undefined}>Pricing</a>
          <a href="/apps" aria-current={current === "apps" ? "page" : undefined}>Apps</a>
          <a href="/guarantee" aria-current={current === "guarantee" ? "page" : undefined}>Guarantee</a>
          {!signedIn && <a href="/login" id="nav-signin" className="nav-signin">Log in</a>}
          {signedIn && (
            <a className="avatar-chip" href="/app" id="nav-avatar" aria-label="Open your workspace">
              {user?.image ? <img src={user.image} alt="" /> : (user?.name?.[0]?.toUpperCase() ?? "V")}
            </a>
          )}
        </nav>

        <a
          className="btn btn-primary"
          href={signedIn ? "/app" : "/login?mode=signup"}
          id="nav-enroll"
        >
          {signedIn ? "Open workspace" : "Sign up"}
        </a>

        <button
          className="menu-toggle"
          type="button"
          aria-expanded={menuOpen}
          aria-controls="site-sheet"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <svg viewBox="0 0 20 20" fill="none" width="20" height="20" aria-hidden="true">
            <path d="M3 6.5h14M3 13.5h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {menuOpen && (
        <div className="public-sheet sheet lg lg-l" id="site-sheet" aria-label="Menu" data-open>
          <a href="/pricing" aria-current={current === "pricing" ? "page" : undefined} onClick={() => setMenuOpen(false)}>Pricing</a>
          <a href="/apps" aria-current={current === "apps" ? "page" : undefined} onClick={() => setMenuOpen(false)}>Apps</a>
          <a href="/guarantee" aria-current={current === "guarantee" ? "page" : undefined} onClick={() => setMenuOpen(false)}>Guarantee</a>
          {!signedIn ? (
            <>
              <a href="/login" onClick={() => setMenuOpen(false)}>Log in</a>
              <a className="btn btn-primary" href="/login?mode=signup" onClick={() => setMenuOpen(false)}>Sign up</a>
            </>
          ) : (
            <a className="btn btn-primary" href="/app" onClick={() => setMenuOpen(false)}>Open workspace</a>
          )}
        </div>
      )}
    </div>
  );
}
