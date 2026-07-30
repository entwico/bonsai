import { type APIRoute } from 'astro';

// the package is referenced only through literal import.meta.resolve — no static
// import edge exists, so only the bundle scan can keep it in the pruned tree.
export const GET: APIRoute = async () => {
  const url = import.meta.resolve('escape-string-regexp');
  const mod = (await import(/* @vite-ignore */ url)) as { default: (s: string) => string };

  return new Response(JSON.stringify({ ok: true, url, escaped: mod.default('a.b*c') }), {
    headers: { 'content-type': 'application/json' },
  });
};
