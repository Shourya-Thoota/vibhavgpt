import { useEffect } from "react";
import { Footer, Nav } from "./components/Layout.jsx";
import { Spinner } from "./components/ui.jsx";
import { Link, navigate, useLocation } from "./router.jsx";
import { useSession } from "./session.jsx";
import { Login, ResetPassword, Signup } from "./pages/Auth.jsx";
import { Chapter, Invite } from "./pages/Chapter.jsx";
import { Credits } from "./pages/Credits.jsx";
import { Dashboard } from "./pages/Dashboard.jsx";
import { Landing } from "./pages/Landing.jsx";
import { Onboarding } from "./pages/Onboarding.jsx";
import { Roleplay } from "./pages/Roleplay.jsx";
import { Settings } from "./pages/Settings.jsx";

function Redirect({ to }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return null;
}

function NotFound() {
  return <div className="center"><h1 className="title">Page not found</h1><Link to="/" className="btn btn--primary">Go home</Link></div>;
}

// Screens that need an account send visitors to sign in first, and new
// accounts finish onboarding before anything else.
function route(path, account) {
  const home = account ? (account.role === "advisor" ? "/chapter" : "/dashboard") : "/";
  const join = path.match(/^\/join\/([A-Za-z0-9_-]+)$/);
  if (join) return <Invite token={join[1]} />;
  if (!account) {
    if (path === "/") return <Landing />;
    if (path === "/login") return <Login />;
    if (path === "/signup") return <Signup />;
    if (path === "/reset") return <ResetPassword />;
    if (["/dashboard", "/credits", "/chapter", "/settings", "/welcome"].includes(path) || path.startsWith("/roleplay/")) return <Redirect to={`/login?next=${encodeURIComponent(path + location.search)}`} />;
    return <NotFound />;
  }
  if (["/", "/login", "/signup", "/reset"].includes(path)) return <Redirect to={account.onboarded ? home : "/welcome"} />;
  if (!account.onboarded && path !== "/welcome" && path !== "/settings") return <Redirect to="/welcome" />;
  if (path === "/welcome") return <Onboarding />;
  if (path === "/settings") return <Settings />;
  if (path === "/chapter") return <Chapter />;
  if (account.role === "advisor" && (path === "/dashboard" || path === "/credits")) return <Redirect to="/chapter" />;
  if (path === "/dashboard") return <Dashboard />;
  if (path === "/credits") return <Credits />;
  const roleplay = path.match(/^\/roleplay\/([0-9a-f-]{36})$/i);
  if (roleplay) return <Roleplay id={roleplay[1]} />;
  return <NotFound />;
}

export function App() {
  const { loading, account } = useSession();
  const { path } = useLocation();
  const immersive = path.startsWith("/roleplay/");
  return (
    <div className="shell">
      <Nav />
      <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>{loading ? <Spinner /> : route(path, account)}</main>
      {!immersive && <Footer />}
    </div>
  );
}
