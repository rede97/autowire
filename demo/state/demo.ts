/**
 * 当前这个方案实现的不是很累 需要改造。Wire不应当是一个值类型
 * */


type Bit = 0 | 1;

type BuildFixedArray<
  T,
  N extends number,
  Acc extends T[] = [],
> = Acc["length"] extends N ? Acc : BuildFixedArray<T, N, [...Acc, T]>;

export type FixedArray<T, N extends number> = BuildFixedArray<T, N> &
  T[] & { length: N };
export type Wire<N extends number> = FixedArray<Bit, N>;

export type Input<N extends number> = Wire<N>;
export type Output<N extends number> = Wire<N>;

function zipBits<N extends number>(
  a: Wire<N>,
  b: Wire<N>,
  op: (a: Bit, b: Bit) => Bit,
): Wire<N> {
  return a.map((bit, index) => op(bit, b[index])) as Wire<N>;
}

export function and<N extends number>(a: Wire<N>, b: Wire<N>): Wire<N> {
  return zipBits(a, b, (x, y) => (x & y) as Bit);
}

export function or<N extends number>(a: Wire<N>, b: Wire<N>): Wire<N> {
  return zipBits(a, b, (x, y) => (x | y) as Bit);
}

export function not<N extends number>(a: Wire<N>): Wire<N> {
  return a.map((bit) => (bit === 0 ? 1 : 0)) as Wire<N>;
}

export function xor<N extends number>(a: Wire<N>, b: Wire<N>): Wire<N> {
  return zipBits(a, b, (x, y) => (x ^ y) as Bit);
}

export function xnor<N extends number>(a: Wire<N>, b: Wire<N>): Wire<N> {
  return zipBits(a, b, (x, y) => (x === y ? 1 : 0));
}

export function equal<N extends number>(a: Wire<N>, b: Wire<N>): Wire<1> {
  return [a.every((bit, index) => bit === b[index]) ? 1 : 0];
}

export function notEqual<N extends number>(a: Wire<N>, b: Wire<N>): Wire<1> {
  return [a.some((bit, index) => bit !== b[index]) ? 1 : 0];
}

export function reduceOr<N extends number>(signal: Wire<N>): Wire<1> {
  return [signal.some((bit) => bit === 1) ? 1 : 0];
}

export function reduceXor<N extends number>(signal: Wire<N>): Wire<1> {
  const result = signal.reduce<Bit>((acc, bit) => (acc ^ bit) as Bit, 0);
  return [result];
}

export function reduceAnd<N extends number>(signal: Wire<N>): Wire<1> {
  return [signal.every((bit) => bit === 1) ? 1 : 0];
}

export interface DFF<N extends number> {
  d: Output<N>;
  set: Output<1>;
  q: Input<N>;
}

export function test() {
  const a: Wire<8> = [0, 0, 0, 0, 0, 0, 0, 0];
  const b: Wire<8> = [1, 1, 1, 1, 1, 1, 1, 1];

  return [
    and(a, b),
    or(a, b),
    not(a),
    xor(a, b),
    xnor(a, b),
    equal(a, b),
    notEqual(a, b),
    reduceOr(a),
    reduceXor(a),
    reduceAnd(a),
  ];
}


