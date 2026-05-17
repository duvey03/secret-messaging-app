/*
  Konami code detection. Calls onDetected() when the sequence is entered.
*/

const SEQUENCE = [
  'ArrowUp', 'ArrowUp',
  'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight',
  'ArrowLeft', 'ArrowRight',
  'b', 'a',
];

export function watchKonami(onDetected) {
  let idx = 0;
  window.addEventListener('keydown', (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const expected = SEQUENCE[idx].toLowerCase();
    if (key === expected) {
      idx++;
      if (idx === SEQUENCE.length) {
        idx = 0;
        onDetected();
      }
    } else {
      // Allow a fresh start if the current key matches the first of the sequence.
      idx = key === SEQUENCE[0].toLowerCase() ? 1 : 0;
    }
  });
}
