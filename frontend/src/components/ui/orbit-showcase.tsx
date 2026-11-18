import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"

import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

/*
 * Orbit showcase: a scroll-driven carousel in which one lit orb sits on the left and, when the slide changes, swings out
 * over the top on a wide orbit while the next swings in from the other side. The two-weight title wipes out and back in, the
 * detail card cross-fades, and a pale arc behind the scene turns and takes the slide's colour. The page scroll drives it: the
 * stage sticks and each stretch of scroll brings the next slide. Arrows, thumbnails, the side pager, arrow keys and swipes jump.
 *
 * Adapted from the supplied "Dish Orbit Carousel" (GSAP + ScrollTrigger) for the VibhavGPT home page. What changed, and why:
 *   - Food content is gone. The data is generic (OrbitSlide) and the home page supplies it (orbit-showcase-data.js).
 *   - The rating badge, chef card, likes and the search and menu buttons are gone: none of them is a fact about the product.
 *     The card shows a badge, where the model is included, an overview, a "Best for" list and the allowance wording.
 *   - "Play video" and "Order food" are real links (OrbitAction). Overview / Ingredients became Overview / Best for.
 *   - The embedded base64 font is gone. It uses the site's body face (--font-body: the platform's own).
 *   - Colours come from the page's theme tokens, and the stage is transparent so it sits on the page's own wash.
 *   - It never loops by default (loop = false), so scrolling always continues to the content below. Reduced motion turns the
 *     scroll-driven pinning off altogether and swaps slides without animation.
 *   - Nothing here touches window or document while rendering, so it is safe to import where there is no DOM.
 * The licence for GSAP is in ./LICENSES.md.
 */

if (typeof window !== "undefined") gsap.registerPlugin(ScrollTrigger)

export type OrbitSlide = {
  id: string
  /** The thin first title line. */
  title: string
  /** The heavy second title line. */
  subtitle: string
  /** Small line above the title. */
  eyebrow: string
  /** Label under the thumbnail. */
  label: string
  /** A transparent, roughly square image: the orb. */
  image: string
  alt: string
  /** Hex colour of the arc and the badge dot. */
  accent: string
  badge: { label: string; dot: string }
  /** Where it is included, e.g. "Included in Free, Plus and Pro". */
  availability: string
  overview: string
  bestFor: string[]
  /** One line about the allowance, in the pricing page's wording. */
  allowance: string
}

export type OrbitAction = { id: string; label: string; href: string }

export type OrbitShowcaseProps = {
  slides: readonly OrbitSlide[]
  actions?: readonly OrbitAction[]
  /** The stage's height, a definite length: percentages collapse on a host page. */
  height?: string
  /** Pixels between the top of the screen and the pinned stage, so a fixed bar can sit above it. */
  stickyTop?: number
  /** Scroll on forever: past the last slide comes the first again. Off by default; the page must always scroll on. */
  loop?: boolean
  /** Let the page scroll drive the slide. Always off under reduced motion. */
  scrollDriven?: boolean
  /** Stage heights of scroll per slide. */
  scrollPerSlide?: number
  ariaLabel?: string
  onChange?: (index: number) => void
  className?: string
}

// #region carousel
export function wrapIndex(i: number, n: number): number {
  if (n <= 0) return 0
  return ((Math.round(i) % n) + n) % n
}

/** Which way to swing when jumping from one slide to another: the shorter way round. */
export function stepDirection(from: number, to: number, n: number): 1 | -1 {
  if (n <= 0) return 1
  const fwd = (((to - from) % n) + n) % n
  return fwd <= n - fwd ? 1 : -1
}

/** Scroll stretches in the section: one per change of slide, plus one back round to the first when looping. */
export function scrollSteps(n: number, loop: boolean): number {
  return Math.max(0, loop ? n : n - 1)
}

/** The scroll stretch for slide `i` nearest the current one (when looping, slide 0 is also the last stretch). */
export function segmentFor(i: number, current: number, n: number, loop: boolean): number {
  return loop && i === 0 && current > n / 2 ? n : i
}

/** First thumbnail shown in the strip window, keeping the current one in view. */
export function stripStart(index: number, n: number, visible: number): number {
  if (n <= visible) return 0
  return Math.max(0, Math.min(index - 1, n - visible))
}

/** Title font size so a line of `chars` characters fits `width` px at `em` average glyph width. */
export function fitSize(chars: number, max: number, width: number, em: number): number {
  return Math.min(max, width / (Math.max(1, chars) * em))
}

/**
 * The pale band: a thick stroke along the orbs' circle, tapering at both ends. Angles in degrees, screen space
 * (0 = right, 90 = straight down).
 */
export function arcPath(a0: number, a1: number, cx: number, cy: number, r: number, w: number, steps = 48): string {
  const outer: string[] = []
  const inner: string[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = ((a0 + (a1 - a0) * t) * Math.PI) / 180
    const h = (w / 2) * Math.pow(Math.sin(Math.PI * t), 0.45)
    const c = Math.cos(a)
    const s = Math.sin(a)
    outer.push((cx + c * (r + h)).toFixed(1) + " " + (cy + s * (r + h)).toFixed(1))
    inner.push((cx + c * (r - h)).toFixed(1) + " " + (cy + s * (r - h)).toFixed(1))
  }
  return "M" + outer.join("L") + "L" + inner.reverse().join("L") + "Z"
}

/** Where the band rests for each slide, as [start, end] angles along the orbit. */
export const ARC_REST = [[50, 98], [46, 124], [60, 126], [40, 100]]
export function arcRest(index: number): number[] {
  return ARC_REST[((index % ARC_REST.length) + ARC_REST.length) % ARC_REST.length]
}

/** The band mid-swap: it stretches to trail between the outgoing and incoming orb. */
export const ARC_SWEEP = [38, 146]
// #endregion

// The orbs' circle: its pivot sits above the canvas (the .osh-orbit transform-origin).
const ORBIT_X = 299
const ORBIT_Y = -450
const ORBIT_R = 650
const SWING = 50 // degrees the orb travels round the pivot
const ITEM = 118 // thumbnail pitch in canvas px
const VISIBLE = 4

const CSS =
  ".osh-trk{position:relative;width:100%}" +
  // The stage is transparent so the page's own wash shows through: no seam in either theme.
  ".osh-root{--osh-fg:var(--color-foreground,var(--color-ink,#1c1612));--osh-bg:var(--color-background,var(--color-paper,#f6f0e6));" +
  "--osh-primary:var(--color-primary,var(--color-accent,#4f46e5));--osh-muted:var(--color-muted-foreground,var(--color-muted,#5a4e45));" +
  "--osh-rule:var(--color-rule,rgb(62 48 38/16%));--osh-focus:var(--color-focus,var(--osh-primary));" +
  "position:sticky;overflow:hidden;width:100%;color:var(--osh-fg);" +
  "font-family:var(--font-body,system-ui),system-ui,sans-serif;container-type:inline-size;-webkit-tap-highlight-color:transparent}" +
  ".osh-root *{box-sizing:border-box}" +
  ".osh-root:focus-visible{outline:2px solid var(--osh-focus);outline-offset:-4px}" +
  ".osh-canvas{position:absolute;left:50%;top:50%;width:960px;height:520px;transform:translate(-50%,-50%) scale(var(--osh-s,1));transform-origin:50% 50%}" +
  ".osh-arc{position:absolute;left:0;top:0;width:960px;height:520px;overflow:visible;pointer-events:none}" +
  ".osh-btn{appearance:none;border:0;background:none;color:inherit;font:inherit;padding:0;margin:0;cursor:pointer;text-decoration:none}" +
  ".osh-btn:focus-visible,.osh-act:focus-visible{outline:2px solid var(--osh-focus);outline-offset:3px;border-radius:10px}" +
  ".osh-pager{position:absolute;left:76px;top:172px;display:flex;flex-direction:column;align-items:center;gap:7px}" +
  ".osh-dot{width:24px;height:14px;display:grid;place-items:center;transition:height .45s cubic-bezier(.3,.7,.2,1)}" +
  ".osh-dot i{display:block;width:3px;height:3px;border-radius:3px;background:var(--osh-fg);opacity:.5;transition:height .45s cubic-bezier(.3,.7,.2,1),opacity .3s}" +
  ".osh-dot[aria-current]{height:30px}" +
  ".osh-dot[aria-current] i{height:22px;opacity:.95}" +
  ".osh-plates{position:absolute;left:130px;top:82px;width:245px;height:245px;touch-action:pan-y}" +
  ".osh-orbit{position:absolute;inset:0;transform-origin:69% -217%;visibility:hidden;will-change:transform}" +
  ".osh-orbit>img{display:block;width:245px;height:245px;max-width:none;object-fit:contain;user-select:none;-webkit-user-drag:none;" +
  "filter:drop-shadow(0 16px 22px rgba(0,0,0,.22)) drop-shadow(0 3px 5px rgba(0,0,0,.12))}" +
  ".osh-head{position:absolute;left:388px;top:96px;width:330px;height:150px}" +
  ".osh-hd{position:absolute;inset:0;visibility:hidden}" +
  ".osh-eye{font-size:12.5px;font-weight:600;letter-spacing:.01em;margin:0 0 4px 2px;color:var(--osh-muted)}" +
  ".osh-h{margin:0;font:inherit}" +
  ".osh-t1,.osh-t2{display:block;white-space:nowrap;line-height:1;text-transform:uppercase;margin:0}" +
  ".osh-t1{font-weight:200;letter-spacing:-.015em;margin-top:6px}" +
  ".osh-t2{font-weight:800;letter-spacing:-.025em;margin-top:6px}" +
  ".osh-acts{position:absolute;left:396px;top:280px;display:flex;gap:30px;font-size:13.5px;font-weight:600}" +
  ".osh-act{display:inline-flex;align-items:center;gap:9px;min-height:44px;padding:0 4px;color:var(--osh-fg);text-decoration:none}" +
  ".osh-act:hover{text-decoration:underline;text-underline-offset:5px}" +
  ".osh-ico{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}" +
  ".osh-card{position:absolute;left:722px;top:92px;width:223px;padding:16px 18px 18px;border-radius:20px;" +
  "background:color-mix(in oklab,var(--osh-bg) 74%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);" +
  "border:1px solid var(--osh-rule);box-shadow:0 18px 40px -24px rgba(0,0,0,.3)}" +
  ".osh-tabs{display:flex;gap:18px;padding:0 4px;font-size:12px;margin-bottom:14px}" +
  ".osh-tab{color:var(--osh-muted);font-weight:500;padding:5px 0;border-bottom:2px solid transparent}" +
  ".osh-tab[aria-selected=true]{color:var(--osh-fg);font-weight:700;border-bottom-color:var(--osh-fg)}" +
  ".osh-bodies{display:grid}" +
  ".osh-body{grid-area:1/1;visibility:hidden}" +
  ".osh-badge{display:inline-flex;align-items:center;gap:8px;padding:5px 11px 5px 9px;border-radius:99px;font-size:11.5px;font-weight:600;" +
  "background:color-mix(in oklab,var(--osh-fg) 7%,transparent)}" +
  ".osh-badge i{width:9px;height:9px;border-radius:50%;display:block;box-shadow:0 0 0 2px color-mix(in oklab,var(--osh-bg) 80%,transparent)}" +
  ".osh-name{font-size:19px;font-weight:700;letter-spacing:-.01em;margin:12px 0 0;line-height:1.15}" +
  ".osh-av{font-size:11.5px;color:var(--osh-muted);margin:4px 0 10px;font-weight:500}" +
  ".osh-desc{font-size:12.5px;line-height:1.4;margin:0;min-height:70px}" +
  ".osh-best{display:flex;flex-wrap:wrap;gap:5px;margin:0;padding:0;list-style:none;min-height:70px;align-content:flex-start}" +
  ".osh-best li{font-size:11.5px;padding:5px 10px;border-radius:99px;background:color-mix(in oklab,var(--osh-fg) 8%,transparent);font-weight:500}" +
  ".osh-allow{font-size:10.5px;line-height:1.4;color:var(--osh-muted);margin:12px 0 0;padding-top:10px;border-top:1px solid var(--osh-rule)}" +
  ".osh-strip{position:absolute;left:130px;top:362px;width:550px;height:122px;display:flex;align-items:center}" +
  ".osh-arrow{width:44px;height:44px;display:grid;place-items:center;flex:none}" +
  ".osh-arrow svg{width:12px;height:16px;fill:currentColor}" +
  ".osh-arrow[aria-disabled=true]{opacity:.3;cursor:default}" +
  ".osh-win{position:relative;width:" + ITEM * VISIBLE + "px;height:122px;overflow:hidden;flex:none;margin:0 2px;" +
  "-webkit-mask-image:linear-gradient(90deg,#000 88%,transparent);mask-image:linear-gradient(90deg,#000 88%,transparent)}" +
  ".osh-track{position:absolute;left:0;top:0;display:flex;transition:transform .6s cubic-bezier(.65,0,.35,1)}" +
  ".osh-th{width:" + ITEM + "px;height:122px;display:flex;justify-content:center;padding-top:3px}" +
  // A thumbnail outside the strip's window is clipped, so it is also not shown, focusable or read (six models need this; Slice 7).
  ".osh-th[data-out]{visibility:hidden}" +
  ".osh-th .osh-btn{width:80px;height:116px;border-radius:14px;display:flex;flex-direction:column;align-items:center;gap:7px;padding-top:9px;transition:background .45s}" +
  // Selected (Slice 6): the app's one selected pattern, a quiet ink tint and the label in full ink and weight. No paper-white
  // blob and no drop shadow behind the orb, and the orb is not scaled up.
  ".osh-th .osh-btn[aria-current]{background:var(--tint-hover,color-mix(in oklab,var(--osh-fg) 7%,transparent))}" +
  ".osh-th img{width:56px;height:56px;max-width:none;object-fit:contain;filter:drop-shadow(0 4px 6px rgba(0,0,0,.2));transition:transform .45s}" +
  ".osh-th span{font-size:11px;line-height:1.25;text-align:center;font-weight:600;color:var(--osh-muted);max-width:78px}" +
  ".osh-th .osh-btn[aria-current] span{color:var(--osh-fg);font-weight:700}" +
  ".osh-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}" +
  // Phone and tablet (a stage under 900px wide): the pinned stage has to fit one screen. The 960 x 520 design would be scaled down
  // to unreadable type here, so the stage stacks instead, centred: orb, title, actions, card, pager. The thumbnail strip is
  // hidden; the pager (a row of touch-sized dots below the card), swipes, the arrow keys and the scroll cover it.
  "@container (max-width:899px){" +
  ".osh-canvas{position:relative;left:auto;top:auto;width:100%;height:100%;transform:none;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 14px 6px}" +
  ".osh-arc{width:200%;height:auto;left:-60%;top:-30px}" +
  ".osh-pager{order:9;position:relative;left:auto;top:auto;flex-direction:row;gap:0;margin-top:2px;z-index:2}" +
  ".osh-dot{width:44px;height:32px}" +
  ".osh-dot i{width:14px;height:4px;border-radius:4px;transition:width .45s cubic-bezier(.3,.7,.2,1),opacity .3s}" +
  ".osh-dot[aria-current]{height:32px}" +
  ".osh-dot[aria-current] i{width:30px;height:4px}" +
  ".osh-plates{position:relative;left:auto;top:auto;flex:none;width:clamp(96px,min(50vw,27svh),230px);height:clamp(96px,min(50vw,27svh),230px)}" +
  ".osh-orbit>img{width:100%;height:100%}" +
  ".osh-head{position:relative;left:auto;top:auto;flex:none;width:100%;height:80px;margin-top:4px}" +
  ".osh-hd{text-align:center;transform:scale(.7);transform-origin:50% 0}" +
  ".osh-acts{position:relative;left:auto;top:auto;flex:none;margin-top:0;gap:22px}" +
  ".osh-card{position:relative;left:auto;top:auto;flex:0 1 auto;min-height:0;width:100%;max-width:400px;margin-top:4px;padding:10px 14px;overflow:hidden}" +
  ".osh-tabs{margin-bottom:8px}" +
  ".osh-name{margin-top:8px;font-size:17px}" +
  ".osh-av{margin:2px 0 6px}" +
  ".osh-desc,.osh-best{min-height:0}" +
  ".osh-allow{margin-top:6px;padding-top:6px}" +
  ".osh-strip{display:none}" +
  "}" +
  "@container (max-width:359px){" +
  ".osh-head{height:68px;margin-top:2px}" +
  ".osh-name{margin-top:4px;font-size:16px}" +
  ".osh-tabs{margin-bottom:6px}" +
  ".osh-card{padding:8px 12px}" +
  ".osh-av{margin:0 0 4px}" +
  "}" +
  // A tablet, 640 to 899px wide: the same stack with more room, so it is larger.
  "@container (min-width:640px) and (max-width:899px){" +
  ".osh-plates{width:clamp(180px,30svh,300px);height:clamp(180px,30svh,300px)}" +
  ".osh-head{height:128px;margin-top:10px}" +
  ".osh-hd{transform:scale(.95)}" +
  ".osh-card{max-width:460px;padding:16px 18px}" +
  ".osh-name{font-size:19px}" +
  ".osh-tabs{margin-bottom:12px}" +
  "}" +
  // A short phone (about 640px or less): a smaller orb and title, and the lines that repeat what the card's heading says go.
  "@media (max-width:639px) and (max-height:700px){" +
  ".osh-plates{width:clamp(80px,min(44vw,21svh),200px);height:clamp(80px,min(44vw,21svh),200px)}" +
  ".osh-head{height:70px;margin-top:2px}" +
  ".osh-hd{transform:scale(.58)}" +
  ".osh-eye{display:none}" +
  ".osh-acts{gap:16px}" +
  ".osh-act{min-height:40px}" +
  ".osh-av{display:none}" +
  ".osh-card{padding:10px 12px 10px}" +
  ".osh-tabs{margin-bottom:6px}" +
  ".osh-name{margin-top:6px;font-size:16px}" +
  ".osh-allow{font-size:10px;line-height:1.3;margin-top:6px;padding-top:6px}" +
  ".osh-dot{height:28px}" +
  "}" +
  // A short, wide screen (a phone or small tablet held sideways: under 900px wide, 520px tall or less). The tablet stack is far taller
  // than the pinned stage here, so the model's name and the actions were cut off. A smaller orb and title, the lines that repeat the
  // card's heading go, and the card keeps its content but scrolls within what is left, so nothing is clipped (owner request, 2026-11-16).
  "@media (max-width:899px) and (max-height:520px){" +
  ".osh-canvas{justify-content:flex-start;padding-top:2px}" +
  ".osh-plates{width:clamp(56px,24svh,120px);height:clamp(56px,24svh,120px)}" +
  ".osh-head{height:50px;margin-top:0}" +
  ".osh-hd{transform:scale(.46)}" +
  ".osh-eye{display:none}" +
  ".osh-av{display:none}" +
  ".osh-acts{gap:16px}" +
  ".osh-card{max-width:520px;max-height:max(72px,calc(100svh - 300px));overflow:auto;padding:8px 12px;margin-top:2px}" +
  ".osh-tabs{margin-bottom:4px}" +
  ".osh-name{margin-top:2px;font-size:15px}" +
  ".osh-pager{margin-top:0}" +
  ".osh-dot{height:26px}" +
  "}" +
  "@media (prefers-reduced-motion:reduce){.osh-track,.osh-dot,.osh-dot i,.osh-th .osh-btn,.osh-th img{transition:none}}"

const HIDE_1 = "inset(0% 0% 0% 100%)" // thin line: wipes in from the right
const HIDE_2 = "inset(0% 100% 0% 0%)" // heavy line: wipes in from the left
const SHOW = "inset(0% 0% 0% 0%)"

const REDUCED = "(prefers-reduced-motion: reduce)"
function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED)
  mq.addEventListener("change", onChange)
  return () => mq.removeEventListener("change", onChange)
}
/** True while the reader has asked for reduced motion. Server and first render say false. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED).matches, () => false)
}

const Icon = {
  arrow: <svg className="osh-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  plans: <svg className="osh-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" /></svg>,
}

export function OrbitShowcase({
  slides,
  actions = [],
  height = "100svh",
  stickyTop = 0,
  loop = false,
  scrollDriven = true,
  scrollPerSlide = 0.7,
  ariaLabel = "Models",
  onChange,
  className,
}: OrbitShowcaseProps) {
  const n = slides.length
  const reduced = usePrefersReducedMotion()
  const pinned = scrollDriven && !reduced
  const [index, setIndex] = useState(0)
  const [tab, setTab] = useState<"overview" | "best">("overview")

  const trackRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const stRef = useRef<ScrollTrigger | null>(null)
  const segRef = useRef(0)
  const indexRef = useRef(0)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const orbits = useRef<(HTMLDivElement | null)[]>([])
  const heads = useRef<(HTMLDivElement | null)[]>([])
  const bodies = useRef<(HTMLDivElement | null)[]>([])
  const arcRef = useRef<SVGPathElement | null>(null)
  const arc = useRef({ a0: 0, a1: 0 })
  const shown = useRef(-1)
  const dirRef = useRef<1 | -1>(1)
  const tlRef = useRef<gsap.core.Timeline | null>(null)
  const reducedRef = useRef(false)
  reducedRef.current = reduced
  const swipe = useRef<{ x: number; y: number } | null>(null)

  // Fit the 960 x 520 design canvas to the stage. Measured on resize only. On a phone the canvas is a column and is not scaled.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const fit = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      el.style.setProperty("--osh-s", String(Math.min(w / 960, h / 520, 1.6)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The swap. Every slide is in the DOM; GSAP only moves the outgoing and incoming ones.
  useLayoutEffect(() => {
    const from = shown.current
    const to = index
    const parts = (i: number) => {
      const head = heads.current[i]
      return {
        orbit: orbits.current[i],
        head,
        eye: head && head.querySelector(".osh-eye"),
        t1: head && head.querySelector(".osh-t1"),
        t2: head && head.querySelector(".osh-t2"),
        body: bodies.current[i],
      }
    }
    // Writes the band's path only; no layout is read.
    const drawArc = () => arcRef.current?.setAttribute("d", arcPath(arc.current.a0, arc.current.a1, ORBIT_X, ORBIT_Y, ORBIT_R, 118))
    const rest = arcRest(to)
    const tint = slides[to] ? slides[to].accent : "transparent"
    if (tlRef.current) tlRef.current.progress(1).kill()
    const b = parts(to)
    if (from === -1 || from === to || reducedRef.current) {
      for (let i = 0; i < n; i++) if (i !== to) {
        const p = parts(i)
        gsap.set([p.orbit, p.head, p.body], { autoAlpha: 0 })
      }
      gsap.set([b.orbit, b.head, b.body, b.eye], { autoAlpha: 1, rotation: 0, y: 0 })
      gsap.set(b.t1, { clipPath: SHOW })
      gsap.set(b.t2, { clipPath: SHOW })
      arc.current.a0 = rest[0]
      arc.current.a1 = rest[1]
      drawArc()
      if (arcRef.current) gsap.set(arcRef.current, { fill: tint })
      shown.current = to
      return
    }
    const a = parts(from)
    const d = dirRef.current
    const tl = gsap.timeline({ onComplete: () => { tlRef.current = null } })
    tlRef.current = tl
    // orb: out over the top on the orbit, the next one swings in from the far side
    tl.to(a.orbit, { rotation: SWING * d, duration: 0.62, ease: "power2.in" }, 0)
      .set(a.orbit, { autoAlpha: 0, rotation: 0 }, 0.62)
      .fromTo(b.orbit, { autoAlpha: 1, rotation: -SWING * d }, { rotation: 0, duration: 0.95, ease: "power3.out" }, 0.3)
    // title: thin line clips away to the right, heavy line to the left, then the next wipes in
    tl.to(a.t1, { clipPath: HIDE_1, duration: 0.42, ease: "power2.in" }, 0)
      .to(a.t2, { clipPath: HIDE_2, duration: 0.42, ease: "power2.in" }, 0.06)
      .to(a.eye, { autoAlpha: 0, duration: 0.25 }, 0)
      .set(a.head, { autoAlpha: 0 }, 0.5)
      .set(b.head, { autoAlpha: 1 }, 0.5)
      .fromTo(b.eye, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.4, ease: "power2.out" }, 0.55)
      .fromTo(b.t1, { clipPath: HIDE_1 }, { clipPath: SHOW, duration: 0.7, ease: "power3.out" }, 0.55)
      .fromTo(b.t2, { clipPath: HIDE_2 }, { clipPath: SHOW, duration: 0.7, ease: "power3.out" }, 0.62)
    // card: cross-fade, the incoming rows rise in turn
    tl.to(a.body, { autoAlpha: 0, y: -6, duration: 0.3, ease: "power1.in" }, 0.05)
      .set(b.body, { autoAlpha: 1, y: 0 }, 0.4)
    if (b.body) tl.fromTo(b.body.children, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.06, ease: "power2.out" }, 0.4)
    // the band stretches along the orbit with the orbs, then settles into the next slide's span, morphing colour
    tl.to(arc.current, { a0: ARC_SWEEP[0], a1: ARC_SWEEP[1], duration: 0.6, ease: "power2.inOut", onUpdate: drawArc }, 0)
      .to(arc.current, { a0: rest[0], a1: rest[1], duration: 0.85, ease: "power3.out", onUpdate: drawArc }, 0.6)
    if (arcRef.current) tl.to(arcRef.current, { fill: tint, duration: 1.1, ease: "power1.inOut" }, 0.1)
    shown.current = to
  }, [index, n, slides])

  useEffect(() => () => { tlRef.current?.kill() }, [])

  const select = (next: number, dir: 1 | -1) => {
    if (next === indexRef.current) return
    dirRef.current = dir
    indexRef.current = next
    setIndex(next)
    onChangeRef.current?.(next)
  }

  // The page scroll drives the slide: the stage sticks, one stretch of scroll per slide, snapping between them.
  const steps = pinned ? scrollSteps(n, loop) : 0
  useEffect(() => {
    const track = trackRef.current
    if (!track || steps < 1) return
    const trigger = ScrollTrigger.create({
      trigger: track,
      start: "top " + stickyTop + "px",
      end: "bottom bottom",
      snap: { snapTo: 1 / steps, duration: { min: 0.3, max: 0.8 }, delay: 0.08, ease: "power2.inOut" },
      onUpdate: (self) => {
        // Looping only: the last stretch shows the first slide, so jump back to the top unseen.
        if (loop && self.progress >= 1 && self.direction > 0) {
          segRef.current = 0
          self.scroll(self.start + 1)
          select(0, 1)
          return
        }
        const seg = Math.round(self.progress * steps)
        if (seg === segRef.current) return
        const dir = seg > segRef.current ? 1 : -1
        segRef.current = seg
        select(wrapIndex(seg, n), dir)
      },
    })
    // Looping only: at the very top no scroll is left to fire onUpdate, so scrolling up there wraps round to the last slide.
    let raf = 0
    const onWheel = (e: WheelEvent) => {
      const y = trigger.scroll()
      if (!loop || e.deltaY >= 0 || y < trigger.start - 1 || y > trigger.start + 1) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        segRef.current = n - 1
        trigger.scroll(trigger.start + ((trigger.end - trigger.start) * (n - 1)) / steps)
        select(n - 1, -1)
      })
    }
    if (loop) window.addEventListener("wheel", onWheel, { passive: true })
    stRef.current = trigger
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("wheel", onWheel)
      trigger.kill()
      stRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, loop, n, stickyTop])

  // Buttons, keys and swipes jump to a slide and move the scroll to its stretch, so the two stay in step.
  const go = (to: number, dir?: 1 | -1) => {
    if (n < 2) return
    const next = wrapIndex(to, n)
    if (next === index) return
    const st = stRef.current
    const y = st ? st.scroll() : 0
    if (st && steps > 0 && y >= st.start - 1 && y <= st.end + 1) {
      const seg = segmentFor(next, segRef.current, n, loop)
      segRef.current = seg
      st.scroll(st.start + ((st.end - st.start) * seg) / steps)
    }
    select(next, dir ?? stepDirection(index, next, n))
  }
  // Arrow buttons and keys stop at the ends unless looping, like the scroll does.
  const step = (d: 1 | -1) => {
    const to = index + d
    if (!loop && (to < 0 || to > n - 1)) return
    go(to, d)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowRight") { e.preventDefault(); step(1) }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1) }
  }
  const onPointerDown = (e: ReactPointerEvent) => { swipe.current = { x: e.clientX, y: e.clientY } }
  const onPointerUp = (e: ReactPointerEvent) => {
    const s = swipe.current
    swipe.current = null
    if (!s) return
    const dx = e.clientX - s.x
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.4) step(dx < 0 ? 1 : -1)
  }

  const start = stripStart(index, n, VISIBLE)
  const slide = slides[index]

  return (
    <div
      ref={trackRef}
      className={"osh-trk" + (className ? " " + className : "")}
      style={{ height: "calc(" + height + " * " + (1 + steps * scrollPerSlide) + ")" }}
    >
      <div
        ref={rootRef}
        className="osh-root"
        style={{ height, top: stickyTop }}
        role="region"
        aria-roledescription="carousel"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <style>{CSS}</style>

        <div className="osh-canvas">
          <svg className="osh-arc" viewBox="0 0 960 520" aria-hidden="true">
            <path ref={arcRef} style={{ opacity: 0.34 }} />
          </svg>

          <div className="osh-pager" role="group" aria-label="Choose a model">
            {slides.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className="osh-btn osh-dot"
                aria-current={i === index ? "true" : undefined}
                aria-label={"Show " + s.subtitle}
                onClick={() => go(i)}
              >
                <i />
              </button>
            ))}
          </div>

          <div className="osh-plates" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { swipe.current = null }}>
            {slides.map((s, i) => (
              <div key={s.id} ref={(el) => { orbits.current[i] = el }} className="osh-orbit" aria-hidden={i !== index}>
                <img src={s.image} alt={i === index ? s.alt : ""} width={245} height={245} draggable={false} decoding="async" />
              </div>
            ))}
          </div>

          <div className="osh-head">
            {slides.map((s, i) => (
              <div key={s.id} ref={(el) => { heads.current[i] = el }} className="osh-hd" aria-hidden={i !== index}>
                <p className="osh-eye">{s.eyebrow}</p>
                <h3 className="osh-h">
                  <span className="osh-t1" style={{ fontSize: fitSize(s.title.length, 56, 330, 0.56) + "px" }}>{s.title}</span>
                  <span className="osh-t2" style={{ fontSize: fitSize(s.subtitle.length, 62, 320, 0.64) + "px" }}>{s.subtitle}</span>
                </h3>
              </div>
            ))}
          </div>

          <div className="osh-acts">
            {actions.map((action, i) => (
              <a key={action.id} className="osh-act" href={action.href}>
                {i === 0 ? Icon.arrow : Icon.plans}
                {action.label}
              </a>
            ))}
          </div>

          <div className="osh-card">
            <div className="osh-tabs" role="tablist" aria-label="Model details">
              {(["overview", "best"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  id={"osh-tab-" + t}
                  className="osh-btn osh-tab"
                  aria-selected={tab === t}
                  aria-controls="osh-panel"
                  onClick={() => setTab(t)}
                >
                  {t === "overview" ? "Overview" : "Best for"}
                </button>
              ))}
            </div>
            <div className="osh-bodies" role="tabpanel" id="osh-panel" aria-labelledby={"osh-tab-" + tab}>
              {slides.map((s, i) => (
                <div key={s.id} ref={(el) => { bodies.current[i] = el }} className="osh-body" aria-hidden={i !== index}>
                  <span className="osh-badge"><i style={{ background: s.badge.dot }} aria-hidden="true" />{s.badge.label}</span>
                  <p className="osh-name">{s.title + " " + s.subtitle}</p>
                  <p className="osh-av">{s.availability}</p>
                  {tab === "overview" ? (
                    <p className="osh-desc">{s.overview}</p>
                  ) : (
                    <ul className="osh-best">{s.bestFor.map((x) => <li key={x}>{x}</li>)}</ul>
                  )}
                  <p className="osh-allow">{s.allowance}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="osh-strip">
            <button type="button" className="osh-btn osh-arrow" aria-label="Previous model" aria-disabled={!loop && index === 0 ? "true" : undefined} onClick={() => step(-1)}>
              <svg viewBox="0 0 12 16" aria-hidden="true"><path d="M11 0v16L0 8z" /></svg>
            </button>
            <div className="osh-win">
              <div className="osh-track" style={{ transform: "translateX(" + -start * ITEM + "px)" }}>
                {slides.map((s, i) => {
                  const out = n > VISIBLE && (i < start || i >= start + VISIBLE)
                  return (
                    <div key={s.id} className="osh-th" data-out={out ? "" : undefined} aria-hidden={out ? "true" : undefined} inert={out ? true : undefined}>
                      <button type="button" className="osh-btn" aria-current={i === index ? "true" : undefined} aria-label={"Show " + s.subtitle} onClick={() => go(i)}>
                        <img src={s.image} alt="" width={56} height={56} draggable={false} loading="lazy" decoding="async" />
                        <span>{s.label}</span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
            <button type="button" className="osh-btn osh-arrow" aria-label="Next model" aria-disabled={!loop && index === n - 1 ? "true" : undefined} onClick={() => step(1)}>
              <svg viewBox="0 0 12 16" aria-hidden="true"><path d="M1 0v16l11-8z" /></svg>
            </button>
          </div>
        </div>
        <p className="osh-sr" aria-live="polite">{slide ? "Model " + (index + 1) + " of " + n + ": " + slide.title + " " + slide.subtitle : ""}</p>
      </div>
    </div>
  )
}

export default OrbitShowcase
