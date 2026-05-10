import { useEffect, useRef } from 'react'

import Lenis from 'lenis'

// Wrap the Lenis smooth-scroll library (https://github.com/darkroomengineering/lenis,
// MIT, 3 KB) into a small hook that binds to a single scroll container.
//
// Why a custom hook + careful tuning, not just `<Lenis>` global:
//   • The Electron tray dropdown is a contained-scroll panel inside the
//     renderer; Lenis must be told its `wrapper` explicitly. The default
//     window-level binding doesn't apply.
//   • We pause Lenis when the BrowserWindow is hidden so the RAF loop
//     doesn't burn CPU while the panel is off-screen. macOS throttles
//     hidden renderers anyway, but explicit pause is defensive against
//     `setBackgroundThrottling(false)` configurations.
//   • We expose a single ref that callers attach to the scroll container
//     — no extra wrapper / content DOM nodes required (Lenis falls back
//     to native scrollTop when content is omitted).
//
// Performance note: with Lenis on, KEEP the existing `transform:
// translateZ(0)` + `contain: layout paint` rules from styles.css —
// Lenis writes scrollTop and the native compositor still benefits from
// our GPU-layer + bounded-repaint hints.

export interface UseLenisOptions {
  /** Inertia tightness 0..1. Smaller = stickier (slower deceleration).
   *  Lenis default is 0.1; we run a bit tighter so the small panel
   *  doesn't overshoot perceived intent. */
  lerp?: number
  /** Scale wheel deltas. <1 = less sensitive (good for trackpads). */
  wheelMultiplier?: number
  /** Cap velocity to avoid huge wheel kicks throwing the panel past its
   *  bounds. */
  duration?: number
}

export function useLenisScroll<T extends HTMLElement>(
  opts: UseLenisOptions = {},
): React.RefObject<T> {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (el === null) return

    const lenis = new Lenis({
      wrapper: el,
      // omit `content` — Lenis defaults to wrapper itself and writes
      // scrollTop directly, which keeps native scrollbars + focus working.
      lerp: opts.lerp ?? 0.08,
      duration: opts.duration ?? 1.0,
      wheelMultiplier: opts.wheelMultiplier ?? 0.9,
      smoothWheel: true,
      // Touch is rare in Electron menubar; leaving `syncTouch` off avoids
      // an unnecessary touch-event listener stack.
      syncTouch: false,
      // No autoRaf — we drive the RAF loop ourselves so we can pause it
      // on document.hidden without leaking the timer.
      autoRaf: false,
    })

    let rafId = 0
    const tick = (time: number): void => {
      lenis.raf(time)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    // Pause when the panel goes off-screen (BrowserWindow.hide() flips
    // document.visibilityState). Resume on focus back. Cheap belt-and-
    // suspenders insurance against background CPU drain.
    const onVisibility = (): void => {
      if (document.hidden) {
        lenis.stop()
        if (rafId !== 0) cancelAnimationFrame(rafId)
        rafId = 0
      } else {
        lenis.start()
        if (rafId === 0) rafId = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (rafId !== 0) cancelAnimationFrame(rafId)
      lenis.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return ref
}
