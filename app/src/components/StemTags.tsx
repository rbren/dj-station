// What a clip is made of, as tags: "drums", "bass", "vocals", "other".
//
// A clip is cut from seeds whose parts can be switched off (the Beatify
// clip builder's stem toggles), so two clips from the same track can hold
// entirely different material — a drum loop and an a cappella look alike
// in a list and sound nothing alike. The backend reads what a clip
// contains off its placements (`beatify_clip::stems_of_clip`) and every
// surface that offers a clip shows the answer here, the same way.
//
// ALL FOUR IS ONE TAG. A clip cut from untouched mixes contains every
// part, and four chips saying so on every row is noise that hides the
// rows that are actually a part of a track; "mix" is that same answer in
// the space of one chip, with the four named in its tooltip.
//
// NOTHING KNOWN, NOTHING SHOWN: an empty list is a clip with no runs in
// it (or, for a module bound before clips said what they hold, a patch
// that predates this) — never a row of empty boxes.

import { STEM_NAMES } from '../clip';

export interface StemTagsProps {
  stems: readonly string[] | undefined;
  /** Reaches the row/panel these sit in, for scoped queries in tests. */
  testId?: string;
}

export function StemTags({ stems, testId }: StemTagsProps) {
  if (!stems || stems.length === 0) return null;
  const named = STEM_NAMES.filter((s) => stems.includes(s));
  if (named.length === 0) return null;
  const whole = named.length === STEM_NAMES.length;
  const tags = whole ? (['mix'] as const) : named;
  return (
    <span className="stem-tags" data-testid={testId}>
      {tags.map((name) => (
        <span
          key={name}
          className={`stem-tag stem-tag-${name}`}
          data-testid={testId ? `${testId}-${name}` : undefined}
          title={whole ? `The whole mix: ${STEM_NAMES.join(', ')}` : `Contains the ${name}`}
        >
          {name}
        </span>
      ))}
    </span>
  );
}
