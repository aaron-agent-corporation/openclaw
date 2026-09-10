import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardAutoAdvanceService } from "./auto-advance.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardLifecycleService } from "./lifecycle-sync.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";

function memoryStore(
  options: {
    beforeRegister?: () => Promise<void>;
    beforeLookup?: () => Promise<void>;
  } = {},
): WorkboardKeyedStore {
  const rows = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      await options.beforeRegister?.();
      rows.set(key, value);
    },
    async lookup(key) {
      await options.beforeLookup?.();
      return rows.get(key);
    },
    async delete(key) {
      return rows.delete(key);
    },
    async entries() {
      return [...rows].map(([key, value]) => ({ key, value }));
    },
  };
}

describe("Workboard store lifetime", () => {
  it("joins queued mutations before closing and rejects new work", async () => {
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const persistence = memoryStore({
      beforeRegister: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    let closes = 0;
    const store = new WorkboardStore(persistence, {
      close: () => {
        closes += 1;
      },
    });
    const first = store.create({ title: "First" });
    await entered.promise;
    const queued = store.create({ title: "Queued" });
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await expect(store.create({ title: "Late" })).rejects.toThrow("workboard store is closed.");
    expect(closes).toBe(0);
    resume.resolve();
    await expect(first).resolves.toMatchObject({ title: "First" });
    await expect(queued).resolves.toMatchObject({ title: "Queued" });
    await closing;
    expect(closes).toBe(1);
    expect(await persistence.entries()).toHaveLength(2);
    await expect(store.list()).rejects.toThrow("workboard store is closed.");
  });

  it("keeps a whole admitted tool call alive across its reads", async () => {
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    let pause = false;
    const store = new WorkboardStore(
      memoryStore({
        beforeLookup: async () => {
          if (pause) {
            pause = false;
            entered.resolve();
            await resume.promise;
          }
        },
      }),
    );
    const card = await store.create({ title: "Read context", notes: "Keep the full result." });
    const tool = createWorkboardTools({ store }).find((entry) => entry.name === "workboard_read");
    if (!tool) {
      throw new Error("Workboard read tool is unavailable");
    }
    pause = true;
    const reading = tool.execute("read", { id: card.id });
    await entered.promise;
    const closing = store.close();
    resume.resolve();
    await expect(reading).resolves.toMatchObject({
      details: {
        card: { id: card.id, notes: "Keep the full result." },
        workerContext: expect.stringContaining("Keep the full result."),
      },
    });
    await closing;
    await expect(tool.execute("late", { id: card.id })).rejects.toThrow(
      "workboard store is closed.",
    );
  });

  it("does not let another store or a detached continuation revive a closed owner", async () => {
    const first = new WorkboardStore(memoryStore());
    const second = new WorkboardStore(memoryStore());
    const resume = createDeferred<void>();
    const { detached } = await first.runOperation(() => ({
      detached: resume.promise.then(() => first.create({ title: "Detached" })),
    }));
    await first.close();
    const rejected = expect(detached).rejects.toThrow("workboard store is closed.");
    resume.resolve();
    await rejected;
    await second.runOperation(async () => {
      await expect(first.create({ title: "Wrong owner" })).rejects.toThrow(
        "workboard store is closed.",
      );
      await expect(second.create({ title: "Own store" })).resolves.toMatchObject({
        title: "Own store",
      });
    });
    await second.close();
  });

  it("joins a stopped background sweep without reviving its lifecycle generation", async () => {
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    let closes = 0;
    const persistence = memoryStore();
    const store = new WorkboardStore(persistence, {
      close: () => {
        closes += 1;
      },
    });
    const sessionKey = "agent:main:background-sweep";
    const card = await store.create({
      title: "Running session",
      status: "running",
      sessionKey,
    });
    const service = createWorkboardLifecycleService({
      store,
      readSessions: async () => {
        entered.resolve();
        await resume.promise;
        return {
          complete: true,
          sessions: [{ key: sessionKey, status: "done", hasActiveRun: false }],
        };
      },
    });
    const context = {
      config: {},
      stateDir: "/unused-workboard-test-state",
      logger: { debug() {}, info() {}, warn: vi.fn(), error() {} },
    };
    service.onGatewayStop();
    try {
      await service.start(context);
      service.onGatewayStart();
      await entered.promise;
      await service.stop?.(context);
      const closing = store.close();
      expect(closes).toBe(0);
      resume.resolve();
      await closing;
      expect(closes).toBe(1);
      expect(await persistence.lookup(card.id)).toMatchObject({ card: { status: "running" } });
      expect(context.logger.warn).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      service.onGatewayStop();
      await service.stop?.(context);
      await store.close();
    }
  });

  it("drains an accepted automatic launch before closing and starts no further workers", async () => {
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const persistence = memoryStore();
    const close = vi.fn();
    const store = new WorkboardStore(persistence, { close });
    await store.upsertBoard({ id: "ops", orchestration: { autoAdvance: true } });
    const first = await store.create({
      title: "Accepted worker",
      boardId: "ops",
      status: "ready",
      agentId: "first",
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Still queued",
      boardId: "ops",
      status: "ready",
      agentId: "second",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn(async () => {
      entered.resolve();
      await resume.promise;
      return { runId: "accepted-run" };
    });
    const service = createWorkboardAutoAdvanceService({
      store,
      dispatch: ({ boardId, now, startGate }) =>
        dispatchAndStartWorkboardCards({
          store,
          subagent: { run },
          options: { boardId, now, startGate, workspaceAccess: { unrestricted: true } },
        }),
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    await service.start({ logger } as never);
    service.onLifecycleSweep();
    const passing = service.settle();
    try {
      await entered.promise;
      service.stop();
      const closing = store.close();
      await Promise.resolve();
      expect(close).not.toHaveBeenCalled();
      resume.resolve();
      await passing;
      await closing;
      expect(close).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
      expect(await persistence.lookup(first.id)).toMatchObject({
        card: { status: "running", runId: "accepted-run" },
      });
      expect(await persistence.lookup(second.id)).toMatchObject({ card: { status: "ready" } });
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      service.stop();
      await passing;
      await store.close();
    }
  });

  it("retains the same cleanup failure without retrying it", async () => {
    const failure = new Error("native close failed");
    let closes = 0;
    const store = new WorkboardStore(memoryStore(), {
      close: () => {
        closes += 1;
        throw failure;
      },
    });
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await expect(closing).rejects.toBe(failure);
    await expect(store.close()).rejects.toBe(failure);
    expect(closes).toBe(1);
    await expect(store.list()).rejects.toThrow("workboard store is closed.");
  });
});
