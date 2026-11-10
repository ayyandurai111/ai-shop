import type { Request, Response, NextFunction } from 'express';
import { db } from './db.js';
import { isProd, opt } from './config.js';
import { ACCESS_PREFIX, resourceMetadataUrl, verifyAccessToken } from './oauth.js';
import { safeEqual } from './util.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email?: string };
    }
  }
}

/** 401 with the MCP discovery header (RFC 9728 / MCP authorization spec). */
function unauthorized(res: Response, hadToken: boolean): void {
  res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl()}"${hadToken ? ', error="invalid_token"' : ''}`);
  res.status(401).json({ error: 'Invalid or missing bearer token' });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return unauthorized(res, false);

  // Dev shortcut, disabled in production.
  const dev = opt('MCP_DEV_TOKEN');
  const devUser = opt('DEV_USER_ID');
  if (!isProd() && dev && devUser && safeEqual(token, dev)) {
    req.user = { id: devUser, email: 'demo@local' };
    return next();
  }

  // 1. OAuth access token issued by this server (looked up by SHA-256 hash).
  if (token.startsWith(ACCESS_PREFIX)) {
    let user: { id: string } | null;
    try {
      user = await verifyAccessToken(token);
    } catch {
      // Database problem: say so (503) instead of 401, so the client does not throw away a good login.
      res.status(503).json({ error: 'temporarily_unavailable' });
      return;
    }
    if (!user) return unauthorized(res, true);
    req.user = { id: user.id };
    return next();
  }

  // 2. Supabase JWT (the chat page and REST API).
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) return unauthorized(res, true);
    req.user = { id: data.user.id, email: data.user.email ?? undefined };
    next();
  } catch {
    unauthorized(res, true);
  }
}
