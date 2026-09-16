/**
 * Markup where markup was never wanted.
 *
 * Every field in this application is plain text: nothing an operator or a
 * borrower submits is ever rendered as HTML, so a value like
 * `<script>alert(1)</script>` cannot execute today. It is still the wrong thing
 * to have stored. It is a malformed entry, it travels into places React does
 * not escape for us — an SMS body, a CSV export, an audit row someone opens in
 * a spreadsheet — and it is one careless `dangerouslySetInnerHTML` away from
 * being live. Refusing it on the way in costs nothing and does not depend on
 * every future reader remembering to escape.
 */

/**
 * An angle bracket that opens what a parser would read as a tag.
 *
 * Deliberately not "contains a `<`": prose legitimately compares things
 * (`under 18 < 21`, `5<10`), and a rule that rejected those would be worked
 * around rather than obeyed. `<script`, `</div`, `<img `, `<!--` all match;
 * an angle bracket followed by a space or a digit does not.
 */
const TAG_OPENING = /<[a-zA-Z!?/]/;

export function containsMarkup(value: string): boolean {
  return TAG_OPENING.test(value);
}

/** Nested bodies are shallow here; the cap is only so a hostile shape cannot spin. */
const MAX_DEPTH = 8;

/**
 * Walks a parsed JSON body and names the first field carrying markup, so the
 * refusal can be shown under the input that caused it rather than as a
 * detached message. Returns null when the body is clean.
 */
export function findMarkupField(value: unknown, path = '', depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;

  if (typeof value === 'string') {
    return containsMarkup(value) ? path || 'value' : null;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findMarkupField(value[i], path ? `${path}[${i}]` : `[${i}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const found = findMarkupField(child, path ? `${path}.${key}` : key, depth + 1);
      if (found) return found;
    }
    return null;
  }

  return null;
}
