import { describe, expect, it } from "vitest";

import { estimateTokens } from "../tokens.js";
import { MockProvider } from "./mock.js";
import type { ChatCompletionChunk } from "./types.js";

const mock = new MockProvider();

async function drain(iter: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}

describe("MockProvider", () => {
  it("reports usage for the text it actually produced", async () => {
    // The point of the mock is that the console's numbers are arithmetic over
    // something real, not constants. If usage stopped matching the returned
    // text, every cost figure in the demo would quietly become fiction.
    const { response } = await mock.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What does the tollbooth do?" }],
    });

    const answer = response.choices[0]!.message.content;
    expect(response.usage.completion_tokens).toBe(estimateTokens(answer));
    expect(response.usage.total_tokens).toBe(
      response.usage.prompt_tokens + response.usage.completion_tokens,
    );
  });

  it("answers at greater length when asked at greater length", async () => {
    const short = await mock.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const long = await mock.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x".repeat(4_000) }],
    });

    expect(long.response.usage.completion_tokens).toBeGreaterThan(
      short.response.usage.completion_tokens,
    );
  });

  it("stays within max_tokens", async () => {
    const { response } = await mock.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x".repeat(4_000) }],
      max_tokens: 40,
    });

    expect(response.usage.completion_tokens).toBeLessThanOrEqual(40);
  });

  it("answers in the OpenAI response shape", async () => {
    const { response } = await mock.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });

    expect(response.object).toBe("chat.completion");
    expect(response.model).toBe("gpt-4o-mini");
    expect(response.choices[0]!.message.role).toBe("assistant");
    expect(response.choices[0]!.finish_reason).toBe("stop");
  });

  it("streams frames that reassemble to a whole answer with matching usage", async () => {
    // A streamed call has to bill exactly like a buffered one: the usage on the
    // trailing frame must describe the text the frames actually delivered, or the
    // console's numbers would depend on whether a client asked for a stream.
    const chunks = await drain(
      mock.stream({
        model: "gpt-4o",
        messages: [{ role: "user", content: "What does the tollbooth do?" }],
      }),
    );

    const content = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
    const usage = chunks.find((c) => c.usage)?.usage;

    expect(chunks[0]!.choices[0]!.delta.role).toBe("assistant");
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);
    expect(content.length).toBeGreaterThan(0);
    expect(usage?.completion_tokens).toBe(estimateTokens(content));
    expect(usage?.total_tokens).toBe(usage!.prompt_tokens + usage!.completion_tokens);
  });
});
