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
//
// `short` is the same answer for a column with no room to spell it out
// (VOX / DRM / BAS / OTH, MIX), on one line: the words wrap in a deck
// strip, and a wrapped tag row pushes the strip's knobs off the dock.

import { STEM_NAMES } from '../clip';

/** The three-letter form for columns too narrow to spell them out (a
 *  deck strip). The full word is still the tooltip, and the tag's class
 *  and test id never change — only what is printed in the chip.
 *  Exported so the decks clip picker's stem filter speaks the same
 *  vocabulary as the tags it filters on. */
export const STEM_TAG_SHORT: Record<string, string> = {
  vocals: 'VOX',
  drums: 'DRM',
  bass: 'BAS',
  other: 'OTH',
  mix: 'MIX',
};

export interface StemTagsProps {
  stems: readonly string[] | undefined;
  /** Reaches the row/panel these sit in, for scoped queries in tests. */
  testId?: string;
  /** Print the three-letter form and keep the row on ONE line — for a
   *  strip that is 156 px wide, not a list with room to read. */
  short?: boolean;
}

export function StemTags({ stems, testId, short }: StemTagsProps) {
  if (!stems || stems.length === 0) return null;
  const named = STEM_NAMES.filter((s) => stems.includes(s));
  if (named.length === 0) return null;
  const whole = named.length === STEM_NAMES.length;
  const tags = whole ? (['mix'] as const) : named;
  return (
    <span className={`stem-tags${short ? ' stem-tags-short' : ''}`} data-testid={testId}>
      {tags.map((name) => (
        <span
          key={name}
          className={`stem-tag stem-tag-${name}`}
          data-testid={testId ? `${testId}-${name}` : undefined}
          title={whole ? `The whole mix: ${STEM_NAMES.join(', ')}` : `Contains the ${name}`}
        >
          {short ? STEM_TAG_SHORT[name] : name}
        </span>
      ))}
    </span>
  );
}
