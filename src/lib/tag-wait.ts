/** The tag picker's commit/wait lifecycle, React-free so the free-text
 * offer's interplay with the debounced search is directly testable.
 *
 * `committed` is the settled term the search route sees (the 400 ms debounce
 * owns it); `awaitingFree` is a just-picked free-text term awaiting proof
 * that both providers publish it under that name (VELV-46). It is non-null
 * only while a fetch for that term is in flight or about to fire — a settled
 * answer is final, so no promotion can ever be pending for one (VELV-50). */

export type TagWait = {
  committed: string | null;
  awaitingFree: string | null;
};

export type TagWaitAction =
  /** The debounce timer elapsed: the term is settled input now. */
  | { type: "commit"; term: string }
  /** The term fell below the two-character minimum. */
  | { type: "release" }
  /** A free-text chip was picked with no real tag to swap in. */
  | { type: "pickFreeText"; term: string; loading: boolean }
  /** The promotion effect has read the answer. `inputLength` is the
   * trimmed input's length at that moment: below the two-character
   * minimum the pick cleared the input, and the query goes with the
   * answer (VELV-75). */
  | { type: "consumed"; inputLength: number };

export function initTagWait(): TagWait {
  return { committed: null, awaitingFree: null };
}

export function reduceTagWait(w: TagWait, a: TagWaitAction): TagWait {
  switch (a.type) {
    case "commit":
      return w.committed === a.term ? w : { ...w, committed: a.term };
    // While a promotion is awaited the query must stay alive: the answer
    // reaches the hook only while `committed` holds the term.
    case "release":
      if (w.awaitingFree !== null || w.committed === null) return w;
      return { ...w, committed: null };
    // A settled answer is final — no promotion can be pending for it — so
    // the wait is armed only when the answer for this term has not settled
    // yet (committed !== term, or a fetch in flight). Arming against a
    // settled answer would strand the wait: nothing would re-run the
    // promotion effect, and `release` would then keep the old query (and a
    // failed search's alert) alive after the input cleared (VELV-50).
    case "pickFreeText":
      if (w.committed === a.term && !a.loading) return w;
      return { committed: a.term, awaitingFree: a.term };
    case "consumed":
      if (w.awaitingFree === null) return w;
      // The answer is read: the promotion no longer needs the query. When
      // the input sits below the two-character minimum (the pick cleared
      // it), the query goes too — `release` already ran as a no-op while
      // the wait was armed, and nothing re-runs it over an empty input, so
      // keeping the term here would keep a failed search's alert alive
      // (VELV-75). With live input the debounce owns the query from here.
      if (a.inputLength < 2) return { committed: null, awaitingFree: null };
      return { ...w, awaitingFree: null };
  }
}
