import { useEffect, useState } from "react";

// A small history-API router: DECANet has few enough screens not to need more.
export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new Event("decanet:navigate"));
  window.scrollTo(0, 0);
}

export function useLocation() {
  const read = () => ({ path: location.pathname.replace(/\/+$/, "") || "/", query: new URLSearchParams(location.search) });
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    window.addEventListener("popstate", update);
    window.addEventListener("decanet:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("decanet:navigate", update);
    };
  }, []);
  return value;
}

export function Link({ to, children, className, ...rest }) {
  return (
    <a href={to} className={className} {...rest} onClick={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    }}>{children}</a>
  );
}
