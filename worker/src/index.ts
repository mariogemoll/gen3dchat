export default {
  async fetch(request, env, ctx): Promise<Response> {
    return new Response("Hello from a TypeScript Worker!", {
      headers: { "content-type": "text/plain" },
    });
  },
};