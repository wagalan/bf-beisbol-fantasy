import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Articles live in src/content/articulos/<lang>/<slug>.md (the CMS writes them there).
const articulos = defineCollection({
  loader: glob({ base: './src/content/articulos', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    category: z.enum(['fantasy', 'lidom', 'general']).default('general'),
    summary: z.string().optional(),
    author: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { articulos };
