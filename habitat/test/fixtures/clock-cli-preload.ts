const serializedResponses = process.env.HABITAT_CLI_TEST_RESPONSES;
if (!serializedResponses) {
  throw new Error("HABITAT_CLI_TEST_RESPONSES is required by the clock CLI test preload.");
}

const responses = JSON.parse(serializedResponses) as Record<string, unknown>;
const operatorToken = process.env.HABITAT_OPERATOR_TOKEN;

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const exactKey = `${method} ${url.pathname}${url.search}`;
  const pathKey = `${method} ${url.pathname}`;
  process.stderr.write(`__HABITAT_TEST_REQUEST__ ${exactKey}\n`);
  if (
    url.pathname.startsWith("/operator/") &&
    new Headers(init?.headers).get("authorization") !== `Bearer ${operatorToken}`
  ) {
    return new Response(JSON.stringify({ error: "Local operator authentication required" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const payload = exactKey in responses ? responses[exactKey] : responses[pathKey];
  if (payload === undefined) {
    return new Response(JSON.stringify({ error: "Unexpected test request" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as { eventStream?: unknown }).eventStream === "string"
  ) {
    return new Response((payload as { eventStream: string }).eventStream, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (url.pathname === "/state") {
    headers.etag = '"habitat-state-0"';
  }
  return new Response(JSON.stringify(payload), { headers });
}) as typeof fetch;
