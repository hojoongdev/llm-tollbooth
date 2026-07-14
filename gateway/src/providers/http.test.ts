import { describe, expect, it } from "vitest";

import { parseSseFrame, sseEvents } from "./http.js";

describe("parseSseFrame", () => {
  it("reads an OpenAI-style data-only frame", () => {
    expect(parseSseFrame('data: {"a":1}')).toEqual({ event: null, data: '{"a":1}' });
  });

  it("reads a named Anthropic-style frame", () => {
    expect(parseSseFrame("event: message_start\ndata: {}")).toEqual({
      event: "message_start",
      data: "{}",
    });
  });

  it("joins a multi-line data payload with newlines", () => {
    expect(parseSseFrame("data: line1\ndata: line2")).toEqual({
      event: null,
      data: "line1\nline2",
    });
  });

  it("drops a comment/keep-alive frame (no data line)", () => {
    expect(parseSseFrame(": ping")).toBeNull();
  });

  it("strips exactly one space after the colon, no more", () => {
    expect(parseSseFrame("data:  leading")).toEqual({ event: null, data: " leading" });
  });
});

async function collect(res: Response): Promise<Array<{ event: string | null; data: string }>> {
  const out: Array<{ event: string | null; data: string }> = [];
  for await (const frame of sseEvents(res)) out.push(frame);
  return out;
}

describe("sseEvents", () => {
  it("splits a body into frames on blank lines", async () => {
    const body = 'data: {"x":1}\n\ndata: {"x":2}\n\n';
    expect(await collect(new Response(body))).toEqual([
      { event: null, data: '{"x":1}' },
      { event: null, data: '{"x":2}' },
    ]);
  });

  it("handles CRLF and flushes a trailing frame with no blank line after it", async () => {
    const body = "event: a\r\ndata: 1\r\n\r\ndata: 2";
    expect(await collect(new Response(body))).toEqual([
      { event: "a", data: "1" },
      { event: null, data: "2" },
    ]);
  });

  it("passes OpenAI's [DONE] terminator through as data (the adapter ends on it)", async () => {
    const body = 'data: {"x":1}\n\ndata: [DONE]\n\n';
    const frames = await collect(new Response(body));
    expect(frames.at(-1)).toEqual({ event: null, data: "[DONE]" });
  });
});
