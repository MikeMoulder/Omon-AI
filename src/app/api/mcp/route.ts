/**
 * Omon's MCP endpoint. Streamable HTTP, JSON-RPC over POST.
 *
 *   POST /api/mcp
 *
 * The counterpart to `src/lib/mcp.ts`, which is a client for Binance's MCP
 * server. Point any MCP client at this URL and it can read what Omon knows.
 *
 * ## Why this exists at all
 *
 * Consuming Agent OS makes a project an Agent OS user. Serving MCP makes it
 * something other agents can build on, which is the direction the platform is
 * actually pointing. Omon reads Binance over one MCP connection and publishes
 * its own conclusions over another, and the paid tools mean that second
 * connection is a business rather than a demo.
 *
 * ## Content negotiation
 *
 * A Streamable HTTP server may answer `application/json` or `text/event-stream`
 * and the client picks via `Accept`. Both are implemented, because Omon's own
 * client parses both and a server that only spoke one would not survive contact
 * with the other half of this codebase.
 *
 * ## Payment
 *
 * MCP has no native concept of paying for a tool call, so the 402 rides in the
 * JSON-RPC error envelope under code -32002 with the challenge in `error.data`.
 * A caller that then attaches an `X-PAYMENT` header to its next POST gets the
 * full result — the header is forwarded verbatim to the HTTP route that already
 * knows how to settle it.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  PAYMENT_REQUIRED,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  callFreeTool,
  toolByName,
  toolDescriptors,
} from "@/lib/mcp-server";

export const dynamic = "force-dynamic";

type JsonRpcId = string | number | null;

function ok(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function err(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data ? { data } : {}) } };
}

/**
 * Wrap a payload in the shape `tools/call` returns.
 *
 * Both `content` and `structuredContent` are sent: older clients read the text
 * block, newer ones read the structured field, and sending one without the
 * other silently breaks half of them.
 */
function toolResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
    isError,
  };
}

/**
 * Call one of the paid HTTP routes on this same origin, forwarding the caller's
 * payment header.
 *
 * Self-fetch rather than importing the handler, so the request passes through
 * the x402 wrapper and the purchase log exactly as an outside buyer's would. A
 * purchase made over MCP is therefore indistinguishable in `data/payments.jsonl`
 * from one made over HTTP, which is the point — it is the same sale.
 */
async function proxyPaid(
  request: NextRequest,
  path: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, request.nextUrl.origin);
  const limit = Number(args?.limit);
  if (Number.isFinite(limit) && limit > 0) url.searchParams.set("limit", String(limit));

  const payment = request.headers.get("x-payment");
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(payment ? { "x-payment": payment } : {}),
    },
    cache: "no-store",
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = { error: `${path} returned ${res.status} with no JSON body` };
  }

  return { status: res.status, body };
}

async function dispatch(request: NextRequest, message: {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<unknown | null> {
  const id = message.id ?? null;
  const method = message.method ?? "";
  const params = message.params ?? {};

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Omon is an autonomous trading agent on Binance Agent OS. Four tools are free: " +
          "omon_rails, omon_pnl, omon_positions, omon_gate. Two cost one cent each over " +
          "x402: omon_intel and omon_signal. Calling a paid tool without payment returns " +
          "error -32002 carrying the challenge and a redacted preview.",
      });

    // A notification has no id and takes no response at all. Returning one to a
    // strict client is a protocol violation, so this returns null and the
    // transport answers 202 with an empty body.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: toolDescriptors() });

    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = toolByName(name);

      if (!tool) {
        return err(id, -32602, `Unknown tool: ${name}`, {
          available: toolDescriptors().map((t) => t.name),
        });
      }

      if (!tool.paid) {
        try {
          return ok(id, toolResult(callFreeTool(name, args)));
        } catch (e) {
          // A tool that throws is a result with isError set, not a transport
          // failure — the call reached the server and the server answered.
          return ok(id, toolResult({ error: String(e) }, true));
        }
      }

      const { status, body } = await proxyPaid(request, tool.paid.path, args);

      if (status === 402) {
        return err(id, PAYMENT_REQUIRED, `${name} requires payment`, {
          // Whatever the 402 route said: the challenge and the redacted preview.
          ...(body as Record<string, unknown>),
          payWith:
            "Attach the settled x402 payment as an X-PAYMENT header on your next POST " +
            "to this endpoint, or buy over HTTP at the path below.",
          httpPath: tool.paid.path,
        });
      }

      if (status !== 200) {
        return ok(id, toolResult({ error: `upstream ${tool.paid.path} returned ${status}`, body }, true));
      }

      return ok(id, toolResult(body));
    }

    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(request: NextRequest) {
  let message: { id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
  try {
    message = await request.json();
  } catch {
    return NextResponse.json(err(null, -32700, "Parse error"), { status: 400 });
  }

  const response = await dispatch(request, message);

  // Notification: acknowledged, nothing to say.
  if (response === null) return new NextResponse(null, { status: 202 });

  // The client decides the framing. Omon's own client parses both, so both are
  // served rather than picking one and hoping.
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    const body = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
    return new NextResponse(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }

  return NextResponse.json(response, {
    headers: { "cache-control": "no-store", "mcp-protocol-version": PROTOCOL_VERSION },
  });
}

/**
 * A GET here is almost always a human or a crawler rather than an MCP client,
 * so it answers with what this endpoint is and how to drive it instead of a bare
 * 405. Discoverability costs nothing.
 */
export function GET() {
  return NextResponse.json(
    {
      server: { name: SERVER_NAME, version: SERVER_VERSION, protocolVersion: PROTOCOL_VERSION },
      transport: "Streamable HTTP. POST JSON-RPC 2.0 to this URL.",
      tools: toolDescriptors().map((t) => t.name),
      example: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      },
      paid: {
        tools: ["omon_intel", "omon_signal"],
        errorCode: PAYMENT_REQUIRED,
        how: "Call it, read the challenge from error.data, settle it, then resend with an X-PAYMENT header.",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
