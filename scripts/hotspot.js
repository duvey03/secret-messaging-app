/*
  Safe-zone hover detection. When the cursor enters any of the supplied
  elements, onEnter fires. When it leaves all of them (with a debounce to
  forgive jittery exits between adjacent safe elements), onLeave fires.
*/

export function watchSafeZone(elements, onEnter, onLeave, debounceMs = 180) {
  const inside = new Set();
  let leaveTimer = null;

  for (const el of elements) {
    if (!el) continue;
    el.addEventListener('mouseenter', () => {
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
      const wasEmpty = inside.size === 0;
      inside.add(el);
      if (wasEmpty) onEnter();
    });
    el.addEventListener('mouseleave', () => {
      inside.delete(el);
      if (inside.size === 0) {
        if (leaveTimer) clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => {
          leaveTimer = null;
          if (inside.size === 0) onLeave();
        }, debounceMs);
      }
    });
  }
}
