// Input and output tokens share each model's allowance. Calendar months use UTC.
const caps = (monthly, rolling) => Object.freeze({ monthly, rolling });
export const TOKEN_QUOTAS = Object.freeze({
  free: Object.freeze({ lumen: caps(1_000_000, 100_000), nova: caps(1_000_000, 100_000), study: caps(500_000, 50_000), nebula: caps(0, 0), vesper: caps(0, 0), zenith: caps(0, 0), tecton: caps(0, 0) }),
  plus: Object.freeze({ lumen: caps(8_000_000, 800_000), nova: caps(8_000_000, 800_000), study: caps(4_000_000, 400_000), nebula: caps(1_500_000, 150_000), vesper: caps(0, 0), zenith: caps(0, 0), tecton: caps(0, 0) }),
  pro: Object.freeze({ lumen: caps(12_000_000, 1_200_000), nova: caps(12_000_000, 1_200_000), study: caps(6_000_000, 600_000), nebula: caps(3_000_000, 300_000), vesper: caps(800_000, 80_000), zenith: caps(0, 0), tecton: caps(2_000_000, 200_000) }),
  max: Object.freeze({ lumen: caps(30_000_000, 3_000_000), nova: caps(30_000_000, 3_000_000), study: caps(15_000_000, 1_500_000), nebula: caps(8_000_000, 800_000), vesper: caps(2_000_000, 200_000), zenith: caps(1_000_000, 100_000), tecton: caps(5_000_000, 500_000) }),
});
// Zenith (Slice 7) is Max only: a zero cap is "not included".
export const TOKEN_MODEL_NAMES = Object.freeze({ lumen: "Lumen", nova: "Nova", study: "Study", nebula: "Nebula", vesper: "Vulcan", zenith: "Zenith", tecton: "Tecton" });
export const ROLLING_TOKEN_WINDOW_MS = 5 * 60 * 60 * 1000;

// Compatibility for persisted selections and historical usage, never a product name.
export const canonicalModelKey = (key) => {
  if (!key) return "lumen";
  const norm = String(key).trim().toLowerCase();
  if (norm === "spark") return "lumen";
  if (norm === "ultra") return "nebula";
  return norm;
};
