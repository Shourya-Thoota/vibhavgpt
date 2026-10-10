import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/* Shared behaviour ------------------------------------------------------- */

// Open overlays in the order they opened, so Android's Back can close the
// topmost one before it falls through to the drawer or page history.
const backStack = [];

export function useBackDismiss(open, close) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    const entry = () => closeRef.current();
    backStack.push(entry);
    return () => {
      const index = backStack.lastIndexOf(entry);
      if (index !== -1) backStack.splice(index, 1);
    };
  }, [open]);
}

// Closes the most recently opened overlay. Returns whether there was one.
export function dismissTopOverlay() {
  const top = backStack[backStack.length - 1];
  if (!top) return false;
  top();
  return true;
}

// Closes a popover on outside pointer-down, Escape, or a scroll that would
// leave the anchor behind. Returns nothing; callers own the open state.
export function useDismiss(open, close, refs) {
  useBackDismiss(open, close);
  useEffect(() => {
    if (!open) return undefined;
    const inside = (target) => refs.some((ref) => ref.current?.contains(target));
    const onPointerDown = (event) => {
      if (!inside(event.target)) close();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    // The ref array is stable per call site, so identity churn is not a concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close]);
}

// Positions a popover panel that is portaled to document.body, in fixed
// viewport coordinates computed from the trigger's own bounding rect.
//
// The panel used to be an absolutely-positioned child of its trigger's
// wrapper, placed with plain CSS (top/left percentages) and escaping visually
// via z-index. That broke the moment any ancestor between the wrapper and the
// page root created its own stacking context — which a CSS animation does
// for as long as it keeps "filling" (animation-fill-mode: forwards/both),
// even once the animated property has settled back to its resting value. Our
// card entrance animations do exactly that, so a Select opened inside a card
// could render behind a later sibling card. Portaling to <body> and
// positioning in fixed coordinates sidesteps every such ancestor entirely —
// stacking contexts, overflow:hidden, transforms, all of it — rather than
// requiring every future animation anywhere in the app to avoid this trap.
function useFloatingPosition(open, anchorRef, panelRef, { placement = "bottom", align = "start", gap = 7 } = {}) {
  const [rect, setRect] = useState(null);

  const measure = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const panelNode = panelRef.current;
    // The entrance animation scales the visual rect, but placement needs the
    // full layout size so the settled menu stays inside the viewport.
    const panel = panelNode ? { width: panelNode.offsetWidth, height: panelNode.offsetHeight } : null;
    if (!anchor || !panel) return;
    const below = window.innerHeight - anchor.bottom;
    const above = anchor.top;
    const resolved =
      placement === "bottom"
        ? below < panel.height + gap + 8 && above > below
          ? "top"
          : "bottom"
        : above < panel.height + gap + 8 && below > above
          ? "bottom"
          : "top";
    const rawTop = resolved === "bottom" ? anchor.bottom + gap : anchor.top - panel.height - gap;
    const top = Math.max(8, Math.min(rawTop, window.innerHeight - panel.height - 8));
    const width = align === "stretch" ? anchor.width : undefined;
    const rawLeft = align === "end" ? anchor.right - (width ?? panel.width) : anchor.left;
    // Clamped so a panel anchored near the right or bottom edge of the
    // viewport is never pushed partly off-screen.
    const left = Math.min(Math.max(rawLeft, 8), window.innerWidth - (width ?? panel.width) - 8);
    // Previously the panel was `min-width: 100%` of its positioned ancestor
    // (the trigger's own wrapper), so a short options list was never
    // narrower than the control that opened it. Portaled to <body>, "100%"
    // would resolve against the viewport instead. Using panel.width (its
    // already-rendered width, which includes any size-specific CSS min-width
    // like `.composer__model .ui-select__list`) rather than just the
    // anchor's own width keeps those declared minimums intact — an inline
    // minWidth smaller than one would otherwise override it outright.
    //
    // Stretch is exempt: it means "exactly the anchor's width," and CSS
    // min-width beats an inline `width` when the two disagree, so folding
    // panel.width in here could make a stretched menu wider than its anchor.
    const minWidth = align === "stretch" ? anchor.width : Math.max(anchor.width, panel.width);
    setRect({ top, left, width, minWidth, placement: resolved });
  }, [anchorRef, panelRef, placement, align, gap]);

  // Runs before paint, so the panel's first-measured position is what
  // actually reaches the screen rather than flashing at (0, 0) first.
  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return undefined;
    // Applying the trigger's minimum width can reflow help text after the
    // first measurement. Reposition again when the panel's size settles.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (panelRef.current) observer?.observe(panelRef.current);
    // Capture-phase so a scroll inside any nested scroll container (not just
    // the window) is caught too.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  const style = rect
    ? { position: "fixed", top: rect.top, left: rect.left, minWidth: rect.minWidth, ...(rect.width ? { width: rect.width } : {}) }
    : { position: "fixed", top: 0, left: 0, visibility: "hidden" };
  // `rect` starts null and is only set once `measure()` has actually run, one
  // render after the panel first mounts (see the layout effect above). A
  // caller that auto-focuses something inside the panel on open needs to
  // wait for this, not just for `open` — focusing an element still sitting
  // under the `visibility: hidden` fallback style silently does nothing, so
  // firing on `open` alone raced the very first open of every Select/Menu.
  return { style, placement: rect?.placement ?? placement, ready: rect !== null };
}

/* Select ----------------------------------------------------------------- */

// Settings use the composer's model-list presentation with the same listbox
// behaviour. Custom model rows still supply their orb and eligibility details.
export function SettingsSelect({ renderOption, listClassName = "", className = "", ...props }) {
  return <Select
    {...props}
    className={`settings-picker ${className}`}
    listClassName={`model-list settings-picker__list ${listClassName}`}
    renderOption={renderOption ?? ((option, { selected }) => (
      <span className="model-row" data-locked={option.disabled || undefined}>
        <span className="model-row__text">
          <span className="model-row__head">
            <span className="model-row__name">{option.label}</span>
            {(option.badges ?? (option.badge ? [{ label: option.badge }] : [])).map((badge) => (
              <span className="model-row__tier" key={badge.label}>{badge.label}</span>
            ))}
          </span>
          {option.description && <span className="model-row__desc">{option.description}</span>}
        </span>
        <span className="model-row__meta">
          {selected && <Check className="model-row__check" size={16} strokeWidth={2.6} aria-hidden="true" />}
        </span>
      </span>
    ))}
  />;
}

/**
 * A listbox that replaces the native <select>: it can render a description and
 * a trailing badge per option, which the native control cannot do, and it
 * looks identical on every platform.
 *
 * options: [{ value, label, description?, badge?, badges?, icon? }]
 */
export function Select({
  id,
  value,
  onChange,
  options,
  disabled = false,
  onDisabledChange,
  label,
  placeholder = "Select…",
  size = "md",
  align = "start",
  placement = "bottom",
  className = "",
  // Optional custom rendering for a picker that needs more than a label and
  // a line of help (the composer's model picker). Keyboard, typeahead and
  // ARIA stay this component's job either way.
  renderOption,
  renderValue,
  listClassName = "",
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const anchorRef = useRef(null);
  const panelRef = useRef(null);
  const typeaheadRef = useRef({ query: "", at: 0 });
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, [anchorRef, panelRef]);
  const floating = useFloatingPosition(open, anchorRef, panelRef, { placement, align });
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex === -1 ? null : options[selectedIndex];
  const optionBadges = (option) => option.badges ?? (option.badge ? [{ label: option.badge }] : []);

  useEffect(() => {
    if (open) setActiveIndex(selectedIndex === -1 ? 0 : selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    panelRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const commit = (index) => {
    const option = options[index];
    if (!option) return;
    if (option.disabled) {
      onDisabledChange?.(option);
      setOpen(false);
      anchorRef.current?.focus();
      return;
    }
    onChange(option.value);
    setOpen(false);
    anchorRef.current?.focus();
  };

  const step = (delta) => {
    setActiveIndex((current) => {
      const total = options.length;
      let next = current;
      for (let hop = 0; hop < total; hop += 1) {
        next = (next + delta + total) % total;
        if (!options[next].disabled) return next;
      }
      return current;
    });
  };

  function onKeyDown(event) {
    if (disabled) return;
    if (!open && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(options.findIndex((option) => !option.disabled));
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Tab":
        setOpen(false);
        break;
      default: {
        // Typeahead: letters typed within 800ms extend the same query.
        if (event.key.length !== 1) return;
        const now = Date.now();
        const state = typeaheadRef.current;
        state.query = now - state.at > 800 ? event.key : state.query + event.key;
        state.at = now;
        const match = options.findIndex(
          (option) => !option.disabled && option.label.toLowerCase().startsWith(state.query.toLowerCase()),
        );
        if (match !== -1) setActiveIndex(match);
      }
    }
  }

  return (
    <div className={`ui-select ui-select--${size} ${className}`.trim()} data-open={open || undefined}>
      <button
        type="button"
        id={id}
        ref={anchorRef}
        className="ui-select__trigger"
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="listbox"
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        <span className="ui-select__value">
          {renderValue && selected ? renderValue(selected) : <>
            {selected?.icon}
            <span>{selected ? selected.label : placeholder}</span>
          </>}
        </span>
        <ChevronDown className="ui-select__caret" size={15} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={listId}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            className={`ui-popover ui-select__list ${listClassName}`.trim()}
            data-placement={floating.placement}
            data-align={align}
            style={floating.style}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                data-index={index}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className="ui-option"
                data-active={index === activeIndex || undefined}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
              >
                {renderOption ? renderOption(option, { selected: option.value === value }) : <>
                  <span className="ui-option__body">
                    <span className="ui-option__label">
                      {option.icon}
                      {option.label}
                      {optionBadges(option).map((badge) => (
                        <em className="ui-option__badge" data-tone={badge.tone} key={badge.label}>{badge.label}</em>
                      ))}
                    </span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                  {option.value === value && <Check className="ui-option__check" size={15} strokeWidth={2.6} aria-hidden="true" />}
                </>}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

/* Menu ------------------------------------------------------------------- */

const MenuContext = createContext(null);

export function Menu({ trigger, children, label, align = "start", placement = "bottom", className = "", panelClassName = "" }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const panelRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, [anchorRef, panelRef]);
  const floating = useFloatingPosition(open, anchorRef, panelRef, { placement, align });
  const context = useMemo(() => ({ close }), [close]);

  useEffect(() => {
    // Waits on floating.ready, not just `open`: the panel spends its first
    // render under a `visibility: hidden` fallback style (see
    // useFloatingPosition) until it has actually been measured and
    // positioned, and an element can't take focus while that's in effect.
    if (open && floating.ready) panelRef.current?.querySelector("[role^='menuitem']:not([disabled])")?.focus();
  }, [open, floating.ready]);

  function onPanelKeyDown(event) {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const items = [...panelRef.current.querySelectorAll("[role^='menuitem']:not([disabled])")];
    const current = items.indexOf(document.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(current + delta + items.length) % items.length]?.focus();
  }

  return (
    <div className={`ui-menu ${className}`.trim()}>
      {trigger({ ref: anchorRef, open, toggle: () => setOpen((value) => !value) })}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label={label}
            className={`ui-popover ui-menu__panel ${panelClassName}`.trim()}
            data-placement={floating.placement}
            data-align={align}
            style={floating.style}
            onKeyDown={onPanelKeyDown}
          >
            <MenuContext.Provider value={context}>{children}</MenuContext.Provider>
          </div>,
          document.body,
        )}
    </div>
  );
}

// An optional `description` adds a line of help under the name, the way
// the pickers show it; `selected` (true or false) makes the item one choice
// of several, marked with a tint and a check rather than a swapped icon.
export function MenuItem({ icon, children, onSelect, tone = "default", disabled = false, hint, href, target = "_blank", description, selected, trailing }) {
  const menu = useContext(MenuContext);
  const Item = href ? "a" : "button";
  const choice = typeof selected === "boolean";
  return (
    <Item
      {...(href ? { href, target, ...(target === "_blank" ? { rel: "noopener noreferrer" } : {}) } : { type: "button" })}
      role={choice ? "menuitemradio" : "menuitem"}
      {...(choice ? { "aria-checked": selected } : {})}
      className="ui-menu__item"
      data-tone={tone}
      data-rich={description ? "" : undefined}
      disabled={disabled}
      onClick={(event) => {
        menu?.close();
        onSelect?.(event);
      }}
    >
      {icon && <span className="ui-menu__icon" aria-hidden="true">{icon}</span>}
      <span className="ui-menu__text">
        <span className="ui-menu__name">{children}</span>
        {description && <small className="ui-menu__description">{description}</small>}
      </span>
      {hint && <kbd>{hint}</kbd>}
      {trailing}
      {choice && selected && <Check className="ui-menu__check" size={16} strokeWidth={2.6} aria-hidden="true" />}
    </Item>
  );
}

export function MenuSeparator() {
  return <div className="ui-menu__separator" role="separator" />;
}

export function MenuLabel({ children }) {
  return <div className="ui-menu__label">{children}</div>;
}

/* Segmented control ------------------------------------------------------ */

export function Segmented({ value, onChange, options, label, size = "md", className = "" }) {
  const listRef = useRef(null);
  function onKeyDown(event) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = options[(index + delta + options.length) % options.length];
    onChange(next.value);
    listRef.current?.querySelector(`[data-value="${next.value}"]`)?.focus();
  }
  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={label}
      className={`ui-segmented ui-segmented--${size} ${className}`.trim()}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className="ui-segmented__option"
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
          {option.badge && <em>{option.badge}</em>}
        </button>
      ))}
    </div>
  );
}

/* Choice cards ----------------------------------------------------------- */

export function ChoiceCards({ value, onChange, options, label, columns = 2 }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="ui-choices"
      style={{ "--choice-columns": columns }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="ui-choice"
          data-selected={option.value === value || undefined}
          onClick={() => onChange(option.value)}
        >
          <span className="ui-choice__dot" aria-hidden="true" />
          <span className="ui-choice__copy">
            <strong>{option.label}</strong>
            {option.description && <small>{option.description}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}

/* Modal ------------------------------------------------------------------ */

export function Modal({ open, onClose, title, eyebrow, description, children, onSubmit, size = "md" }) {
  const panelRef = useRef(null);
  useBackDismiss(open, onClose);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll(
        "a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const Panel = onSubmit ? "form" : "div";
  return (
    <div className="ui-scrim" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <Panel
        ref={panelRef}
        className={`ui-modal ui-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={onSubmit}
      >
        {eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}
        <h2 className="ui-modal__title">{title}</h2>
        {description && <p className="ui-modal__description">{description}</p>}
        {children}
      </Panel>
    </div>
  );
}

/* Field ------------------------------------------------------------------ */

/**
 * Labels its control by id rather than by wrapping it, so a custom control
 * built from a <button> is not nested inside a <label> that also targets it.
 * A child that already carries an id keeps it.
 */
export function Field({ label, hint, error, htmlFor, children, className = "" }) {
  const generated = useId();
  const id = htmlFor ?? children?.props?.id ?? generated;
  const control = !htmlFor && isValidElement(children) && !children.props.id ? cloneElement(children, { id }) : children;
  return (
    <div className={`ui-field ${className}`.trim()}>
      {label && (
        <label className="ui-field__label" htmlFor={id}>
          {label}
        </label>
      )}
      {control}
      {error ? <span className="ui-field__error">{error}</span> : hint ? <span className="ui-field__hint">{hint}</span> : null}
    </div>
  );
}

/* Tooltip-ish icon button ------------------------------------------------ */

export function IconButton({ label, children, active = false, tone = "default", className = "", ...props }) {
  return (
    <button
      type="button"
      className={`ui-icon-button ${className}`.trim()}
      data-active={active || undefined}
      data-tone={tone}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

/* Media query ------------------------------------------------------------ */

// The phone layout is keyed to one width everywhere (CSS and JS alike), so a
// component that renders differently on phones reads it from here rather
// than repeating the number.
export const NARROW_QUERY = "(max-width: 760px)";

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/* Bottom sheet ----------------------------------------------------------- */

const SHEET_EXIT_MS = 280;

/**
 * A panel that rises from the bottom edge, for choices made on a phone where a
 * floating dropdown would be cramped and hard to reach. Stays mounted through
 * its exit so it slides back down instead of vanishing, and can be dragged
 * down by its handle to dismiss, the same way a native sheet can.
 */
export function BottomSheet({ open, onClose, title, children }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panelRef = useRef(null);
  const drag = useRef(null);
  useBackDismiss(open, onClose);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames: the first paints the sheet off-screen, the second flips
      // it to its resting position so the transition has a start to run from.
      let second;
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setShown(true)); });
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), SHEET_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      previous?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  const onPointerDown = (event) => {
    drag.current = { y: event.clientY, dy: 0, at: event.timeStamp };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!drag.current || !panelRef.current) return;
    drag.current.dy = Math.max(0, event.clientY - drag.current.y);
    panelRef.current.style.transition = "none";
    panelRef.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onPointerUp = (event) => {
    if (!drag.current || !panelRef.current) return;
    const { dy, at } = drag.current;
    drag.current = null;
    panelRef.current.style.transition = "";
    panelRef.current.style.transform = "";
    const velocity = dy / Math.max(1, event.timeStamp - at);
    if (dy > panelRef.current.offsetHeight * 0.3 || velocity > 0.6) onClose();
  };

  if (!mounted) return null;
  return createPortal(
    <div className="ui-sheet" data-shown={shown || undefined}>
      <div className="ui-sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className="ui-sheet__panel" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div
          className="ui-sheet__grab"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="ui-sheet__handle" aria-hidden="true" />
          {title && <h2 className="ui-sheet__title">{title}</h2>}
        </div>
        <div className="ui-sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
