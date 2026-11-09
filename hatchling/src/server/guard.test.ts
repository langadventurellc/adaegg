import { describe, expect, it } from "vitest";
import { checkRequest } from "./guard.ts";

const json = { "content-type": "application/json" };
const req = (method: string, headers: Record<string, string | string[] | undefined>) =>
  checkRequest({ method, headers, port: 4747 });

describe("checkRequest host", () => {
  it.each(["localhost:4747", "127.0.0.1:4747", "LocalHost:4747"])("accepts %s", (host) => {
    expect(req("GET", { host })).toBeNull();
  });

  it.each([undefined, "localhost:4748", "evil.example:4747", "localhost:4747.evil.example", "[::1]:4747"])(
    "refuses host %s",
    (host) => {
      expect(req("GET", { host })?.status).toBe(403);
    },
  );

  it("refuses a host given as an array", () => {
    expect(req("GET", { host: ["localhost:4747"] })?.status).toBe(403);
  });

  it("refuses a bad host before anything else", () => {
    expect(req("PUT", { host: "evil.example:4747" })?.status).toBe(403);
  });
});

describe("checkRequest methods", () => {
  const host = "localhost:4747";

  it("accepts GET and HEAD with an Origin header", () => {
    expect(req("GET", { host, origin: "http://evil.example" })).toBeNull();
    expect(req("HEAD", { host })).toBeNull();
  });

  it("refuses POST without a JSON content type", () => {
    expect(req("POST", { host })?.status).toBe(415);
    expect(req("POST", { host, "content-type": "text/plain" })?.status).toBe(415);
    expect(req("POST", { host, "content-type": "application/x-www-form-urlencoded" })?.status).toBe(415);
  });

  it("accepts JSON with parameters, in any case", () => {
    expect(req("POST", { host, "content-type": "application/json; charset=utf-8" })).toBeNull();
    expect(req("POST", { host, "content-type": "Application/JSON" })).toBeNull();
  });

  it("refuses a cross-site Origin and accepts a matching or missing one", () => {
    expect(req("POST", { host, ...json, origin: "http://evil.example" })?.status).toBe(403);
    expect(req("POST", { host, ...json, origin: "http://localhost:4747" })).toBeNull();
    expect(req("POST", { host, ...json })).toBeNull();
  });

  it("answers 405 for PUT and DELETE once content type and Origin pass", () => {
    expect(req("PUT", { host, ...json })?.status).toBe(405);
    expect(req("DELETE", { host, ...json, origin: "http://localhost:4747" })?.status).toBe(405);
  });

  it("checks content type and Origin before the method", () => {
    expect(req("DELETE", { host })?.status).toBe(415);
    expect(req("PUT", { host, "content-type": "text/plain" })?.status).toBe(415);
    expect(req("PUT", { host, ...json, origin: "http://evil.example" })?.status).toBe(403);
  });
});
