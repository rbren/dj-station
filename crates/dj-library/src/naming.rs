//! Track-title tidying.
//!
//! Downloads and loose files name a track the way a file browser does —
//! `Lizzo - Boys`, `Boys (Lizzo)`, `Boys_-_LIZZO` — while the library
//! shows title and artist in their own columns, so the credit reads
//! twice. [`strip_artist`] takes it out of the title exactly when the
//! title really does open or close with the artist we already know, and
//! [`strip_noise`] drops the video-platform parentheticals — `(Official
//! Video)`, `[HQ]` — that say nothing about the music. [`tidy_title`]
//! is the two together, run once at import and again when a track's
//! artist is EDITED (a new credit can expose a redundant one still in
//! the title); a title-only edit is the user's text and is never
//! re-tidied. Everything else is left alone: a wrong guess here is
//! worse than a redundant word.

/// Punctuation that can JOIN an artist credit to a title. Quotes and
/// apostrophes are deliberately absent: `Lizzo's Boys` is a title, not a
/// credit plus a title.
const JOINERS: &[char] = &[
    '-', '–', '—', '_', '|', ':', ';', '~', '/', '\\', '•', '·', '*', '+', '.', ',', '(', ')', '[',
    ']', '{', '}',
];

/// The title with a leading or trailing `artist` credit (and the
/// punctuation joining it) removed: `("Lizzo - Boys", "Lizzo")` is
/// `"Boys"`.
///
/// Conservative by construction — the credit must match the artist
/// character for character (case aside), the join must contain real
/// punctuation (`Lizzo Boys` stays as it is), and what is left must not
/// be empty.
pub fn strip_artist(title: &str, artist: &str) -> String {
    let title = title.trim();
    let artist = artist.trim();
    if artist.is_empty() || title.is_empty() {
        return title.to_string();
    }

    let head = title.trim_start_matches(is_edge);
    if let Some(rest) = head.strip_prefix_ci(artist) {
        if let Some(rest) = trim_join_start(rest) {
            return rest.to_string();
        }
    }

    let tail = title.trim_end_matches(is_edge);
    if let Some(rest) = tail.strip_suffix_ci(artist) {
        if let Some(rest) = trim_join_end(rest) {
            return rest.to_string();
        }
    }

    title.to_string()
}

/// The full tidy: platform noise out first (so a credit it was hiding —
/// `Boys (Official Video) - Lizzo` — sits at the edge where
/// [`strip_artist`] can see it), then the artist credit. Run at import
/// and re-run when the artist is edited.
pub fn tidy_title(title: &str, artist: &str) -> String {
    strip_artist(&strip_noise(title), artist)
}

/// The title with video-platform parentheticals removed: `(Official
/// Video)`, `(Official Music Video)`, `[Official Audio]`, `(HQ)`,
/// `(HD)`, `(Lyrics)` and the like. Deliberately a short allow-list
/// (see [`is_noise`]) — `(Remix)`, `(feat. X)`, `(Live)` are music, not
/// noise — and it never empties a title.
pub fn strip_noise(title: &str) -> String {
    let mut out = String::new();
    let mut removed = false;
    let mut rest = title;
    while let Some(open) = rest.find(['(', '[']) {
        let close = if rest.as_bytes()[open] == b'(' {
            ')'
        } else {
            ']'
        };
        let Some(len) = rest[open..].find(close) else {
            break;
        };
        if is_noise(&rest[open + 1..open + len]) {
            removed = true;
            out.push_str(&rest[..open]);
        } else {
            out.push_str(&rest[..open + len + close.len_utf8()]);
        }
        rest = &rest[open + len + close.len_utf8()..];
    }
    if !removed {
        return title.trim().to_string();
    }
    out.push_str(rest);
    // Removing a group leaves a doubled space behind; collapse runs.
    let cleaned = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        title.trim().to_string()
    } else {
        cleaned
    }
}

/// Is this parenthetical platform noise? `Official …` in any flavour,
/// plus the handful of exact quality/format tags a video title carries.
/// An allow-list, not a heuristic: anything unrecognised is part of the
/// title.
fn is_noise(content: &str) -> bool {
    let content = content.trim().to_lowercase();
    if let Some(rest) = content.strip_prefix("official") {
        return rest.is_empty() || rest.starts_with(char::is_whitespace);
    }
    matches!(
        content.as_str(),
        "hq" | "hd" | "4k" | "audio" | "video" | "music video" | "lyrics" | "lyric video"
    )
}

/// Leading/trailing decoration a credit may sit inside (`(Lizzo) Boys`).
fn is_edge(c: char) -> bool {
    c.is_whitespace() || JOINERS.contains(&c)
}

/// What is left after the punctuation joining a leading credit to the
/// title — `None` when the two are separated by whitespace alone (or by
/// nothing at all), which is no credit but a longer title.
fn trim_join_start(rest: &str) -> Option<&str> {
    let mut punctuated = false;
    let out = rest.trim_start_matches(|c: char| {
        punctuated |= JOINERS.contains(&c);
        is_edge(c)
    });
    (punctuated && !out.is_empty()).then_some(out)
}

fn trim_join_end(rest: &str) -> Option<&str> {
    let mut punctuated = false;
    let out = rest.trim_end_matches(|c: char| {
        punctuated |= JOINERS.contains(&c);
        is_edge(c)
    });
    (punctuated && !out.is_empty()).then_some(out)
}

/// Case-insensitive `strip_prefix`/`strip_suffix`. Char-by-char rather
/// than over lowercased copies, because a lowercased byte length no
/// longer indexes the original.
trait StripCi {
    fn strip_prefix_ci(&self, needle: &str) -> Option<&str>;
    fn strip_suffix_ci(&self, needle: &str) -> Option<&str>;
}

impl StripCi for str {
    fn strip_prefix_ci(&self, needle: &str) -> Option<&str> {
        let mut chars = self.char_indices();
        for want in needle.chars() {
            let (_, got) = chars.next()?;
            if !eq_ci(got, want) {
                return None;
            }
        }
        Some(&self[chars.next().map(|(i, _)| i).unwrap_or(self.len())..])
    }

    fn strip_suffix_ci(&self, needle: &str) -> Option<&str> {
        let mut chars = self.char_indices().rev();
        let mut start = self.len();
        for want in needle.chars().rev() {
            let (i, got) = chars.next()?;
            if !eq_ci(got, want) {
                return None;
            }
            start = i;
        }
        Some(&self[..start])
    }
}

fn eq_ci(a: char, b: char) -> bool {
    a == b || a.to_lowercase().eq(b.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::{strip_artist, strip_noise, tidy_title};

    #[test]
    fn strips_a_leading_credit() {
        assert_eq!(strip_artist("Lizzo - Boys", "Lizzo"), "Boys");
        assert_eq!(strip_artist("LIZZO – Boys", "Lizzo"), "Boys");
        assert_eq!(strip_artist("Lizzo: Boys", "Lizzo"), "Boys");
        assert_eq!(strip_artist("Lizzo_-_Boys", "lizzo"), "Boys");
        assert_eq!(strip_artist("(Lizzo) Boys", "Lizzo"), "Boys");
        assert_eq!(
            strip_artist("M.I.A. - Paper Planes", "M.I.A"),
            "Paper Planes"
        );
    }

    #[test]
    fn strips_a_trailing_credit() {
        assert_eq!(strip_artist("Boys - Lizzo", "Lizzo"), "Boys");
        assert_eq!(strip_artist("Boys (Lizzo)", "Lizzo"), "Boys");
        assert_eq!(strip_artist("Boys, Lizzo ", "Lizzo"), "Boys");
    }

    #[test]
    fn leaves_a_title_that_only_looks_like_a_credit() {
        // No punctuation joining the two: this is one title.
        assert_eq!(strip_artist("Lizzo Boys", "Lizzo"), "Lizzo Boys");
        // A possessive is not a credit.
        assert_eq!(strip_artist("Lizzo's Boys", "Lizzo"), "Lizzo's Boys");
        // The artist appears, but not at either end.
        assert_eq!(
            strip_artist("Boys - Lizzo - Live", "Lizzo"),
            "Boys - Lizzo - Live"
        );
        // Nothing would be left.
        assert_eq!(strip_artist("Lizzo", "Lizzo"), "Lizzo");
        assert_eq!(strip_artist("- Lizzo -", "Lizzo"), "- Lizzo -");
        // Nothing to match against.
        assert_eq!(strip_artist("Lizzo - Boys", ""), "Lizzo - Boys");
        // A partial match is not a match.
        assert_eq!(strip_artist("Lizz - Boys", "Lizzo"), "Lizz - Boys");
    }

    #[test]
    fn keeps_the_rest_of_the_title_intact() {
        assert_eq!(
            strip_artist("Lizzo - Boys (Official Video)", "Lizzo"),
            "Boys (Official Video)"
        );
        assert_eq!(
            strip_artist("Daft Punk - Harder, Better, Faster, Stronger", "Daft Punk"),
            "Harder, Better, Faster, Stronger"
        );
        assert_eq!(strip_artist("  Lizzo -  Boys  ", "Lizzo"), "Boys");
    }

    #[test]
    fn strips_platform_noise_parentheticals() {
        assert_eq!(strip_noise("Boys (Official Video)"), "Boys");
        assert_eq!(strip_noise("Boys (Official Music Video)"), "Boys");
        assert_eq!(strip_noise("Boys (official audio)"), "Boys");
        assert_eq!(strip_noise("Boys (Official)"), "Boys");
        assert_eq!(strip_noise("Boys [Official Visualizer]"), "Boys");
        assert_eq!(strip_noise("Boys (HQ)"), "Boys");
        assert_eq!(strip_noise("Boys [HD]"), "Boys");
        assert_eq!(strip_noise("Boys (4K)"), "Boys");
        assert_eq!(strip_noise("Boys (Lyrics)"), "Boys");
        assert_eq!(strip_noise("Boys (Lyric Video)"), "Boys");
        assert_eq!(strip_noise("Boys (Audio)"), "Boys");
        // Noise in the middle closes the gap it leaves.
        assert_eq!(strip_noise("Boys (HQ) (HD)"), "Boys");
        assert_eq!(strip_noise("Boys (Official Video) - Live"), "Boys - Live");
    }

    #[test]
    fn keeps_parentheticals_that_are_music() {
        assert_eq!(strip_noise("Boys (Remix)"), "Boys (Remix)");
        assert_eq!(
            strip_noise("Boys (feat. Missy Elliott)"),
            "Boys (feat. Missy Elliott)"
        );
        assert_eq!(strip_noise("Boys (Live)"), "Boys (Live)");
        assert_eq!(strip_noise("Boys (Acoustic)"), "Boys (Acoustic)");
        assert_eq!(strip_noise("Boys (Radio Edit)"), "Boys (Radio Edit)");
        // "official" as a word of the title, not a tag of its own.
        assert_eq!(
            strip_noise("Officially Missing You"),
            "Officially Missing You"
        );
        assert_eq!(strip_noise("(Officially) Yours"), "(Officially) Yours");
        // An unclosed group is title text.
        assert_eq!(strip_noise("Boys (Official"), "Boys (Official");
        // Never empties a title.
        assert_eq!(strip_noise("(Official Video)"), "(Official Video)");
    }

    #[test]
    fn tidy_title_strips_noise_and_credit_together() {
        assert_eq!(tidy_title("Lizzo - Boys (Official Video)", "Lizzo"), "Boys");
        // Noise goes first, so the credit it hid is found.
        assert_eq!(tidy_title("Boys (Official Video) - Lizzo", "Lizzo"), "Boys");
        assert_eq!(tidy_title("Boys [HQ]", ""), "Boys");
        // Music parentheticals survive the full tidy.
        assert_eq!(
            tidy_title("Lizzo - Boys (Remix) (Official Audio)", "Lizzo"),
            "Boys (Remix)"
        );
    }
}
