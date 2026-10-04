export const WAVE = (() => {
  const bits = "0110100111010",
    period = 8 + 9 * bits.length,
    levels: number[] = [];
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 8; i++) levels.push(0);
    for (const b of bits) {
      for (let i = 0; i < (b === "1" ? 6 : 3); i++) levels.push(1);
      for (let i = 0; i < (b === "1" ? 3 : 6); i++) levels.push(0);
    }
  }
  return { period, levels };
})();
