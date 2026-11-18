import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, Info, X } from "lucide-react";
import "./ui/banner.css";
import { createSpring, createVelocityTracker, project, rubberband, prefersReducedMotion, SPRINGS } from "../motion/spring.js";

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
        // Escape inside an open submenu closes just the submenu (MenuSub handles it); the next Escape closes the menu.
        if (event.target instanceof Element && event.target.closest(".ui-menu__submenu")) return;
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
    // "workspace": past the sidebar's own right edge when the trigger sits in one, otherwise past the trigger, so the menu opens over the
    // main content and never covers the sidebar it came from.
    const sidebarEdge = anchorRef.current?.closest(".sidebar")?.getBoundingClientRect().right;
    const workspaceEdge = Math.max(anchor.right, sidebarEdge ?? anchor.right);
    const rawLeft = align === "end" ? anchor.right - (width ?? panel.width) : align === "workspace" ? workspaceEdge + gap : anchor.left;
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

/* Presence --------------------------------------------------------------- */

// Keeps a popover mounted through its exit, so closing has a path to play
// and reopening mid-exit reverses from wherever it is: `shown` drives a CSS
// transition, and CSS transitions restart from the current computed value
// when retargeted. The panel is inert while it leaves.
const POPOVER_EXIT_MS = 160;
export function usePresence(open, exitMs = POPOVER_EXIT_MS) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const present = useRef(open);
  // Reopened while still leaving: the element is on screen mid-exit, so flip
  // it back before the next paint and the transition reverses from where it
  // is. A layout effect, not a passive one: passive effects run after paint,
  // and on a busy machine that was measured at up to 100ms late, nearly the
  // whole exit, during which the menu kept closing under the user's click.
  useLayoutEffect(() => {
    if (open && present.current) setShown(true);
  }, [open]);
  useEffect(() => {
    if (open) {
      if (present.current) return undefined;
      present.current = true;
      setMounted(true);
      // A fresh mount spends one frame in the closed state, so the entrance
      // has a start.
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const timer = setTimeout(() => { present.current = false; setMounted(false); }, exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs]);
  return { mounted: mounted || open, shown: shown && open };
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
// Consecutive options that share a `group` ({ id, label }) form one section; ungrouped options stay as plain rows. Indexes stay flat,
// so keyboard movement and typeahead run straight through the groups.
function optionSections(options) {
  const sections = [];
  options.forEach((option, index) => {
    const group = option.group ?? null;
    const last = sections.at(-1);
    if (last && (last.group?.id ?? null) === (group?.id ?? null)) last.items.push({ option, index });
    else sections.push({ group, divider: sections.length > 0, items: [{ option, index }] });
  });
  return sections;
}

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
  footer,
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const anchorRef = useRef(null);
  const panelRef = useRef(null);
  const typeaheadRef = useRef({ query: "", at: 0 });
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, [anchorRef, panelRef]);
  const presence = usePresence(open);
  const floating = useFloatingPosition(presence.mounted, anchorRef, panelRef, { placement, align });
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
      {presence.mounted &&
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
            data-state={presence.shown ? "open" : "closed"}
            inert={!open || undefined}
            style={floating.style}
          >
            {optionSections(options).map((section) => {
              const rows = section.items.map(({ option, index }) => (
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
              ));
              if (!section.group) return rows;
              // A labelled group (the model picker's providers): a divider, then a quiet label naming the group. Not a heading.
              return (
                <div key={`group:${section.group.id}`} role="group" aria-label={section.group.label} className="ui-select__group" data-group={section.group.id}>
                  {section.divider && <div className="ui-menu__separator" role="separator" />}
                  {section.group.label && <div className="ui-select__group-label" aria-hidden="true">{section.group.label}</div>}
                  {rows}
                </div>
              );
            })}
            {typeof footer === "function" ? footer({ close }) : footer}
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
  // When the menu closes while focus is inside it (Escape, or a row chosen by keyboard), focus goes back to the trigger, as a
  // person expects. An outside pointer press still lands wherever the press lands, because that focus change comes after this.
  const close = useCallback(() => {
    const focusWasInside = panelRef.current?.contains(document.activeElement);
    setOpen(false);
    if (focusWasInside) anchorRef.current?.focus();
  }, []);
  useDismiss(open, close, [anchorRef, panelRef]);
  const presence = usePresence(open);
  const floating = useFloatingPosition(presence.mounted, anchorRef, panelRef, { placement, align });
  const context = useMemo(() => ({ close }), [close]);

  useEffect(() => {
    // Waits on floating.ready and presence.shown, not just `open`: the panel spends its first
    // render under a `visibility: hidden` fallback style (see
    // useFloatingPosition) until it has actually been measured and
    // positioned, and a fresh mount stays in its closed state for one frame (usePresence).
    // An element can't take focus while either is in effect.
    // Focus lands on the next frame, after the browser has laid the panel out: Chromium can still refuse focus on the frame it
    // first shows a panel, even once the closed state has been left.
    if (!(open && floating.ready && presence.shown)) return undefined;
    // The first row can still be unfocusable on the frame the panel appears (with reduced motion, every transition is near-instant
    // and the row may not yet be visible when asked). Try again on the next frames until focus lands, for at most ~10 frames.
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      panel.querySelector("[role^='menuitem']:not([disabled])")?.focus();
      if (!panel.contains(document.activeElement) && (tries += 1) < 10) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [open, floating.ready, presence.shown]);

  function onPanelKeyDown(event) {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    // Arrow keys walk this menu's own rows; a submenu's rows are walked inside the submenu (MenuSub).
    const items = [...panelRef.current.querySelectorAll("[role^='menuitem']:not([disabled])")].filter((item) => !item.closest(".ui-menu__submenu"));
    const current = items.indexOf(document.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(current + delta + items.length) % items.length]?.focus();
  }

  return (
    <div className={`ui-menu ${className}`.trim()}>
      {trigger({ ref: anchorRef, open, toggle: () => setOpen((value) => !value) })}
      {presence.mounted &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label={label}
            className={`ui-popover ui-menu__panel ${panelClassName}`.trim()}
            data-placement={floating.placement}
            data-align={align}
            data-state={presence.shown ? "open" : "closed"}
            inert={!open || undefined}
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
export function MenuItem({ icon, children, onSelect, tone = "default", disabled = false, hint, href, target = "_blank", description, selected, trailing, checked }) {
  const menu = useContext(MenuContext);
  const Item = href ? "a" : "button";
  const choice = typeof selected === "boolean";
  // A switch: on or off, announced as such, and the menu stays open so the new state can be seen.
  const toggle = typeof checked === "boolean";
  return (
    <Item
      {...(href ? { href, target, ...(target === "_blank" ? { rel: "noopener noreferrer" } : {}) } : { type: "button" })}
      role={toggle ? "menuitemcheckbox" : choice ? "menuitemradio" : "menuitem"}
      {...(toggle ? { "aria-checked": checked } : choice ? { "aria-checked": selected } : {})}
      className="ui-menu__item"
      data-tone={tone}
      data-rich={description ? "" : undefined}
      disabled={disabled}
      onClick={(event) => {
        if (!toggle) menu?.close();
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
      {toggle && <span className="ui-menu__switch" data-on={checked || undefined} aria-hidden="true" />}
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

// A set of rows with an accessible name. Groups are told apart by a hairline between them, not by a visible heading (no eyebrow
// labels); `showLabel` draws the name for a menu that needs one.
export function MenuGroup({ label, showLabel = false, children }) {
  return (
    <div className="ui-menu__group" role="group" aria-label={label}>
      {showLabel && <div className="ui-menu__label" aria-hidden="true">{label}</div>}
      {children}
    </div>
  );
}

// A row with a chevron that opens a second list beside it. Opens on click, on the pointer resting over it, and on ArrowRight;
// ArrowLeft and Escape close just the submenu and put focus back on the row. Choosing something inside it closes the whole menu
// (MenuItem does that through the shared context). The list flips to the left if it would run off the right edge.
export function MenuSub({ icon, label, children, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const wrapperRef = useRef(null);
  const rowRef = useRef(null);
  const subRef = useRef(null);
  const id = useId();
  const focusFirst = () => requestAnimationFrame(() => subRef.current?.querySelector("[role^='menuitem']:not([disabled])")?.focus());
  useLayoutEffect(() => {
    if (!open) { setFlip(false); return; }
    const rect = subRef.current?.getBoundingClientRect();
    if (rect && rect.right > window.innerWidth - 8) setFlip(true);
  }, [open]);
  function onSubKeyDown(event) {
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      rowRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const items = [...subRef.current.querySelectorAll("[role^='menuitem']:not([disabled])")];
      const current = items.indexOf(document.activeElement);
      items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  }
  return (
    <div
      ref={wrapperRef}
      className="ui-menu__sub"
      data-open={open || undefined}
      onPointerEnter={(event) => { if (event.pointerType === "mouse" && !disabled) setOpen(true); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse" && !wrapperRef.current?.contains(document.activeElement)) setOpen(false); }}
    >
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className="ui-menu__item ui-menu__item--sub"
        disabled={disabled}
        onClick={(event) => { setOpen(true); if (event.detail === 0) focusFirst(); }}
        onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); setOpen(true); focusFirst(); } }}
      >
        {icon && <span className="ui-menu__icon" aria-hidden="true">{icon}</span>}
        <span className="ui-menu__text"><span className="ui-menu__name">{label}</span></span>
        <ChevronRight className="ui-menu__chevron" size={15} aria-hidden="true" />
      </button>
      {open && (
        <div ref={subRef} id={id} role="menu" aria-label={label} className="ui-menu__submenu" data-flip={flip || undefined} onKeyDown={onSubKeyDown}>
          {children}
        </div>
      )}
    </div>
  );
}

/* Segmented control ------------------------------------------------------ */

export function Segmented({ value, onChange, options, label, size = "md", className = "", disabled = false }) {
  const listRef = useRef(null);
  // The selection indicator slides to the chosen option. Its position is a
  // CSS transition on transform and width, so a new choice made while it is
  // still moving retargets from where it is now instead of jumping.
  const [indicator, setIndicator] = useState(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const chosen = list?.querySelector(`[data-value="${CSS.escape(String(value))}"]`);
    if (!list || !chosen) { setIndicator(null); return undefined; }
    const place = () => setIndicator({ x: chosen.offsetLeft, w: chosen.offsetWidth, h: chosen.offsetHeight, y: chosen.offsetTop });
    place();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(list);
    return () => observer?.disconnect();
  }, [value, options.length]);
  function onKeyDown(event) {
    if (disabled || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
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
      aria-disabled={disabled || undefined}
      className={`ui-segmented ui-segmented--${size} ${className}`.trim()}
      data-indicator={indicator ? "" : undefined}
      onKeyDown={onKeyDown}
    >
      {indicator && <span className="ui-segmented__indicator" aria-hidden="true" style={{ transform: `translate(${indicator.x}px, ${indicator.y}px)`, width: indicator.w, height: indicator.h }} />}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className="ui-segmented__option"
          disabled={disabled}
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

/* Banner ----------------------------------------------------------------- */

const BANNER_TONES = {
  info: { Icon: Info, word: "Note" },
  warning: { Icon: AlertTriangle, word: "Warning" },
  error: { Icon: AlertCircle, word: "Error" },
  success: { Icon: CheckCircle2, word: "Done" },
};

// The one notice (banner.css). The tone is said by an icon and a word as well as a tint: the title when there is one, otherwise the
// tone's own word. One clear action; dismissing is a labelled icon button. Errors are announced at once (alert), the rest politely.
// `help`: what the notice means and what to do about it, specific to that notice. The icon then becomes a button: hovering or focusing it
// shows the help, a click or tap keeps it open, and Escape or the close button hides it. The help opens inside the banner, below its
// text, so it is never clipped and never covers another control; a hover or focus preview floats just above the notice instead, so the
// notice keeps its size (and the icon stays under the pointer) while it is only previewed. Without `help` the icon stays decorative.
export function Banner({ tone = "info", icon: IconOverride, title, children, action, onDismiss, dismissLabel = "Dismiss", className = "", classNames = {}, live, help = null }) {
  const { Icon, word } = BANNER_TONES[tone] ?? BANNER_TONES.info;
  const ShownIcon = IconOverride ?? Icon;
  const [pinned, setPinned] = useState(false);
  const [peek, setPeek] = useState(false);
  const helpId = useId();
  const shown = Boolean(help) && (pinned || peek);
  const close = () => { setPinned(false); setPeek(false); };
  return (
    <div className={`ui-banner ${className}`.trim()} data-tone={tone} role={live ?? (tone === "error" ? "alert" : "status")} onKeyDown={help ? (event) => { if (event.key === "Escape" && shown) { event.stopPropagation(); close(); } } : undefined}>
      {help ? (
        <button
          type="button"
          className={`ui-banner__icon ui-banner__help-toggle ${classNames.icon ?? ""}`.trim()}
          aria-label={`What this notice means: ${typeof title === "string" ? title : word}`}
          aria-expanded={shown}
          aria-controls={helpId}
          onClick={() => { setPinned((value) => !value); setPeek(false); }}
          onMouseEnter={() => setPeek(true)}
          onMouseLeave={() => setPeek(false)}
          onFocus={() => setPeek(true)}
          onBlur={() => setPeek(false)}
        ><ShownIcon aria-hidden="true" /></button>
      ) : (
        <span className={`ui-banner__icon ${classNames.icon ?? ""}`.trim()} aria-hidden="true"><ShownIcon /></span>
      )}
      <div className={`ui-banner__body ${classNames.body ?? ""}`.trim()}>
        <strong className={`ui-banner__title ${classNames.title ?? ""}`.trim()}>{title ?? word}</strong>
        {children && <p className={`ui-banner__text ${classNames.text ?? ""}`.trim()}>{children}</p>}
        {help && (
          <div id={helpId} className="ui-banner__help" role="note" hidden={!shown} data-mode={pinned ? "pinned" : "peek"}>
            <p>{help}</p>
            {pinned && <button type="button" className="ui-banner__help-close" onClick={close}>Close help</button>}
          </div>
        )}
      </div>
      {(action || onDismiss) && (
        <div className={`ui-banner__actions ${classNames.actions ?? ""}`.trim()}>
          {action}
          {onDismiss && (
            <button type="button" className={`ui-banner__dismiss ${classNames.dismiss ?? ""}`.trim()} aria-label={dismissLabel} onClick={onDismiss}>
              <X aria-hidden="true" />
            </button>
          )}
        </div>
      )}
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
    // Focus moves into the dialog (an autofocused field keeps it).
    const frame = requestAnimationFrame(() => {
      if (panelRef.current && !panelRef.current.contains(document.activeElement)) {
        panelRef.current.querySelector("[autofocus], input:not([disabled]), textarea:not([disabled]), select, button:not([disabled])")?.focus();
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const Panel = onSubmit ? "form" : "div";
  return createPortal(
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
    </div>,
    document.body,
  );
}

/* Field ------------------------------------------------------------------ */

/**
 * Labels its control by id rather than by wrapping it, so a custom control
 * built from a <button> is not nested inside a <label> that also targets it.
 * A child that already carries an id keeps it.
 */
export function Field({ label, hint, error, htmlFor, aside, children, className = "" }) {
  const generated = useId();
  const id = htmlFor ?? children?.props?.id ?? generated;
  const control = !htmlFor && isValidElement(children) && !children.props.id ? cloneElement(children, { id }) : children;
  return (
    <div className={`ui-field ${className}`.trim()}>
      {label && aside ? (
        <div className="ui-field__row">
          <label className="ui-field__label" htmlFor={id}>{label}</label>
          {aside}
        </div>
      ) : label && (
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
 * its exit so it slides back down instead of vanishing.
 *
 * Its handle drags it the way a native sheet drags (the Apple Design skill):
 * 1:1 under the finger from where it was grabbed, with progressive
 * resistance when pulled up past its resting place; on release the last
 * ~90ms give the velocity, the resting place is projected from it, and a
 * spring carries that velocity either back home or off the bottom edge.
 * Grabbing it again while it is still settling catches it where it is.
 */
export function BottomSheet({ open, onClose, title, children }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panelRef = useRef(null);
  const drag = useRef(null);
  const tracker = useRef(createVelocityTracker());
  const spring = useRef(null);
  // Set while the sheet is on its way out after a release. It closes when it
  // has actually left the screen, not after a fixed delay, so it can be
  // caught for its whole visible travel however long a frame takes.
  const dismissing = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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

  useEffect(() => () => spring.current?.stop(), []);

  const paint = (y) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transition = "none";
    panel.style.transform = `translateY(${y}px)`;
    // While script owns the sheet, a touch anywhere on it is a catch, not
    // the start of a scroll.
    panel.style.touchAction = "none";
  };
  const release = () => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.removeProperty("transition");
    panel.style.removeProperty("transform");
    panel.style.removeProperty("touch-action");
  };
  const getSpring = () => {
    spring.current ??= createSpring({
      onUpdate: (y) => {
        paint(y);
        if (dismissing.current && panelRef.current && y >= panelRef.current.offsetHeight) {
          dismissing.current = false;
          spring.current.stop();
          onCloseRef.current();
        }
      },
    });
    return spring.current;
  };
  // Where the panel actually is now, including mid-settle or mid-transition.
  const currentY = () => {
    const panel = panelRef.current;
    if (!panel) return 0;
    if (spring.current?.running) return spring.current.value;
    const transform = getComputedStyle(panel).transform;
    return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
  };

  // At rest, a drag starts from the grab strip, so the body keeps its taps
  // and scrolling. While the sheet is moving (settling back, or on its way
  // out), the whole panel is catchable: a finger reaching for a falling sheet
  // lands wherever the sheet is, not on a 30px strip.
  const onPointerDown = (event) => {
    const moving = Boolean(spring.current?.running);
    if (!moving && !event.target.closest?.(".ui-sheet__grab")) return;
    const y0 = currentY();
    // A sheet caught on its way out belongs to the finger again: it is no
    // longer closing, and this drag decides afresh.
    dismissing.current = false;
    spring.current?.stop();
    paint(y0);
    drag.current = { pointerY: event.clientY, startY: y0, y: y0 };
    tracker.current.reset();
    tracker.current.add(event.clientY, event.timeStamp);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!drag.current || !panelRef.current) return;
    tracker.current.add(event.clientY, event.timeStamp);
    const raw = drag.current.startY + (event.clientY - drag.current.pointerY);
    // Upward, past home, it resists; downward it follows exactly.
    const y = raw < 0 ? rubberband(raw, panelRef.current.offsetHeight) : raw;
    drag.current.y = y;
    paint(y);
  };
  const onPointerUp = () => {
    const current = drag.current;
    drag.current = null;
    if (!current || !panelRef.current) return;
    // A drag is not also a tap. Grabbed by its body, the row under the
    // finger travels with it, so the release lands on the same row and some
    // engines (Firefox) fire a click there that would pick it.
    if (Math.abs(current.y - current.startY) > 6) {
      const panel = panelRef.current;
      const swallow = (event) => { event.stopPropagation(); event.preventDefault(); };
      panel.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => panel.removeEventListener("click", swallow, { capture: true }), 0);
    }
    const height = panelRef.current.offsetHeight;
    const velocity = tracker.current.velocity;
    const projected = current.y + project(velocity);
    const dismiss = projected > height * 0.5;
    if (prefersReducedMotion()) { release(); if (dismiss) onClose(); return; }
    const motion = getSpring();
    motion.set(current.y);
    if (dismiss) {
      // Off the bottom edge with the finger's own speed; it closes as it
      // leaves the screen (see getSpring).
      dismissing.current = true;
      motion.to(height + 24, { velocity: Math.max(velocity, 600), ...SPRINGS.standard });
    } else {
      motion.to(0, { velocity, ...(Math.abs(velocity) > 400 ? SPRINGS.thrown : SPRINGS.standard) });
      const settleCheck = () => { if (motion.running) requestAnimationFrame(settleCheck); else if (!drag.current) release(); };
      requestAnimationFrame(settleCheck);
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div className="ui-sheet" data-shown={shown || undefined}>
      <div className="ui-sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="ui-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="ui-sheet__grab">
          <span className="ui-sheet__handle" aria-hidden="true" />
          {title && <h2 className="ui-sheet__title">{title}</h2>}
        </div>
        <div className="ui-sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
