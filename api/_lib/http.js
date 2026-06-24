// api/_lib/http.js
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') {
    // Vercel pre-parses the JSON body, so the raw-stream size check below is
    // skipped — re-check the serialized size here so the 64 KB cap still applies.
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 64 * 1024) throw new HttpError(413, 'Payload too large');
    return req.body;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length === 0) return {};
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw new HttpError(413, 'Payload too large');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}
