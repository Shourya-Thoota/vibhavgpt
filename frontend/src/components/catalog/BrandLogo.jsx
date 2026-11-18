/**
 * The one brand mark the model catalog shows: VibhavGPT's own. Every model, whatever runs it, is presented under VibhavGPT and its tier
 * names (Lumen, Nova, Nebula, Vulcan, Study); no other company's name, logo or colours appear in the product. `brandId` is accepted for
 * compatibility with existing callers and only decides the accessible label.
 */
const TIER_LABELS = { lumen: "Lumen", nova: "Nova", nebula: "Nebula", vesper: "Vulcan", study: "Study" };

export function BrandLogo({ brandId = "vibhavgpt", size = 20, className = "", title = null }) {
  const tier = TIER_LABELS[String(brandId || "").toLowerCase().trim()];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`brand-logo brand-logo--vibhavgpt ${className}`}
      aria-label={title || (tier ? `VibhavGPT ${tier}` : "VibhavGPT")}
      role="img"
    >
      <path
        d="M12 21C8 21 4 17 4 12C4 7 8 3 12 3C16 3 20 7 20 12C20 17 16 21 12 21Z"
        fill="url(#vibhav_blue_grad)"
      />
      <path
        d="M8.5 8.5L12 15.5L15.5 8.5"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient id="vibhav_blue_grad" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2563EB" />
          <stop offset="1" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default BrandLogo;
