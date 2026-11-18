// The model showcase as plain HTML, rendered once at build time (scripts/prerender-public.js) into the static homepage.
//
// The interactive stage is a lazy island, so a crawler, a reader without script, a reader saving data and a reader whose
// island failed to load would otherwise find nothing here. This is the same five models from the same data, as a list. It
// uses no state and no browser API, so it renders in Node. When the island mounts it replaces this markup.

import { PUBLIC_CREDITS_MODE } from "./credits-copy.js";
import { ORBIT_ACTIONS, orbitSlides } from "./orbit-showcase-data.js";

export function OrbitFallback({ mode = PUBLIC_CREDITS_MODE }) {
  const slides = orbitSlides(mode);
  return (
    <>
      <ol className="orbits__list">
        {slides.map((slide) => (
          <li className="orbits__item" key={slide.id}>
            <img className="orbits__orb" src={slide.image} width="96" height="96" alt={slide.alt} loading="lazy" decoding="async" />
            <div className="orbits__copy">
              <h3>{`${slide.title} ${slide.subtitle}`}</h3>
              <p className="orbits__meta">{`${slide.badge.label}. ${slide.availability}.`}</p>
              <p>{slide.overview}</p>
              <p className="orbits__allow">{slide.allowance}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="orbits__actions">
        {ORBIT_ACTIONS.map((action, i) => (
          <a key={action.id} className={i === 0 ? "btn btn-primary" : "btn btn-quiet"} href={action.href}>{action.label}</a>
        ))}
      </p>
    </>
  );
}
