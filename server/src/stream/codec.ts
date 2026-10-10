/**
 * Audio conversions between the phone's 16 kHz PCM and Twilio Media Streams' 8 kHz G.711 mu-law.
 */

const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(sample: number): number {
  let s = Math.max(-CLIP, Math.min(CLIP, sample));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return u & 0x80 ? -magnitude : magnitude;
}

/** 16 kHz s16le -> 8 kHz mu-law. Averages sample pairs (a cheap low-pass before dropping half). */
export function pcm16kToMulaw8k(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const a = pcm.readInt16LE(i * 4);
    const b = pcm.readInt16LE(i * 4 + 2);
    out[i] = linearToMulaw((a + b) >> 1);
  }
  return out;
}

/** 8 kHz mu-law -> 16 kHz s16le by linear interpolation, continuous across chunks. */
export class MulawUpsampler {
  private last = 0;

  process(mulaw: Buffer): Buffer {
    const out = Buffer.alloc(mulaw.length * 4);
    for (let i = 0; i < mulaw.length; i++) {
      const current = mulawToLinear(mulaw[i]!);
      out.writeInt16LE((this.last + current) >> 1, i * 4);
      out.writeInt16LE(current, i * 4 + 2);
      this.last = current;
    }
    return out;
  }
}
