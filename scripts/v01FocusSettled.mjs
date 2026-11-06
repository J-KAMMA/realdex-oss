/**
 * Wait for the focus ring to be painted before measuring it.
 *
 * Every one of these harnesses runs its contexts with reduced motion, and the
 * reduced-motion block in src/styles.css sets transition-duration on `*` without setting
 * transition-property — which defaults to `all`. So outline-width, which had no
 * transition of its own, acquires one. Reading getComputedStyle in the same frame as the
 * focus change therefore returns the transition's start value: measured directly, 0px in
 * the same frame and 3px two frames later, on a ring that is plainly there.
 *
 * That produced a failure reading `{"outline":"solid","outlineWidth":"0px"}` — an
 * outline style with no width, which is not a state any stylesheet asks for and was the
 * clue that it was a clock being measured rather than a page. A person sees the ring on
 * the next frame, so it was never a defect in the app.
 *
 * Two frames rather than one: the first is the frame the style change lands in, the
 * second is the one after it has been applied.
 */
export const focusSettled = page =>
  page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
