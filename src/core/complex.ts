import type { Complex } from "./types.ts";

export const c = (re: number, im = 0): Complex => ({ re, im });

export const cadd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });

export const cscale = (a: Complex, s: number): Complex => ({ re: a.re * s, im: a.im * s });

export const cabs2 = (a: Complex): number => a.re * a.re + a.im * a.im;

export const cabs = (a: Complex): number => Math.hypot(a.re, a.im);

/** exp(j*phi) */
export const cexp = (phi: number): Complex => ({ re: Math.cos(phi), im: Math.sin(phi) });

export const carg = (a: Complex): number => Math.atan2(a.im, a.re);

export const csub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
