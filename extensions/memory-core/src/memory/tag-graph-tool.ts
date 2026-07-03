// Agent-navigable tag co-occurrence traversal tool (TAG-01). Wires the already-shipped,
// read-only `readTagCooccurrence` seam into a memory-core tool so an agent can hop the tag
// graph as ranked lists: given a tag it returns neighboring tags ordered by descending
// co-occurrence weight, each with a bounded sample of the target refs at the intersection.
// Read-only and best-effort — the associative store is optional, so a read failure or an
// empty/absent store yields an empty traversal rather than an error (no-op when memory off).
import {
  readTagCooccurrence,
  type TagGraphTraversal,
} from "openclaw/plugin-sdk/memory-core-host-associative";
import {
  asToolParamsRecord,
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { Type } from "typebox";

// Flat args only (platform tool-schema rule): no enums/unions some providers reject.
export const TagGraphSchema = Type.Object({
  tag: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

// Cap the target refs rendered per neighbor: readTagCooccurrence already bounds the
// neighbor set, but a single hot tag can share many targets. Sampling keeps the tool
// output compact for the model while still proving each intersection (T-05-05).
const MAX_TARGET_SAMPLE = 8;

const EMPTY_TRAVERSAL: TagGraphTraversal = { tag: null, neighbors: [] };

function formatTraversal(traversal: TagGraphTraversal): TagGraphTraversal {
  return {
    tag: traversal.tag,
    neighbors: traversal.neighbors.map((neighbor) => ({
      ...neighbor,
      targets: neighbor.targets.slice(0, MAX_TARGET_SAMPLE),
    })),
  };
}

/**
 * Build the tag co-occurrence traversal tool descriptor. Returns null when no agent
 * session key is present (nothing to traverse), mirroring how the other memory-core
 * tools gate themselves. Session scope is the agent session key already threaded through
 * memory-core tools — no new key is minted.
 */
export function createTagGraphTool(options: {
  agentId?: string;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const sessionKey = options.agentSessionKey;
  if (!sessionKey) {
    return null;
  }
  return {
    label: "Memory Tag Graph",
    name: "memory_tag_neighbors",
    description:
      "Traverse the associative tag graph: given a tag (id or label), return co-occurring neighbor tags ranked by descending shared-target weight, each with a bounded sample of the target refs (box/span/turn) at the intersection. Read-only navigation over already-captured associations; returns an empty traversal when the tag is unknown or associative memory is off. Use it to discover related topics before a memory_search.",
    parameters: TagGraphSchema,
    execute: async (_toolCallId, toolParams) => {
      const rawParams = asToolParamsRecord(toolParams);
      const tag = readStringParam(rawParams, "tag", { required: true });
      const limit = readPositiveIntegerParam(rawParams, "limit");
      try {
        const traversal = readTagCooccurrence({
          agentId: options.agentId ?? "",
          sessionKey,
          tag,
          ...(limit == null ? {} : { limit }),
        });
        return jsonResult(formatTraversal(traversal));
      } catch {
        // Associative store is optional enrichment; never fail traversal over a read error.
        return jsonResult(EMPTY_TRAVERSAL);
      }
    },
  };
}
