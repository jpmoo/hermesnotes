import AppKit
import Carbon.HIToolbox

/// A global hotkey.
///
/// Carbon's `RegisterEventHotKey` rather than `NSEvent.addGlobalMonitorForEvents`:
/// the monitor approach needs Accessibility permission, and a TCC prompt asking
/// to observe your keyboard is an alarming thing for a note-taking tool to ask.
/// This API is old and still the supported way to do exactly this.
final class Hotkey {
    private var ref: EventHotKeyRef?
    private static var handlers: [UInt32: () -> Void] = [:]
    private static var installed = false
    private static var nextID: UInt32 = 1

    /// `spec` looks like "shift+opt+g" or "cmd+shift+h".
    init?(spec: String, action: @escaping () -> Void) {
        guard let (code, mods) = Hotkey.parse(spec) else {
            NSLog("talaria: can't make sense of hotkey '\(spec)'")
            return nil
        }
        Hotkey.installHandlerOnce()
        let id = Hotkey.nextID
        Hotkey.nextID += 1
        Hotkey.handlers[id] = action
        let hotKeyID = EventHotKeyID(signature: OSType(0x544C_5241), id: id) // 'TLRA'
        let status = RegisterEventHotKey(code, mods, hotKeyID, GetEventDispatcherTarget(), 0, &ref)
        guard status == noErr else {
            // Almost always because something else already owns the combination.
            NSLog("talaria: hotkey '\(spec)' was refused (\(status)) — most likely already taken")
            Hotkey.handlers[id] = nil
            return nil
        }
        _ = hotKeyID
        NSLog("talaria: hotkey '\(spec)' registered")
    }

    deinit { if let ref { UnregisterEventHotKey(ref) } }

    private static func installHandlerOnce() {
        guard !installed else { return }
        installed = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetEventDispatcherTarget(), { _, event, _ -> OSStatus in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            if let action = Hotkey.handlers[id.id] {
                DispatchQueue.main.async(execute: action)
            }
            return noErr
        }, 1, &spec, nil, nil)
    }

    private static func parse(_ spec: String) -> (UInt32, UInt32)? {
        var mods: UInt32 = 0
        var key: String?
        for part in spec.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch part {
            case "cmd", "command": mods |= UInt32(cmdKey)
            case "ctrl", "control": mods |= UInt32(controlKey)
            case "opt", "option", "alt": mods |= UInt32(optionKey)
            case "shift": mods |= UInt32(shiftKey)
            default: key = part
            }
        }
        guard let key, let code = keyCodes[key] else { return nil }
        return (code, mods)
    }

    private static let keyCodes: [String: UInt32] = {
        var m: [String: UInt32] = [
            "space": UInt32(kVK_Space), "return": UInt32(kVK_Return), "escape": UInt32(kVK_Escape),
            "tab": UInt32(kVK_Tab),
        ]
        let letters: [(String, Int)] = [
            ("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D), ("e", kVK_ANSI_E),
            ("f", kVK_ANSI_F), ("g", kVK_ANSI_G), ("h", kVK_ANSI_H), ("i", kVK_ANSI_I), ("j", kVK_ANSI_J),
            ("k", kVK_ANSI_K), ("l", kVK_ANSI_L), ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O),
            ("p", kVK_ANSI_P), ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R), ("s", kVK_ANSI_S), ("t", kVK_ANSI_T),
            ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W), ("x", kVK_ANSI_X), ("y", kVK_ANSI_Y),
            ("z", kVK_ANSI_Z),
        ]
        for (name, code) in letters { m[name] = UInt32(code) }
        return m
    }()
}
