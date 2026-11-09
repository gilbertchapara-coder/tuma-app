import { z } from 'zod';
import { HttpError } from './errors';

/** Parses with Zod; a failure becomes a 400 naming the first bad field. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const first = issues[0];
  const where = first?.path ? `${first.path}: ` : '';
  throw new HttpError(400, 'validation', `${where}${first?.message ?? 'Invalid request'}`, { issues });
}

export const uuidParam = z.object({ id: z.uuid() }).strict();

/** E.164-style phone after removing spaces and dashes. */
export const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'must be an international phone number such as +263771234567'));

export const httpsUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      return new URL(s).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an https URL');

export const centsSchema = z.number().int().positive().max(100_000_000);
