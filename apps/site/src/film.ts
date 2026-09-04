/**
 * The film view's transport.
 *
 * The video element already has controls; what it does not have is a way to say *what* you are
 * about to watch. The chapter list is that — seven rows, one per act, each a real seek — and it
 * doubles as a position readout, because a row that highlights while the film plays tells a reader
 * where they are without them reading the scrubber.
 *
 * Kept separate from `main` because it is the only part of the page that owns a media element, and
 * media elements need a hand off: a film that keeps playing in a hidden tab is one you can hear and
 * cannot see.
 */

export interface MountedFilm {
  /** Called when the reader navigates away. A hidden `<video>` does not stop on its own. */
  pause(): void;
}

export function mountFilm(): MountedFilm | null {
  const video = document.getElementById("film-video");
  if (!(video instanceof HTMLVideoElement)) return null;

  const chapters = [...document.querySelectorAll<HTMLElement>(".chapter[data-at]")];
  const starts = chapters.map((row) => Number(row.dataset["at"] ?? "0"));

  for (const [index, row] of chapters.entries()) {
    row.addEventListener("click", () => {
      video.currentTime = starts[index] ?? 0;
      // A click on a chapter is a request to watch it, not to queue it.
      void video.play().catch(() => {
        /* Autoplay policy, or no codec. The seek still happened, which is the part that matters. */
      });
    });
  }

  // Last start that is not in the future. Cheaper than a range test and correct at the boundaries,
  // including a scrub past the end.
  const mark = (): void => {
    let active = -1;
    for (const [index, start] of starts.entries()) {
      if (video.currentTime + 0.05 >= start) active = index;
    }
    for (const [index, row] of chapters.entries()) {
      if (index === active) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
  };

  video.addEventListener("timeupdate", mark);
  video.addEventListener("seeked", mark);
  mark();

  return {
    pause: () => {
      if (!video.paused) video.pause();
    },
  };
}
