// api/_lib/http.js
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Generous cap for a full progress state (power users accumulate thousands of
// answered/picks/mistakes signatures). Well under Vercel's ~4.5MB body limit;
// the real anti-abuse guard is validate.js's per-map entry caps.
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') {
    // Vercel pre-parses the JSON body, so the raw-stream size check below is
    // skipped — re-check the serialized size here so the cap still applies.
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'Payload too large');
    return req.body;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length === 0) return {};
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'Payload too large');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}
