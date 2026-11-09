import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './errors';

export type Role = 'shop' | 'rider' | 'admin';
export interface AuthUser {
  id: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const TOKEN_TTL_SECONDS = 7 * 24 * 3600;
const MIN_SECRET_LENGTH = 32;

export function assertSecret(secret: unknown): string {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET is required and must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

const sign = (secret: string, body: string): Buffer => createHmac('sha256', secret).update(body).digest();

/** HMAC-SHA256 signed bearer token: base64url(payload).base64url(signature). */
export function issueToken(secret: string, user: AuthUser, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const body = Buffer.from(
    JSON.stringify({ sub: user.id, role: user.role, iat: nowSeconds, exp: nowSeconds + TOKEN_TTL_SECONDS }),
  ).toString('base64url');
  return `${body}.${sign(secret, body).toString('base64url')}`;
}

export function verifyToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): AuthUser | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const given = Buffer.from(sig, 'base64url');
  const expected = sign(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const role = p.role;
    if (typeof p.sub !== 'string' || typeof p.exp !== 'number' || p.exp <= nowSeconds) return null;
    if (role !== 'shop' && role !== 'rider' && role !== 'admin') return null;
    return { id: p.sub, role };
  } catch {
    return null;
  }
}

/** preHandler factory: requires a valid bearer token whose role is in `roles`. */
export function requireRole(secret: string, ...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const user = token ? verifyToken(secret, token) : null;
    if (!user) throw new HttpError(401, 'unauthorized', 'Sign in required');
    if (!roles.includes(user.role)) throw new HttpError(403, 'forbidden', 'Not allowed for your role');
    req.user = user;
  };
}

export const userOf = (req: FastifyRequest): AuthUser => {
  if (!req.user) throw new HttpError(401, 'unauthorized', 'Sign in required');
  return req.user;
};
