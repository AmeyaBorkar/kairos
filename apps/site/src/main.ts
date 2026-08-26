/**
 * The site's entry point.
 *
 * Assembles four things and gets out of the way: the settings the reader owns, the router, the case
 * view's animation loop, and the console player. Each of those is independently testable and none of
 * them knows about the others — `main` is the only file that does.
 */

import { Stage } from "./case/stage.js";
import { type ConsolePlayer, mountConsole } from "./console/player.js";
import { readPalette } from "./palette.js";
import { Router, type View } from "./router.js";
import { mountSettings } from "./settings.js";
import { Aperture, type Speed } from "./transition.js";

/**
 * Whether the reader has asked for less motion.
 *
 * Read once at startup rather than watched. Everything downstream treats it as a constant, and a
 * mid-session change is rare enough that a reload is a fair price for not threading a live signal
 * through every scene.
 */
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The demo video lives in its own tab rather than inline.
 *
 * Empty until there is a recording to point at, and the link says so rather than pretending. A
 * navigation item that goes nowhere is worse than one that admits it.
 */
const DEMO_URL = "";

function wireDemoLink(): void {
  const link = document.getElementById("demo-link");
  if (!(link instanceof HTMLAnchorElement)) return;

  if (DEMO_URL !== "") {
    link.href = DEMO_URL;
    return;
  }
  link.textContent = "DEMO · SOON";
  link.setAttribute("aria-disabled", "true");
  link.style.opacity = ".5";
  link.addEventListener("click", (ev) => ev.preventDefault());
}

function main(): void {
  readPalette();

  const stage = new Stage(still);
  let console_: ConsolePlayer | null = null;

  const router = new Router((view: View) => {
    stage.repaintStatic();
    if (view === "console") console_?.onShown();
  });

  /* The tab transition. Off entirely under reduced motion — not shortened, not faded: a reader who
     asked for less motion gets the view swap and nothing else. */
  const wipeHost = document.getElementById("wipe");
  const wipeCanvas = document.getElementById("c-wipe");
  const wipeName = document.getElementById("wipe-name");
  const aperture =
    still || wipeHost === null || wipeName === null || !(wipeCanvas instanceof HTMLCanvasElement)
      ? null
      : new Aperture(wipeHost, wipeCanvas, wipeName);

  mountSettings(
    () => {
      // Palette and coarseness both change what is drawn, not merely what is styled.
      stage.repaintStatic();
    },
    (speed: Speed | null) => {
      if (aperture === null) return;
      if (speed === null) {
        // "OFF" is a real choice, and the honest way to honour it is to stop wrapping the swap.
        router.useTransition((_label, swap) => swap());
        return;
      }
      aperture.setSpeed(speed);
      router.useTransition((label, swap) => aperture.run(label, swap));
    },
  );

  wireDemoLink();
  router.start();

  // One loop for the whole page. The stage skips itself when another view is showing, and the player
  // only advances while it is playing, so an idle tab costs a bounding-box read per frame.
  const loop = (now: number): void => {
    if (router.view === "case") stage.frame();
    else if (router.view === "console") console_?.step(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // The console is data, so it arrives late and must not hold up the artwork.
  void mountConsole(still).then((player) => {
    console_ = player;
    if (router.view === "console") player?.onShown();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main, { once: true });
} else {
  main();
}
