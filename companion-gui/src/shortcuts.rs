//! Persistent, conflict-free player keyboard shortcuts.

use std::collections::HashSet;

use eframe::egui::{Event, Key, KeyboardShortcut, Modifiers};
use serde_json::{Map, Value};

pub const SETTINGS_KEY: &str = "playerShortcuts";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(usize)]
pub enum ShortcutAction {
    TogglePause,
    SeekBackward,
    SeekForward,
    VolumeUp,
    VolumeDown,
    ToggleMute,
    ToggleSubtitles,
    ToggleFullscreen,
    TogglePoseMarker,
    StepFrameBackward,
    StepFrameForward,
    SetLoopA,
    SetLoopB,
    ClearLoop,
    Rating0,
    Rating1,
    Rating2,
    Rating3,
    Rating4,
    Rating5,
}

impl ShortcutAction {
    pub const PLAYBACK: [Self; 8] = [
        Self::TogglePause,
        Self::SeekBackward,
        Self::SeekForward,
        Self::VolumeUp,
        Self::VolumeDown,
        Self::ToggleMute,
        Self::ToggleSubtitles,
        Self::ToggleFullscreen,
    ];
    pub const EDITING: [Self; 6] = [
        Self::TogglePoseMarker,
        Self::StepFrameBackward,
        Self::StepFrameForward,
        Self::SetLoopA,
        Self::SetLoopB,
        Self::ClearLoop,
    ];
    pub const RATING: [Self; 6] = [
        Self::Rating0,
        Self::Rating1,
        Self::Rating2,
        Self::Rating3,
        Self::Rating4,
        Self::Rating5,
    ];
    pub const ALL: [Self; 20] = [
        Self::TogglePause,
        Self::SeekBackward,
        Self::SeekForward,
        Self::VolumeUp,
        Self::VolumeDown,
        Self::ToggleMute,
        Self::ToggleSubtitles,
        Self::ToggleFullscreen,
        Self::TogglePoseMarker,
        Self::StepFrameBackward,
        Self::StepFrameForward,
        Self::SetLoopA,
        Self::SetLoopB,
        Self::ClearLoop,
        Self::Rating0,
        Self::Rating1,
        Self::Rating2,
        Self::Rating3,
        Self::Rating4,
        Self::Rating5,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::TogglePause => "togglePause",
            Self::SeekBackward => "seekBackward",
            Self::SeekForward => "seekForward",
            Self::VolumeUp => "volumeUp",
            Self::VolumeDown => "volumeDown",
            Self::ToggleMute => "toggleMute",
            Self::ToggleSubtitles => "toggleSubtitles",
            Self::ToggleFullscreen => "toggleFullscreen",
            Self::TogglePoseMarker => "togglePoseMarker",
            Self::StepFrameBackward => "stepFrameBackward",
            Self::StepFrameForward => "stepFrameForward",
            Self::SetLoopA => "setLoopA",
            Self::SetLoopB => "setLoopB",
            Self::ClearLoop => "clearLoop",
            Self::Rating0 => "rating0",
            Self::Rating1 => "rating1",
            Self::Rating2 => "rating2",
            Self::Rating3 => "rating3",
            Self::Rating4 => "rating4",
            Self::Rating5 => "rating5",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::TogglePause => "재생 · 일시정지",
            Self::SeekBackward => "5초 뒤로",
            Self::SeekForward => "5초 앞으로",
            Self::VolumeUp => "음량 높이기",
            Self::VolumeDown => "음량 낮추기",
            Self::ToggleMute => "음소거",
            Self::ToggleSubtitles => "자막 켜기 · 끄기",
            Self::ToggleFullscreen => "전체화면",
            Self::TogglePoseMarker => "포즈 마킹",
            Self::StepFrameBackward => "이전 프레임",
            Self::StepFrameForward => "다음 프레임",
            Self::SetLoopA => "A 지점 설정",
            Self::SetLoopB => "B 지점 설정",
            Self::ClearLoop => "A-B 구간 지우기",
            Self::Rating0 => "별점 지우기",
            Self::Rating1 => "별점 1점",
            Self::Rating2 => "별점 2점",
            Self::Rating3 => "별점 3점",
            Self::Rating4 => "별점 4점",
            Self::Rating5 => "별점 5점",
        }
    }

    pub const fn rating(self) -> Option<i32> {
        match self {
            Self::Rating0 => Some(0),
            Self::Rating1 => Some(1),
            Self::Rating2 => Some(2),
            Self::Rating3 => Some(3),
            Self::Rating4 => Some(4),
            Self::Rating5 => Some(5),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlayerShortcuts {
    bindings: [KeyboardShortcut; ShortcutAction::ALL.len()],
}

impl Default for PlayerShortcuts {
    fn default() -> Self {
        Self {
            bindings: [
                plain(Key::Space),
                plain(Key::ArrowLeft),
                plain(Key::ArrowRight),
                plain(Key::ArrowUp),
                plain(Key::ArrowDown),
                plain(Key::M),
                plain(Key::C),
                plain(Key::F),
                plain(Key::B),
                plain(Key::Comma),
                plain(Key::Period),
                plain(Key::OpenBracket),
                plain(Key::CloseBracket),
                plain(Key::Backslash),
                plain(Key::Num0),
                plain(Key::Num1),
                plain(Key::Num2),
                plain(Key::Num3),
                plain(Key::Num4),
                plain(Key::Num5),
            ],
        }
    }
}

impl PlayerShortcuts {
    pub fn get(self, action: ShortcutAction) -> KeyboardShortcut {
        self.bindings[action as usize]
    }

    /// Assign a shortcut and swap the displaced action onto the old shortcut.
    /// This keeps every action reachable without forcing a multi-step reset.
    pub fn assign_and_swap(
        &mut self,
        action: ShortcutAction,
        shortcut: KeyboardShortcut,
    ) -> Option<ShortcutAction> {
        let old = self.get(action);
        if old == shortcut {
            return None;
        }
        let displaced = ShortcutAction::ALL
            .into_iter()
            .find(|candidate| *candidate != action && self.get(*candidate) == shortcut);
        self.bindings[action as usize] = shortcut;
        if let Some(displaced) = displaced {
            self.bindings[displaced as usize] = old;
        }
        displaced
    }

    pub fn is_default(self) -> bool {
        self == Self::default()
    }

    pub fn from_settings_document(document: &Value) -> Self {
        let Some(object) = document.get(SETTINGS_KEY).and_then(Value::as_object) else {
            return Self::default();
        };
        let mut candidate = Self::default();
        for action in ShortcutAction::ALL {
            let Some(encoded) = object.get(action.id()).and_then(Value::as_str) else {
                continue;
            };
            let Some(shortcut) = decode_shortcut(encoded) else {
                return Self::default();
            };
            candidate.bindings[action as usize] = shortcut;
        }
        let unique = candidate.bindings.into_iter().collect::<HashSet<_>>();
        if unique.len() != ShortcutAction::ALL.len()
            || candidate
                .bindings
                .iter()
                .any(|shortcut| shortcut.logical_key == Key::Escape)
        {
            return Self::default();
        }
        candidate
    }

    pub fn write_to_settings_document(self, document: &mut Value) {
        if !document.is_object() {
            *document = Value::Object(Map::new());
        }
        let values = ShortcutAction::ALL
            .into_iter()
            .map(|action| {
                (
                    action.id().to_string(),
                    Value::String(encode_shortcut(self.get(action))),
                )
            })
            .collect::<Map<_, _>>();
        document[SETTINGS_KEY] = Value::Object(values);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureResult {
    Cancel,
    Shortcut(KeyboardShortcut),
}

pub fn capture_from_events(events: &[Event]) -> Option<CaptureResult> {
    events.iter().find_map(|event| {
        let Event::Key {
            key,
            pressed: true,
            repeat: false,
            modifiers,
            ..
        } = event
        else {
            return None;
        };
        if *key == Key::Escape {
            return Some(CaptureResult::Cancel);
        }
        if is_modifier_key(*key) {
            return None;
        }
        Some(CaptureResult::Shortcut(KeyboardShortcut::new(
            normalized_modifiers(*modifiers),
            *key,
        )))
    })
}

fn plain(key: Key) -> KeyboardShortcut {
    KeyboardShortcut::new(Modifiers::NONE, key)
}

fn normalized_modifiers(modifiers: Modifiers) -> Modifiers {
    Modifiers {
        alt: modifiers.alt,
        shift: modifiers.shift,
        command: modifiers.command || modifiers.ctrl || modifiers.mac_cmd,
        ..Modifiers::NONE
    }
}

fn is_modifier_key(key: Key) -> bool {
    matches!(
        key,
        Key::ShiftLeft
            | Key::ShiftRight
            | Key::ControlLeft
            | Key::ControlRight
            | Key::AltLeft
            | Key::AltRight
            | Key::SuperLeft
            | Key::SuperRight
    )
}

fn encode_shortcut(shortcut: KeyboardShortcut) -> String {
    let mut parts = Vec::new();
    if shortcut.modifiers.command || shortcut.modifiers.ctrl || shortcut.modifiers.mac_cmd {
        parts.push("Ctrl");
    }
    if shortcut.modifiers.alt {
        parts.push("Alt");
    }
    if shortcut.modifiers.shift {
        parts.push("Shift");
    }
    parts.push(shortcut.logical_key.name());
    parts.join("+")
}

fn decode_shortcut(encoded: &str) -> Option<KeyboardShortcut> {
    let mut parts = encoded.split('+').collect::<Vec<_>>();
    let key = Key::from_name(parts.pop()?)?;
    if key == Key::Escape {
        return None;
    }
    let mut modifiers = Modifiers::NONE;
    for part in parts {
        match part {
            "Ctrl" => modifiers.command = true,
            "Alt" => modifiers.alt = true,
            "Shift" => modifiers.shift = true,
            _ => return None,
        }
    }
    Some(KeyboardShortcut::new(modifiers, key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_round_trip_every_player_action() {
        let mut shortcuts = PlayerShortcuts::default();
        shortcuts.assign_and_swap(
            ShortcutAction::TogglePause,
            KeyboardShortcut::new(Modifiers::COMMAND | Modifiers::SHIFT, Key::P),
        );
        let mut document = json!({"licenseKey": "keep"});
        shortcuts.write_to_settings_document(&mut document);
        assert_eq!(
            PlayerShortcuts::from_settings_document(&document),
            shortcuts
        );
        assert_eq!(document["licenseKey"], "keep");
    }

    #[test]
    fn assigning_an_existing_key_swaps_instead_of_disabling_an_action() {
        let mut shortcuts = PlayerShortcuts::default();
        let displaced = shortcuts.assign_and_swap(ShortcutAction::TogglePause, plain(Key::M));
        assert_eq!(displaced, Some(ShortcutAction::ToggleMute));
        assert_eq!(shortcuts.get(ShortcutAction::TogglePause), plain(Key::M));
        assert_eq!(shortcuts.get(ShortcutAction::ToggleMute), plain(Key::Space));
    }

    #[test]
    fn editing_and_rating_defaults_are_direct_and_unique() {
        let shortcuts = PlayerShortcuts::default();
        assert_eq!(
            shortcuts.get(ShortcutAction::TogglePoseMarker),
            plain(Key::B)
        );
        assert_eq!(
            shortcuts.get(ShortcutAction::StepFrameBackward),
            plain(Key::Comma)
        );
        for (index, action) in ShortcutAction::RATING.into_iter().enumerate() {
            assert_eq!(action.rating(), Some(index as i32));
            assert_eq!(
                shortcuts.get(action).logical_key,
                Key::from_name(&index.to_string()).expect("numeric key")
            );
        }
        assert_eq!(
            shortcuts.bindings.into_iter().collect::<HashSet<_>>().len(),
            ShortcutAction::ALL.len()
        );
    }

    #[test]
    fn malformed_or_duplicate_persisted_shortcuts_fail_safe_to_defaults() {
        let duplicate = json!({
            SETTINGS_KEY: {
                "togglePause": "F",
                "toggleFullscreen": "F"
            }
        });
        assert!(PlayerShortcuts::from_settings_document(&duplicate).is_default());
        let reserved = json!({SETTINGS_KEY: {"togglePause": "Escape"}});
        assert!(PlayerShortcuts::from_settings_document(&reserved).is_default());
    }

    #[test]
    fn escape_cancels_capture_and_modifier_keys_wait_for_a_real_key() {
        let escape = Event::Key {
            key: Key::Escape,
            physical_key: None,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::NONE,
        };
        assert_eq!(capture_from_events(&[escape]), Some(CaptureResult::Cancel));

        let modifier = Event::Key {
            key: Key::ControlLeft,
            physical_key: None,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
        };
        assert_eq!(capture_from_events(&[modifier]), None);
    }
}
