// Sign-in provider marks (Slice 8), drawn the way the site's other outline icons are (social-links.js): a 24-unit box, a 1.75 stroke in
// the text colour, round caps and joins. Google keeps its own colour mark (App.jsx), as before.
const Outline = ({ children }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export const GitHubMark = () => (
  <Outline>
    <path d="M9 19c-4 1.3-4-2-5.5-2.5M14.5 21v-3.4c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.7 11.7 0 0 0-6.2 0C6.1 3 5.1 3.3 5.1 3.3a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 3.7 9.6c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  </Outline>
);

export const MicrosoftMark = () => (
  <Outline>
    <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1" />
    <rect x="13" y="3.5" width="7.5" height="7.5" rx="1" />
    <rect x="3.5" y="13" width="7.5" height="7.5" rx="1" />
    <rect x="13" y="13" width="7.5" height="7.5" rx="1" />
  </Outline>
);

export const DiscordMark = () => (
  <Outline>
    <path d="M8.5 5.5c-1.6.3-3 .8-4.2 1.6-1.6 2.6-2.3 5.4-2 8.4 1.4 1.2 3 1.9 4.7 2.4l1-1.7" />
    <path d="M15.5 5.5c1.6.3 3 .8 4.2 1.6 1.6 2.6 2.3 5.4 2 8.4-1.4 1.2-3 1.9-4.7 2.4l-1-1.7" />
    <path d="M7.5 16.2c2.9 1.4 6.1 1.4 9 0M8.6 6.2c2.3-.6 4.5-.6 6.8 0" />
    <circle cx="9.2" cy="12.2" r="1.15" />
    <circle cx="14.8" cy="12.2" r="1.15" />
  </Outline>
);
