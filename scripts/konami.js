/*
  Konami code detection. Calls onDetected() when the sequence is entered.
  Listener is on window so it fires regardless of focus.
*/

const SEQUENCE = [
  'arrowup', 'arrowup',
  'arrowdown', 'arrowdown',
  'arrowleft', 'arrowright',
  'arrowleft', 'arrowright',
  'b', 'a',
];

export function watchKonami(onDetected) {
  let idx = 0;
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (key === SEQUENCE[idx]) {
      idx++;
      if (idx === SEQUENCE.length) {
        idx = 0;
        onDetected();
      }
    } else {
      // Allow a fresh start if the current key matches the first of the sequence.
      idx = key === SEQUENCE[0] ? 1 : 0;
    }
  });
}
