import { getCollection } from 'astro:content';

/** Published articles for one language, newest first. Ids look like "es/mi-articulo". */
export async function articles(lang, category) {
  const all = await getCollection('articulos', ({ id, data }) => id.startsWith(`${lang}/`) && !data.draft && (!category || data.category === category));
  return all.sort((a, b) => b.data.date - a.data.date).map((e) => ({ ...e, slug: e.id.slice(lang.length + 1) }));
}
