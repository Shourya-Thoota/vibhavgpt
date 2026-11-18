// VibhavGPT's own profiles, exactly as the owner gave them. They open in a new tab, and every footer uses this list (the static pages carry
// the same markup, which test/social-links.test.js checks against it). Do not add or guess others.
export const SOCIAL_LINKS = Object.freeze([
  Object.freeze({ id: "instagram", label: "Instagram", href: "https://www.instagram.com/vibhavgpt.ai/" }),
  Object.freeze({ id: "x", label: "X", href: "https://x.com/VibhavGPT" }),
  Object.freeze({ id: "bluesky", label: "Bluesky", href: "https://bsky.app/profile/vibhavgpt.bsky.social" }),
  Object.freeze({ id: "reddit", label: "Reddit", href: "https://www.reddit.com/user/Cool-Issue-2311/" }),
]);

export const socialLinkName = (link) => `VibhavGPT on ${link.label} (opens in a new tab)`;

/** The footer markup for the static pages (they have no build step). */
export function socialLinksHtml(indent = "") {
  const links = SOCIAL_LINKS.map((link) => `<a href="${link.href}" target="_blank" rel="noopener noreferrer" aria-label="${socialLinkName(link)}">${link.label}</a>`).join("");
  return `${indent}<nav class="footer__social" aria-label="VibhavGPT on social media">${links}</nav>`;
}

// The Sources page's Social section: the YouTube channel the page has always linked, the four profiles, Threads and GitHub. The handle shown is
// read from the address itself (nothing is invented), and each row names the platform. Static pages have no build step, so the markup is
// generated here and checked against the page by test/apps-pages.test.js.
export const YOUTUBE_CHANNEL = Object.freeze({ id: "youtube", label: "YouTube", href: "https://www.youtube.com/@vibhavthoota" });

// Threads and GitHub were added by the owner (Slice 6), with these exact addresses and handles.
export const THREADS = Object.freeze({ id: "threads", label: "Threads", href: "https://www.threads.net/@vibhavgpt.ai", handle: "@vibhavgpt.ai" });
export const GITHUB = Object.freeze({ id: "github", label: "GitHub", href: "https://github.com/Shourya-Thoota", handle: "@Shourya-Thoota" });

// One icon set: 24-unit outline glyphs, round caps and joins, the same 1.75 stroke for every platform (the filled brand marks of X and
// Bluesky are redrawn as outlines so nothing mixes styles).
const svg = (body) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
export const SOCIAL_ICONS_OUTLINE = Object.freeze({
  youtube: svg('<rect x="3" y="5.5" width="18" height="13" rx="4"/><path d="m10.5 9.5 4 2.5-4 2.5z"/>'),
  instagram: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="3.75"/><path d="M17 7h.01"/>'),
  x: svg('<path d="M4.5 4h4.2l10.8 16h-4.2z"/><path d="M19.5 4 13.3 11.1M4.5 20l6.2-7.1"/>'),
  bluesky: svg('<path d="M12 11.2C10.6 8.4 7.3 4.7 4.8 4.2 3.6 4 3 4.6 3 5.8c0 1.1.5 4.5.9 5.4.8 1.9 3 2.4 5 2.1-3 .6-4.6 2.3-2.4 4.5 2.4 2.4 4.4.2 5.5-3 1.1 3.2 3.1 5.4 5.5 3 2.2-2.2.6-3.9-2.4-4.5 2 .3 4.2-.2 5-2.1.4-.9.9-4.3.9-5.4 0-1.2-.6-1.8-1.8-1.6-2.5.5-5.8 4.2-7.2 7z"/>'),
  reddit: svg('<ellipse cx="12" cy="14" rx="7.5" ry="5.5"/><path d="M9.5 16.3c1.5.9 3.5.9 5 0"/><path d="m12 8.5 1.1-4.3 3.6.9"/><circle cx="18" cy="5.4" r="1.1"/><path d="M9 13.2h.01M15 13.2h.01"/>'),
  threads: svg('<path d="M16.6 10.6c-.3-2.6-2-4.1-4.5-4.1-2.3 0-3.9 1.3-4.4 3.3"/><path d="M15.5 11.4c-1.4-.6-3.4-.7-4.8-.2-1.4.5-2 1.6-1.8 2.7.3 1.4 1.8 2.1 3.4 2 2.4-.2 3.6-1.8 3.6-5.1 0-4.5-2-7.3-6-7.3S4 6.6 4 12s2.6 8.3 7.9 8.3c3.3 0 5.6-1.3 6.8-3.6.9-1.9.5-4.1-1.1-5.3"/>'),
  github: svg('<path d="M9 19c-4 1.3-4-2-5.5-2.5M14.5 21v-3.4c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.7 11.7 0 0 0-6.2 0C6.1 3 5.1 3.3 5.1 3.3a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 3.7 9.6c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>'),
});

const SOCIAL_DETAILS = Object.freeze({
  youtube: { handle: "@vibhavthoota", note: "The channel of Vibhav Thoota" },
  instagram: { handle: "@vibhavgpt.ai", note: "VibhavGPT on Instagram" },
  x: { handle: "@VibhavGPT", note: "VibhavGPT on X" },
  bluesky: { handle: "@vibhavgpt.bsky.social", note: "VibhavGPT on Bluesky" },
  reddit: { handle: "u/Cool-Issue-2311", note: "VibhavGPT on Reddit" },
  threads: { handle: THREADS.handle, note: "VibhavGPT on Threads" },
  github: { handle: GITHUB.handle, note: "The GitHub profile of the account that publishes VibhavGPT's source" },
});


// Seven destinations, in one order: the channel, the four profiles, then Threads and GitHub (added by the owner in Slice 6). The footer's
// social row is this same list.
export const SOURCES_SOCIAL = Object.freeze([YOUTUBE_CHANNEL, ...SOCIAL_LINKS, THREADS, GITHUB].map((link) => Object.freeze({ ...link, ...SOCIAL_DETAILS[link.id], icon: SOCIAL_ICONS_OUTLINE[link.id] })));

const ARROW = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';

/** The Sources page's Social section, as the static page carries it. */
export function sourcesSocialHtml(indent = "") {
  const rows = SOURCES_SOCIAL.map((link) => [
    `${indent}    <li>`,
    `${indent}      <a class="src-row src-row--social" href="${link.href}" target="_blank" rel="noopener noreferrer">`,
    `${indent}        <span class="src-row__icon" aria-hidden="true">${link.icon}</span>`,
    `${indent}        <span class="src-row__main"><strong>${link.label}</strong><span>${link.handle}</span><small>${link.note}</small></span>`,
    `${indent}        ${ARROW}`,
    `${indent}        <span class="sr-only">(opens in a new tab)</span>`,
    `${indent}      </a>`,
    `${indent}    </li>`,
  ].join("\n")).join("\n");
  return [
    `${indent}<section class="src-section rise" style="--i: 3" aria-labelledby="social-title">`,
    `${indent}  <h2 id="social-title" class="src-section__title">Social</h2>`,
    `${indent}  <ul class="src-list src-list--social">`,
    rows,
    `${indent}  </ul>`,
    `${indent}</section>`,
  ].join("\n");
}
