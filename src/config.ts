import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_PATH: z.string().default('./data/evalboard.db'),
  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be 64 hex characters. Run: npm run gen-key'),
});

export const config = schema.parse(process.env);
