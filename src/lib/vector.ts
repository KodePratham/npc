export type Vec = Float32Array;

/** Scale to unit length so that dot product equals cosine similarity. */
export function normalize(v: Vec): Vec {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export function dot(a: Vec, b: Vec): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function encodeVector(v: Vec): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

export function decodeVector(b64: string): Vec {
  const bytes = Buffer.from(b64, "base64");
  // Copy into a fresh, 4-byte aligned buffer before viewing it as Float32.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Float32Array(ab);
}
