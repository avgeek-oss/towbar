export function GET() {
  return new Response(null, {
    status: 302,
    headers: { Location: "/brand/towbar-favicon.png" },
  });
}
