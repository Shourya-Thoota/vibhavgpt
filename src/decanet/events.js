// Every DECA high school event that is judged on a role-play or case study.
// Prepared presentations, online simulations and written events are left out:
// there is no live judge interaction to practice.
//
// Timing follows DECA's published formats: individual role-plays get 10
// minutes to prepare and up to 10 minutes with the judge; Team Decision
// Making case studies get 30 minutes to prepare and up to 15 minutes with
// the judge (about 10 presenting, 5 for questions).
export const EVENT_FORMATS = {
  principles: { label: "Principles of Business Administration", prepSeconds: 600, roleplaySeconds: 600, questionsAtRemaining: 90, warnAtRemaining: 180, piCount: 5, piMax: 14, team: false },
  series: { label: "Individual Series", prepSeconds: 600, roleplaySeconds: 600, questionsAtRemaining: 90, warnAtRemaining: 180, piCount: 5, piMax: 14, team: false },
  pfl: { label: "Personal Financial Literacy", prepSeconds: 600, roleplaySeconds: 600, questionsAtRemaining: 90, warnAtRemaining: 180, piCount: 5, piMax: 14, team: false },
  tdm: { label: "Team Decision Making", prepSeconds: 1800, roleplaySeconds: 900, questionsAtRemaining: 300, warnAtRemaining: 360, piCount: 7, piMax: 10, team: true },
};

export const CLUSTERS = {
  bma: "Business Management + Administration",
  ent: "Entrepreneurship",
  fin: "Finance",
  ht: "Hospitality + Tourism",
  mkt: "Marketing",
  pfl: "Personal Financial Literacy",
};

export const EVENTS = [
  { code: "PBM", name: "Principles of Business Management and Administration", cluster: "bma", format: "principles" },
  { code: "PEN", name: "Principles of Entrepreneurship", cluster: "ent", format: "principles" },
  { code: "PFN", name: "Principles of Finance", cluster: "fin", format: "principles" },
  { code: "PHT", name: "Principles of Hospitality and Tourism", cluster: "ht", format: "principles" },
  { code: "PMK", name: "Principles of Marketing", cluster: "mkt", format: "principles" },
  { code: "ACT", name: "Accounting Applications Series", cluster: "fin", format: "series" },
  { code: "AAM", name: "Apparel and Accessories Marketing Series", cluster: "mkt", format: "series" },
  { code: "ASM", name: "Automotive Services Marketing Series", cluster: "mkt", format: "series" },
  { code: "BFS", name: "Business Finance Series", cluster: "fin", format: "series" },
  { code: "BSM", name: "Business Services Marketing Series", cluster: "mkt", format: "series" },
  { code: "ENT", name: "Entrepreneurship Series", cluster: "ent", format: "series" },
  { code: "FMS", name: "Food Marketing Series", cluster: "mkt", format: "series" },
  { code: "HLM", name: "Hotel and Lodging Management Series", cluster: "ht", format: "series" },
  { code: "HRM", name: "Human Resources Management Series", cluster: "bma", format: "series" },
  { code: "MCS", name: "Marketing Communications Series", cluster: "mkt", format: "series" },
  { code: "QSRM", name: "Quick Serve Restaurant Management Series", cluster: "ht", format: "series" },
  { code: "RFSM", name: "Restaurant and Food Service Management Series", cluster: "ht", format: "series" },
  { code: "RMS", name: "Retail Merchandising Series", cluster: "mkt", format: "series" },
  { code: "SEM", name: "Sports and Entertainment Marketing Series", cluster: "mkt", format: "series" },
  { code: "PFL", name: "Personal Financial Literacy", cluster: "pfl", format: "pfl" },
  { code: "BLTDM", name: "Business Law and Ethics Team Decision Making", cluster: "bma", format: "tdm" },
  { code: "BTDM", name: "Buying and Merchandising Team Decision Making", cluster: "mkt", format: "tdm" },
  { code: "ETDM", name: "Entrepreneurship Team Decision Making", cluster: "ent", format: "tdm" },
  { code: "FTDM", name: "Financial Services Team Decision Making", cluster: "fin", format: "tdm" },
  { code: "HTDM", name: "Hospitality Services Team Decision Making", cluster: "ht", format: "tdm" },
  { code: "MTDM", name: "Marketing Management Team Decision Making", cluster: "mkt", format: "tdm" },
  { code: "STDM", name: "Sports and Entertainment Marketing Team Decision Making", cluster: "mkt", format: "tdm" },
  { code: "TTDM", name: "Travel and Tourism Team Decision Making", cluster: "ht", format: "tdm" },
];

const BY_CODE = new Map(EVENTS.map((event) => [event.code, event]));

export function findEvent(code) {
  return BY_CODE.get(String(code ?? "").toUpperCase()) ?? null;
}

export function eventFormat(code) {
  const event = findEvent(code);
  return event ? EVENT_FORMATS[event.format] : null;
}

// The 21st Century Skills every DECA role-play rubric scores, 0-6 each.
export const CENTURY_SKILLS = [
  { key: "critical_thinking", label: "Critical Thinking", detail: "Reason effectively and use systems thinking." },
  { key: "problem_solving", label: "Problem Solving", detail: "Make judgments and decisions, and solve problems." },
  { key: "communication", label: "Communication", detail: "Communicate clearly." },
  { key: "creativity", label: "Creativity and Innovation", detail: "Show evidence of creativity." },
  { key: "overall", label: "Overall Impression", detail: "Overall impression and responses to the judge's questions." },
];
export const SKILL_MAX = 6;
