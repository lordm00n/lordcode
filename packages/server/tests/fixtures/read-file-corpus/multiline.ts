export const numbers = [
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
];

export function sum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

export function product(values: number[]): number {
  let total = 1;
  for (const value of values) {
    total *= value;
  }
  return total;
}

export const VERSION = "1.0.0";
