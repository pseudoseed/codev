/**
 * Spec 250, phase 10 — the same-origin comparison, in its own module so a unit
 * test can reach it.
 *
 * It lived inside the Playwright spec, where nothing could test it. That matters
 * here more than usual: this function IS the phase's central security assertion,
 * and the review found it silently unable to fail on a colliding ephemeral port.
 * A predicate that decides whether a security claim passed should not be the one
 * piece of the suite with no test of its own.
 */

/**
 * Which of these requests were CROSS-ORIGIN — compared as parsed origins, never
 * as string prefixes.
 *
 * Review finding, and the numbers are why it was worth fixing rather than
 * noting. `url.startsWith(origin)` is a PREFIX match, and the origin here is a
 * fixed `http://localhost:5733` while the agent host binds an ephemeral port via
 * `listen(0)`. So `http://localhost:57330` through `:57339` prefix-match and
 * would be filtered as same-origin — ten ports inside macOS's ephemeral range,
 * roughly 0.06% of runs in which a genuinely direct browser-to-agent request
 * would have been counted as same-origin and the assertion would have passed.
 *
 * A rare false PASS on the phase's central security claim is worse than a common
 * one: it makes the test look reliable while it is not, and 0.06% is exactly the
 * rate at which nobody ever sees it fail.
 *
 * Non-http schemes are exempt as a CLASS rather than by name. `data:` and
 * `blob:` are not requests to another origin at all, and `new URL("data:…").origin`
 * is the string `"null"` — so comparing them by origin would report a false
 * FAILURE. Excluding them by scheme covers `about:` and anything else a browser
 * invents, which naming them one at a time does not.
 */
export function crossOrigin(requests: readonly string[], origin: string): string[] {
  return requests.filter((url) => {
    if (!/^https?:/i.test(url)) return false;
    return new URL(url).origin !== origin;
  });
}
