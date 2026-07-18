import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError } from "@/lib/server/errors";
import { parseFormData, parseJsonBody, parseWithSchema } from "@/lib/server/http-validation";

const schema = z
  .object({
    name: z.string().min(1, "name is required"),
    count: z.number().int().optional(),
  })
  .strict();

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("parseWithSchema", () => {
  it("returns typed data for a valid value", () => {
    expect(parseWithSchema(schema, { name: "ok", count: 2 })).toEqual({ name: "ok", count: 2 });
  });

  it("throws a 400 invalid_body ApiError with fieldErrors on failure", () => {
    try {
      parseWithSchema(schema, { name: "" });
      throw new Error("expected parseWithSchema to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).toBe(400);
      expect(apiError.code).toBe("invalid_body");
      expect(apiError.message).toBe("name is required");
      expect(apiError.details).toEqual({ fieldErrors: { name: ["name is required"] } });
    }
  });

  it("rejects unknown keys under .strict()", () => {
    expect(() => parseWithSchema(schema, { name: "ok", extra: 1 })).toThrow(ApiError);
  });
});

describe("parseJsonBody", () => {
  it("parses and validates a JSON request body", async () => {
    await expect(parseJsonBody(jsonRequest({ name: "ok" }), schema)).resolves.toEqual({ name: "ok" });
  });

  it("treats a syntactically invalid body as a validation failure (400)", async () => {
    const bad = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    await expect(parseJsonBody(bad, schema)).rejects.toMatchObject({
      status: 400,
      code: "invalid_body",
    });
  });
});

describe("parseFormData", () => {
  it("returns the FormData for a urlencoded body", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "hello" }),
    });
    const form = await parseFormData(req);
    expect(form.get("prompt")).toBe("hello");
  });

  it("returns the FormData for a multipart body", async () => {
    const form = new FormData();
    form.set("prompt", "hi");
    const req = new Request("http://localhost/api/test", { method: "POST", body: form });
    const parsed = await parseFormData(req);
    expect(parsed.get("prompt")).toBe("hi");
  });

  // Regression: a non-form body (e.g. application/json) made Request.formData()
  // throw a TypeError that escaped as an opaque 500 from /api/generate/{images,
  // video} and /api/assets/upload. It must now fail fast as a typed 400.
  it("rejects a JSON body as a 400 invalid_content_type instead of throwing a raw TypeError", async () => {
    const makeReq = () =>
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "x" }),
      });
    await expect(parseFormData(makeReq())).rejects.toMatchObject({
      status: 400,
      code: "invalid_content_type",
    });
    await expect(parseFormData(makeReq())).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a text/plain body as a 400", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not a form",
    });
    await expect(parseFormData(req)).rejects.toMatchObject({
      status: 400,
      code: "invalid_content_type",
    });
  });
});
