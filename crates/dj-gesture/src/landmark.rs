//! Named hand landmarks: the 21-point MediaPipe-Hands topology (PRD §7.3).
//!
//! Full point names combine handedness and landmark: `L.index.tip`,
//! `R.thumb.tip`, `L.wrist`, ...

use serde::{Deserialize, Serialize};

pub const N_LANDMARKS: usize = 21;

/// Landmark names, indexed per the MediaPipe-Hands convention.
pub const LANDMARK_NAMES: [&str; N_LANDMARKS] = [
    "wrist",
    "thumb.cmc",
    "thumb.mcp",
    "thumb.ip",
    "thumb.tip",
    "index.mcp",
    "index.pip",
    "index.dip",
    "index.tip",
    "middle.mcp",
    "middle.pip",
    "middle.dip",
    "middle.tip",
    "ring.mcp",
    "ring.pip",
    "ring.dip",
    "ring.tip",
    "pinky.mcp",
    "pinky.pip",
    "pinky.dip",
    "pinky.tip",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Handedness {
    Left,
    Right,
}

impl Handedness {
    pub fn letter(self) -> char {
        match self {
            Handedness::Left => 'L',
            Handedness::Right => 'R',
        }
    }

    pub fn from_letter(c: char) -> Option<Handedness> {
        match c {
            'L' => Some(Handedness::Left),
            'R' => Some(Handedness::Right),
            _ => None,
        }
    }

    /// 0 for left, 1 for right (marker encoding, array indexing).
    pub fn index(self) -> usize {
        match self {
            Handedness::Left => 0,
            Handedness::Right => 1,
        }
    }
}

pub fn landmark_index(name: &str) -> Option<usize> {
    LANDMARK_NAMES.iter().position(|n| *n == name)
}

/// Full point name, e.g. `point_name(Handedness::Left, 8) == "L.index.tip"`.
pub fn point_name(hand: Handedness, landmark: usize) -> String {
    format!("{}.{}", hand.letter(), LANDMARK_NAMES[landmark])
}

/// Parse `"L.index.tip"` into `(Handedness::Left, 8)`.
pub fn parse_point_name(name: &str) -> Option<(Handedness, usize)> {
    let (hand, rest) = name.split_once('.')?;
    let mut chars = hand.chars();
    let letter = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    Some((Handedness::from_letter(letter)?, landmark_index(rest)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        for hand in [Handedness::Left, Handedness::Right] {
            for i in 0..N_LANDMARKS {
                let name = point_name(hand, i);
                assert_eq!(parse_point_name(&name), Some((hand, i)), "{name}");
            }
        }
        assert_eq!(parse_point_name("L.index.tip"), Some((Handedness::Left, 8)));
        assert_eq!(
            parse_point_name("R.thumb.tip"),
            Some((Handedness::Right, 4))
        );
        assert_eq!(parse_point_name("X.index.tip"), None);
        assert_eq!(parse_point_name("L.nose"), None);
    }
}
