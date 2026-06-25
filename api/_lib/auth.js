// api/_lib/auth.js
import jwt from 'jsonwebtoken';

const ISSUER = 'auth.sophiebi.com';

export function parseCookies(req) {
  const h = req.headers?.cookie;
  if (!h) return {};
  return Object.fromEntries(h.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, decodeURIComponent(v.join('='))];
  }));
}

export function extractAuthToken(req) {
  const auth = req.headers?.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookies(req).authToken || null;
}

export function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  // userId is the canonical claim (s0phi3 signs userId+username; no `sub`).
  return jwt.verify(token, secret, { algorithms: ['HS256'], issuer: ISSUER });
}

// Resolve the request's user, or null if unauthenticated/invalid.
export function getUser(req) {
  const token = extractAuthToken(req);
  if (!token) return null;
  try {
    const d = verifyToken(token);
    const userId = d.userId || d.sub;
    if (!userId) return null;
    return { userId: String(userId), username: String(d.username || 'anon').slice(0, 32) };
  } catch {
    return null;
  }
}
