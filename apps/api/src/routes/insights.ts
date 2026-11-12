import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole } from '../auth';
import { HttpError } from '../errors';
import { listInsights, refreshInsights } from '../intelligence/research';
import { parse } from '../validate';

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).strict();

export const insightRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const admin = requireRole(deps.jwtSecret, 'admin');
    let lastRefreshAt = 0;
    let running = false;

    // What the research layer has found. It is information for the owner: nothing here changes any setting.
    app.get('/admin/insights', { preHandler: admin }, async (req) => {
      const { limit } = parse(listQuery, req.query);
      return { advisoryOnly: true, connected: deps.research !== null, insights: await listInsights(deps.pool, limit) };
    });

    // Looks for new items now. Outside requests carry only the fixed search words in the research settings.
    app.post('/admin/insights/refresh', { preHandler: admin }, async () => {
      if (!deps.research) throw new HttpError(409, 'research_not_connected', 'No research source is connected');
      if (running || Date.now() - lastRefreshAt < deps.researchMinGapMs) {
        throw new HttpError(429, 'too_many_requests', 'The last search was just now, try again in a few minutes');
      }
      running = true;
      try {
        lastRefreshAt = Date.now();
        return await refreshInsights(deps.pool, deps.research, deps.researchTopics);
      } finally {
        running = false;
      }
    });
  };
