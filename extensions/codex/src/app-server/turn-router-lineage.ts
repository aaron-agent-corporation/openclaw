import { isJsonObject, type CodexServerNotification, type JsonValue } from "./protocol.js";

const CHILD_THREAD_PARENT_LIMIT = 512;

type Link<Route> = { parentThreadId: string; route: Route };

/**
 * Parent links of native subagent threads (spawn_agent), learned from
 * `thread/started`. Each link is pinned to the reserved ancestor route that was
 * live when the child was announced: a later route on the same parent thread
 * never inherits an outlived child, and released routes drop their lineage.
 */
export class SubagentLineage<Route extends { threadId: string; released?: unknown }> {
  private readonly links = new Map<string, Link<Route>>();

  record(
    notification: CodexServerNotification,
    liveRoute: (threadId: string) => Route | undefined,
  ): void {
    // Codex announces a child two ways: the child's own thread/started (with
    // its spawn source) and the parent's collabAgentToolCall items, which name
    // the receiver threads. Either may arrive first; both are accepted.
    for (const link of readSubagentThreadLinks(notification)) {
      if (link.threadId === link.parentThreadId || liveRoute(link.threadId)) {
        continue;
      }
      const route = liveRoute(link.parentThreadId) ?? this.resolve(link.parentThreadId);
      if (!route) {
        // No live OpenClaw turn owns this lineage; nothing may serve it later.
        continue;
      }
      if (this.links.size >= CHILD_THREAD_PARENT_LIMIT) {
        const oldest = this.links.keys().next().value;
        if (oldest !== undefined) {
          this.links.delete(oldest);
        }
      }
      this.links.set(link.threadId, { parentThreadId: link.parentThreadId, route });
    }
  }

  has(threadId: string): boolean {
    return this.links.has(threadId);
  }

  /** The pinned ancestor route of a subagent thread while that route is unreleased. */
  resolve(threadId: string): Route | undefined {
    const link = this.links.get(threadId);
    return link && !link.route.released ? link.route : undefined;
  }

  forget(route: Route): void {
    for (const [threadId, link] of this.links) {
      if (link.route === route) {
        this.links.delete(threadId);
      }
    }
  }
}

type SubagentThreadLink = { threadId: string; parentThreadId: string };

function readSubagentThreadLinks(notification: CodexServerNotification): SubagentThreadLink[] {
  if (notification.method === "thread/started") {
    const link = readSubagentThreadLink(notification.params);
    return link ? [link] : [];
  }
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return [];
  }
  const params = notification.params;
  if (!isJsonObject(params) || !isJsonObject(params.item)) {
    return [];
  }
  const item = params.item;
  if (item.type !== "collabAgentToolCall") {
    return [];
  }
  const sender = typeof item.senderThreadId === "string" ? item.senderThreadId : params.threadId;
  const parentThreadId = typeof sender === "string" ? sender.trim() : "";
  if (!parentThreadId) {
    return [];
  }
  const children = new Set<string>();
  if (Array.isArray(item.receiverThreadIds)) {
    for (const id of item.receiverThreadIds) {
      if (typeof id === "string" && id.trim()) {
        children.add(id.trim());
      }
    }
  }
  if (isJsonObject(item.agentsStates)) {
    for (const id of Object.keys(item.agentsStates)) {
      if (id.trim()) {
        children.add(id.trim());
      }
    }
  }
  return [...children].map((threadId) => ({ threadId, parentThreadId }));
}

function readSubagentThreadLink(value: JsonValue | undefined): SubagentThreadLink | undefined {
  if (!isJsonObject(value) || !isJsonObject(value.thread)) {
    return undefined;
  }
  const thread = value.thread;
  const threadId = typeof thread.id === "string" ? thread.id.trim() : "";
  if (!threadId) {
    return undefined;
  }
  let parentThreadId = typeof thread.parentThreadId === "string" ? thread.parentThreadId : "";
  if (!parentThreadId && isJsonObject(thread.source) && isJsonObject(thread.source.subAgent)) {
    const spawn = thread.source.subAgent.thread_spawn;
    if (isJsonObject(spawn) && typeof spawn.parent_thread_id === "string") {
      parentThreadId = spawn.parent_thread_id;
    }
  }
  parentThreadId = parentThreadId.trim();
  return parentThreadId ? { threadId, parentThreadId } : undefined;
}
