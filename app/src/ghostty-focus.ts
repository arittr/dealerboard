/**
 * AppleScript the strip's press routing runs to focus a Ghostty terminal by
 * its stable id. Kept as a dependency-free leaf so the press path can import
 * the script without pulling any process-spawning module into the bundle.
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
