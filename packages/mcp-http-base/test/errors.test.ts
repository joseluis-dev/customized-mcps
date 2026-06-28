import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  unauthorizedError,
  forbiddenError,
  serviceUnavailableError,
  sendJsonError,
  JSON_RPC_ERROR_CODES,
} from "../src/errors.js";

function makeRes(): ServerResponse & { _body: string; _status: number | undefined; _headers: Record<string, string> } {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  const res = new ServerResponse(req) as ServerResponse & {
    _body: string;
    _status: number | undefined;
    _headers: Record<string, string>;
  };
  res._body = "";
  res._status = undefined;
  res._headers = {};
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: string | number | string[]) => {
    res._headers[name.toLowerCase()] = String(value);
    return origSetHeader(name, value);
  }) as typeof res.setHeader;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = ((status: number, headers?: Record<string, string | number | string[]>) => {
    res._status = status;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        res._headers[k.toLowerCase()] = String(v);
      }
    }
    return origWriteHead(status, headers);
  }) as typeof res.writeHead;
  const origEnd = res.end.bind(res);
  res.end = ((chunk?: string | Buffer | Uint8Array) => {
    if (chunk) res._body += chunk.toString();
    return origEnd(chunk);
  }) as typeof res.end;
  return res;
}

describe("sanitized error envelopes", () => {
  describe("unauthorizedError (401)", () => {
    it("returns status 401 with a minimal JSON-RPC error body", () => {
      const env = unauthorizedError();
      expect(env.status).toBe(401);
      expect(env.body).toEqual({
        jsonrpc: "2.0",
        error: { code: JSON_RPC_ERROR_CODES.UNAUTHORIZED, message: "unauthorized" },
        id: null,
      });
    });

    it("does not include the supplied token, agent id, or keyHash", () => {
      const env = unauthorizedError({
        token: "supplied-token-xyz",
        agentId: "evil-agent",
        keyHash: "computed-keyhash-value",
      });
      const serialised = JSON.stringify(env.body);
      expect(serialised).not.toContain("supplied-token-xyz");
      expect(serialised).not.toContain("evil-agent");
      expect(serialised).not.toContain("computed-keyhash-value");
    });
  });

  describe("forbiddenError (403)", () => {
    it("returns status 403 with a minimal JSON-RPC error body", () => {
      const env = forbiddenError();
      expect(env.status).toBe(403);
      expect(env.body).toEqual({
        jsonrpc: "2.0",
        error: { code: JSON_RPC_ERROR_CODES.FORBIDDEN, message: "forbidden" },
        id: null,
      });
    });

    it("does not enumerate the agent's actual scopes or any other agent's scopes", () => {
      const env = forbiddenError({
        agentScopes: ["read:bi_catastro", "list:bi_catastro"],
        attempted: "read:reporting",
      });
      const serialised = JSON.stringify(env.body);
      expect(serialised).not.toContain("bi_catastro");
      expect(serialised).not.toContain("reporting");
      expect(serialised).not.toContain("read:bi_catastro");
      expect(serialised).not.toContain("list:bi_catastro");
    });
  });

  describe("serviceUnavailableError (503)", () => {
    it("returns status 503 with a minimal JSON-RPC error body", () => {
      const env = serviceUnavailableError();
      expect(env.status).toBe(503);
      expect(env.body).toEqual({
        jsonrpc: "2.0",
        error: { code: JSON_RPC_ERROR_CODES.SERVICE_UNAVAILABLE, message: "shutting-down" },
        id: null,
      });
    });
  });
});

describe("sendJsonError", () => {
  let res: ReturnType<typeof makeRes>;
  beforeEach(() => {
    res = makeRes();
  });
  afterEach(() => {
    // ServerResponse is bound to a fake socket; no cleanup needed.
  });

  it("writes the status code and JSON body to the response", () => {
    sendJsonError(res, unauthorizedError());
    expect(res._status).toBe(401);
    expect(res._headers["content-type"]).toMatch(/application\/json/);
    const parsed = JSON.parse(res._body);
    expect(parsed.error.code).toBe(JSON_RPC_ERROR_CODES.UNAUTHORIZED);
  });

  it("writes the forbidden envelope with status 403", () => {
    sendJsonError(res, forbiddenError());
    expect(res._status).toBe(403);
    const parsed = JSON.parse(res._body);
    expect(parsed.error.message).toBe("forbidden");
  });

  it("writes the service-unavailable envelope with status 503", () => {
    sendJsonError(res, serviceUnavailableError());
    expect(res._status).toBe(503);
    const parsed = JSON.parse(res._body);
    expect(parsed.error.message).toBe("shutting-down");
  });
});
