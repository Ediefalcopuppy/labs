export const KEPLER_STREAM_ORIGIN = "wss://planet.turingguild.com";

export function isTrustedKeplerStreamUrl(streamUrl: string): boolean {
  try {
    const parsed = new URL(streamUrl);
    return (
      parsed.protocol === "wss:" &&
      parsed.origin === KEPLER_STREAM_ORIGIN &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

export function streamUrlContainsSecret(streamUrl: string, secret: string): boolean {
  let candidate = streamUrl;
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate.includes(secret)) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  return candidate.includes(secret);
}
