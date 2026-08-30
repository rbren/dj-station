//! Track-title tidying at import time.
//!
//! Downloads and loose files name a track the way a file browser does —
//! `Lizzo - Boys`, `Boys (Lizzo)`, `Boys_-_LIZZO` — while the library
//! shows title and artist in their own columns, so the credit reads
//! twice. [`strip_artist`] takes it out of the title exactly when the
//! title really does open or close with the artist we already know, and
//! leaves everything else alone: a title is the user's text, and a wrong
//! guess here is worse than a redundant one.

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
    use super::strip_artist;

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
}
