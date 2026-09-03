/**
 * Six views in one document, addressed by hash.
 *
 * A hash router rather than a real one because the site is static and has to work when opened from
 * a file, dropped on any static host, or served from a subdirectory. There is no server to teach
 * about routes and no build step that would need to know the deploy path.
 */

export const VIEWS = ["case", "film", "console", "install", "how", "benchmarks"] as const;
export type View = (typeof VIEWS)[number];

export const DEFAULT_VIEW: View = "case";

function isView(value: string): value is View {
  return (VIEWS as readonly string[]).includes(value);
}

/** Wraps the swap: cover the screen, call `swap` when nothing can be seen, then uncover. */
export type Transition = (label: string, swap: () => void) => void;

export class Router {
  #view: View = DEFAULT_VIEW;
  readonly #onShow: (view: View) => void;
  readonly #links: HTMLElement[];
  #transition: Transition | null = null;

  constructor(onShow: (view: View) => void) {
    this.#onShow = onShow;
    this.#links = [...document.querySelectorAll<HTMLElement>(".nav-link[data-view]")];

    for (const link of this.#links) {
      link.addEventListener("click", () => {
        const target = link.dataset["view"] ?? DEFAULT_VIEW;
        if (isView(target)) this.show(target, true);
      });
    }

    // Anything anywhere on the page can send the reader to a view; the question panels use it to
    // hand off to the evidence rather than repeating it.
    for (const jump of document.querySelectorAll<HTMLElement>("[data-goto]")) {
      jump.addEventListener("click", (ev) => {
        ev.preventDefault();
        const target = jump.dataset["goto"] ?? DEFAULT_VIEW;
        if (isView(target)) this.show(target, true);
      });
    }

    window.addEventListener("hashchange", () => this.show(this.fromHash(), false));
  }

  get view(): View {
    return this.#view;
  }

  /** Install a transition. Until one is set — and on the first paint — views swap instantly. */
  useTransition(transition: Transition): void {
    this.#transition = transition;
  }

  /** What the transition announces while the screen is covered. */
  #labelFor(view: View): string {
    const link = this.#links.find((l) => l.dataset["view"] === view);
    return (link?.textContent ?? view).trim().toUpperCase();
  }

  fromHash(): View {
    const raw = (window.location.hash || `#${DEFAULT_VIEW}`).slice(1);
    return isView(raw) ? raw : DEFAULT_VIEW;
  }

  start(): void {
    this.show(this.fromHash(), false);
  }

  show(next: View, push: boolean): void {
    // No transition on the first paint, and none when the view has not actually changed: an
    // animation that plays on arrival is an animation nobody asked for.
    if (this.#transition !== null && push && next !== this.#view) {
      const run = this.#transition;
      run(this.#labelFor(next), () => this.#apply(next, push));
      return;
    }
    this.#apply(next, push);
  }

  #apply(next: View, push: boolean): void {
    this.#view = next;

    for (const name of VIEWS) {
      const node = document.getElementById(`view-${name}`);
      if (node === null) continue;
      if (name === next) node.removeAttribute("hidden");
      else node.setAttribute("hidden", "");
    }

    for (const link of this.#links) {
      if (link.dataset["view"] === next) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }

    // A view that opens halfway down is a view the reader has to re-find.
    window.scrollTo(0, 0);

    if (push && window.location.hash !== `#${next}`) {
      try {
        history.replaceState(null, "", `#${next}`);
      } catch {
        // Opened from a file URL, where replaceState is refused. The view still switched.
      }
    }

    this.#onShow(next);
  }
}
