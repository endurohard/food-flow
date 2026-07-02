import { jwtVerify } from 'jose';

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';
const JWT_SECRET = process.env.JWT_SECRET || '';

if (!JWT_SECRET) {
  console.warn('[auth] WARNING: JWT_SECRET is not set — Bearer JWT auth is disabled');
}

const secret = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null;

// food-flow JWT payload: { userId, role, enterpriseId, enterpriseRole } (HS256)
const ALLOWED_ROLES = ['admin', 'owner', 'manager', 'restaurant_owner'];
const ALLOWED_ENTERPRISE_ROLES = ['owner', 'admin', 'manager'];

// Access: internal token (service-to-service, e.g. wholesale-service)
// OR Bearer JWT of an admin/owner/manager (frontend).
export async function authenticate(req, res, next) {
  // Only accept X-Internal-Token when INTERNAL_TOKEN is actually configured
  if (INTERNAL_TOKEN && req.headers['x-internal-token'] === INTERNAL_TOKEN) {
    return next();
  }

  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ') && secret) {
    try {
      const { payload } = await jwtVerify(h.slice(7), secret, { algorithms: ['HS256'] });
      const roleOk = ALLOWED_ROLES.includes(payload.role)
        || ALLOWED_ENTERPRISE_ROLES.includes(payload.enterpriseRole);
      if (payload.userId && roleOk) {
        req.user = payload;
        return next();
      }
      return res.status(403).json({ error: 'forbidden', message: 'Insufficient role' });
    } catch {
      // invalid/expired token → 401 below
    }
  }
  return res.status(401).json({ error: 'unauthorized' });
}
