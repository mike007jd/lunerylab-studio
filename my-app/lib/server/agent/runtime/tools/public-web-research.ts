import { randomUUID } from "node:crypto";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function readTag(item: string, tag: string): string {
  return decodeXml(item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ?? "");
}

export function buildPublicWebResearchTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Search the public web only when the user explicitly asks for web research, current facts, or sources. Return source URLs and cite them in the final answer. Never use this for ordinary canvas work.",
    inputSchema: z.object({
      query: z.string().trim().min(2).max(300),
    }),
    async execute({ query }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      ctx.abortSignal?.throwIfAborted();
      const endpoint = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
      const response = await fetch(endpoint, {
        headers: { "user-agent": "LuneryLabStudio/1.0" },
        signal: ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`Public web search failed (${response.status}).`);
      const xml = await response.text();
      const sources = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
        .slice(0, 5)
        .map((match) => ({
          title: readTag(match[1] ?? "", "title"),
          url: readTag(match[1] ?? "", "link"),
          snippet: readTag(match[1] ?? "", "description").slice(0, 500),
        }))
        .filter((source) => /^https?:\/\//.test(source.url));
      ctx.recordStep({
        id: stepId,
        index: ctx.nextStepIndex(),
        toolName: "search_public_web",
        category: "observe",
        summary: `Researched the public web and found ${sources.length} source${sources.length === 1 ? "" : "s"}.`,
        artifacts: {},
        input: { query },
        output: { sources },
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return { ok: true, query, sources };
    },
  });
}
