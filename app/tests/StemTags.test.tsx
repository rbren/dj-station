// What a clip is made of, as tags — the one component every surface that
// offers a clip uses to say so.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StemTags } from '../src/components/StemTags';

const tags = () => [...(screen.queryByTestId('tags')?.children ?? [])].map((c) => c.textContent);

describe('StemTags', () => {
  it('names the parts a clip holds, in stem order', () => {
    render(<StemTags stems={['bass', 'vocals']} testId="tags" />);
    // The order is STEM_NAMES', not the order they arrived in: two clips
    // holding the same parts must look identical in a list.
    expect(tags()).toEqual(['vocals', 'bass']);
  });

  it('says "mix" once rather than all four', () => {
    render(<StemTags stems={['drums', 'other', 'vocals', 'bass']} testId="tags" />);
    // A clip cut from untouched mixes contains everything, and four chips
    // on every row would drown the rows that really are one part.
    expect(tags()).toEqual(['mix']);
    expect(screen.getByTestId('tags-mix').title).toContain('vocals, drums, bass, other');
  });

  it('shows nothing at all when nothing is known', () => {
    const { rerender } = render(<StemTags stems={undefined} testId="tags" />);
    expect(screen.queryByTestId('tags')).toBeNull();
    rerender(<StemTags stems={[]} testId="tags" />);
    expect(screen.queryByTestId('tags')).toBeNull();
    // A name from no stem this app knows is not a tag either — and a list
    // of only those is no tags, not an empty box.
    rerender(<StemTags stems={['kazoo']} testId="tags" />);
    expect(screen.queryByTestId('tags')).toBeNull();
  });
});
