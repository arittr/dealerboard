/**
 * AppleScript that focuses a Ghostty terminal by its stable id. Shared by the
 * Stream Deck plugin's Claude activation and the strip app's press routing —
 * the plugin module itself imports node:child_process, so the constant lives
 * in this dependency-free leaf both frontends can import.
 */
export const FOCUS_GHOSTTY_TERMINAL_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  if application "Ghostty" is not running then error "ghostty_not_running"
  tell application "Ghostty"
    set matchingTerminals to {}
    repeat with candidateWindow in windows
      repeat with candidateTerminal in terminals of candidateWindow
        if (id of candidateTerminal) is targetId then
          set end of matchingTerminals to candidateTerminal
        end if
      end repeat
    end repeat
    if (count of matchingTerminals) is not 1 then error "ghostty_terminal_match_count"
    set matchedTerminal to item 1 of matchingTerminals
    focus matchedTerminal
  end tell
end run`;
