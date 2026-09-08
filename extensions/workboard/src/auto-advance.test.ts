// Workboard tests cover deterministic board auto-advance.
import type { WorkboardBoardMetadata, WorkboardCard } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkboardAutoAdvanceService,
  describeWorkboardIdleReason,
  WORKBOARD_AUTO_ADVANCE_RETRY_BASE_MS,
  type WorkboardAutoAdvanceService,
} from "./auto-advance.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardLifecycleService, syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { workboardSessionKeyForCard } from "./session-link.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

type Harness = {
  store: WorkboardStore;
  service: WorkboardAutoAdvanceService;
  run: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  clock: { now: number };
};

const services: WorkboardAutoAdvanceService[] = [];

async function createHarness(options: { now?: number } = {}): Promise<Harness> {
  const store = new WorkboardStore(createMemoryStore());
  const clock = { now: options.now ?? Date.now() };
  let runCounter = 0;
  const run = vi.fn(async () => ({ runId: `run-${++runCounter}` }));
  const dispatch = vi.fn(
    async ({
      boardId,
      now,
      startGate,
    }: {
      boardId: string;
      now: number;
      startGate: (board: WorkboardBoardMetadata | undefined) => boolean;
    }) =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { boardId, now, startGate, workspaceAccess: { unrestricted: true } },
      }),
  );
  const service = createWorkboardAutoAdvanceService({ store, dispatch, now: () => clock.now });
  const logger = { info: vi.fn(), warn: vi.fn() };
  await service.start({ logger } as never);
  // Readiness comes from the first lifecycle sweep, as in the Gateway.
  service.onLifecycleSweep();
  await service.settle();
  services.push(service);
  return { store, service, run, dispatch, logger, clock };
}

async function createReadyCard(
  store: WorkboardStore,
  input: { title: string; boardId?: string; agentId?: string; status?: WorkboardCard["status"] },
) {
  return await store.create({
    title: input.title,
    status: input.status ?? "ready",
    boardId: input.boardId ?? "ops",
    ...(input.agentId ? { agentId: input.agentId } : {}),
    workspaceAccess: { unrestricted: true },
  });
}

async function enableBoard(store: WorkboardStore, boardId = "ops") {
  return await store.upsertBoard({ id: boardId, orchestration: { autoAdvance: true } });
}

async function endWorker(store: WorkboardStore, card: WorkboardCard, outcome: "ok" | "error") {
  const current = await store.get(card.id);
  return await syncWorkboardSubagentEnded({
    store,
    event: {
      targetSessionKey: workboardSessionKeyForCard(card),
      runId: current?.runId,
      // Clearly after the card's last status transition so the lifecycle write is not stale.
      endedAt: Math.max(Date.now(), current?.updatedAt ?? 0) + 1_000,
      outcome,
    },
  });
}

async function boardStatus(
  service: Pick<WorkboardAutoAdvanceService, "describeBoards">,
  store: WorkboardStore,
  boardId = "ops",
) {
  const boards = service.describeBoards((await store.listBoards()).boards);
  return boards.find((board) => board.id === boardId)?.autoAdvance;
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.onGatewayStop();
    await service.stop?.({ logger: { info: vi.fn(), warn: vi.fn() } } as never);
  }
  vi.useRealTimers();
});

describe("Workboard auto-advance", () => {
  it("starts exactly one worker for an eligible Ready card on an enabled board", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    const card = await createReadyCard(store, { title: "First" });

    await service.settle();

    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      execution: { status: "running", runId: "run-1" },
    });
    const status = await boardStatus(service, store);
    expect(status).toMatchObject({
      enabled: true,
      lastTrigger: "change",
      lastStart: { cardId: card.id, runId: "run-1" },
    });
  });

  it("does not launch anything on boards that never opted in", async () => {
    const { store, service, run } = await createHarness();
    await store.upsertBoard({ id: "ops", orchestration: { autoDecompose: true } });
    await createReadyCard(store, { title: "Manual only" });
    service.request({ trigger: "sweep" });

    await service.settle();

    expect(run).not.toHaveBeenCalled();
    const status = await boardStatus(service, store);
    expect(status).toBeUndefined();
  });

  it("does not launch on an archived board and stops when the board is disabled", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    await store.archiveBoard("ops", true);
    await createReadyCard(store, { title: "Archived board card" });
    service.request({ trigger: "sweep" });
    await service.settle();
    expect(run).not.toHaveBeenCalled();
    const archived = await boardStatus(service, store);
    expect(archived).toEqual({ enabled: false, idleReason: "Board is archived." });

    await store.archiveBoard("ops", false);
    await service.settle();
    expect(run).toHaveBeenCalledTimes(1);

    await store.upsertBoard({ id: "ops", orchestration: { autoAdvance: false } });
    const running = (await store.list({ boardId: "ops" }))[0];
    await createReadyCard(store, { title: "Queued after disable", agentId: "other" });
    service.request({ trigger: "sweep" });
    await service.settle();

    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(running!.id)).resolves.toMatchObject({ status: "running" });
  });

  it("does not start a card when the board is disabled or archived mid-pass", async () => {
    for (const disable of [
      { orchestration: { autoAdvance: false } },
      { archived: true },
    ] as const) {
      const { store, service, run } = await createHarness();
      await enableBoard(store);
      const card = await createReadyCard(store, { title: "Racing disable" });
      const originalList = store.list.bind(store);
      let flipped = false;
      vi.spyOn(store, "list").mockImplementation(async (options) => {
        const cards = await originalList(options);
        // The dispatcher's own candidate read happens after the board snapshot
        // that admitted this pass; flip the board setting there.
        if (!flipped && options?.boardId === "ops" && cards.some((c) => c.id === card.id)) {
          flipped = true;
          await store.upsertBoard({ id: "ops", ...disable });
        }
        return cards;
      });

      await service.settle();

      expect(run).not.toHaveBeenCalled();
      await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
      expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it("hands a claimed card back when the board is disabled between claim and launch", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    const card = await createReadyCard(store, { title: "Disabled after claim" });
    const originalContext = store.buildWorkerContext.bind(store);
    vi.spyOn(store, "buildWorkerContext").mockImplementationOnce(async (id) => {
      // Runs after the claim and before the prepared launch that precedes subagent.run.
      await store.upsertBoard({ id: "ops", orchestration: { autoAdvance: false } });
      return await originalContext(id);
    });

    await service.settle();

    expect(run).not.toHaveBeenCalled();
    const current = await store.get(card.id);
    expect(current).toMatchObject({ status: "ready" });
    expect(current?.metadata?.claim).toBeUndefined();
    expect(current?.metadata?.automation?.launch).toBeUndefined();
    const status = await boardStatus(service, store);
    expect(status).toBeUndefined();
  });

  it("re-runs after a board setting change instead of treating it as bookkeeping", async () => {
    const { store, service, run, dispatch } = await createHarness();
    await enableBoard(store);
    await store.create({
      title: "Needs authority",
      status: "ready",
      boardId: "ops",
      workspace: { kind: "dir", path: "/outside" },
    });
    await service.settle();
    expect(run).not.toHaveBeenCalled();
    const calls = dispatch.mock.calls.length;
    expect((await boardStatus(service, store))?.retryAt).toBeDefined();

    await store.upsertBoard({ id: "ops", defaultWorkspace: { kind: "scratch" } });
    await service.settle();

    expect(dispatch.mock.calls.length).toBe(calls + 1);
    expect((await boardStatus(service, store))?.lastFailure).toBeDefined();
  });

  it("stops starting further cards once the Gateway halts mid-pass", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    await createReadyCard(store, { title: "First lane", agentId: "alpha" });
    const second = await createReadyCard(store, { title: "Second lane", agentId: "beta" });
    run.mockImplementationOnce(async () => {
      service.onGatewayStop();
      return { runId: "run-during-stop" };
    });

    await service.settle();

    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "ready" });
    expect((await store.get(second.id))?.metadata?.claim).toBeUndefined();
  });

  it("re-runs when a failed card is corrected while the pass is still finishing", async () => {
    const { store, service, run, dispatch } = await createHarness();
    await enableBoard(store);
    const card = await store.create({
      title: "Fixed mid-pass",
      status: "ready",
      boardId: "ops",
      workspace: { kind: "dir", path: "/outside" },
    });
    const originalDispatch = dispatch.getMockImplementation()!;
    let fixed = false;
    dispatch.mockImplementation(async (input) => {
      const result = await originalDispatch(input);
      if (!fixed && result.startFailures.some((failure) => failure.cardId === card.id)) {
        fixed = true;
        // Operator repairs the card between the dispatcher's last write and the
        // pass's final read; the change must not be mistaken for our own.
        await store.update(card.id, {
          workspace: { kind: "scratch" },
          workspaceAccess: { unrestricted: true },
        });
      }
      return result;
    });

    await service.settle();

    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "running" });
  });

  it("starts the next eligible card when a worker finishes, without a model call", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    const first = await createReadyCard(store, { title: "First" });
    const second = await createReadyCard(store, { title: "Second" });
    await service.settle();
    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "ready" });

    await store.complete(first.id, { summary: "done" }, null);
    await service.settle();

    expect(run).toHaveBeenCalledTimes(2);
    await expect(store.get(second.id)).resolves.toMatchObject({
      status: "running",
      execution: { runId: "run-2" },
    });
  });

  it("holds the owner lane while finished work awaits review and explains why", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    const first = await createReadyCard(store, { title: "Needs review" });
    const second = await createReadyCard(store, { title: "Waiting" });
    await service.settle();
    expect(run).toHaveBeenCalledTimes(1);

    await endWorker(store, first, "ok");
    service.onLifecycleMatched({ cards: [first] });
    await service.settle();

    await expect(store.get(first.id)).resolves.toMatchObject({ status: "review" });
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "ready" });
    expect(run).toHaveBeenCalledTimes(1);
    const status = await boardStatus(service, store);
    expect(status?.idleReason).toContain("Needs review (review)");
    expect(status?.lastTrigger).toBe("lifecycle");

    await store.complete(first.id, { summary: "accepted" }, null);
    await service.settle();

    expect(run).toHaveBeenCalledTimes(2);
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "running" });
  });

  it("promotes and starts a dependent card once its parent completes", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    const parent = await createReadyCard(store, { title: "Parent" });
    const child = await createReadyCard(store, { title: "Child", status: "backlog" });
    await store.linkCards(parent.id, child.id);
    await service.settle();
    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(child.id)).resolves.toMatchObject({ status: "todo" });

    await store.complete(parent.id, { summary: "done" }, null);
    await service.settle();

    expect(run).toHaveBeenCalledTimes(2);
    await expect(store.get(child.id)).resolves.toMatchObject({ status: "running" });
  });

  it("logs a no-start reason once, even when a productive pass first computed it", async () => {
    const { store, service, logger } = await createHarness();
    await enableBoard(store);
    await createReadyCard(store, { title: "Running", agentId: "roscoe" });
    await createReadyCard(store, { title: "Waiting", agentId: "roscoe" });
    await service.settle();
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("idle ("));

    service.onLifecycleSweep();
    await service.settle();
    service.onLifecycleSweep();
    await service.settle();

    const idleLogs = logger.info.mock.calls.filter(([line]) => String(line).includes("idle ("));
    expect(idleLogs).toHaveLength(1);
    expect(idleLogs[0]?.[0]).toContain("Waiting waits for roscoe to finish Running (running)");
    const status = await boardStatus(service, store);
    expect(status?.passStartedAt).toBeUndefined();
  });

  it("starts the next card in the same lane after its worker is killed by a restart", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    const first = await createReadyCard(store, { title: "Killed", agentId: "roscoe" });
    const second = await createReadyCard(store, { title: "Next up", agentId: "roscoe" });
    await service.settle();
    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "ready" });

    // The Gateway restart ends the worker session; the lifecycle sweep reports it.
    await endWorker(store, first, "error");
    service.onLifecycleMatched({ cards: [first] });
    await service.settle();

    const killed = await store.get(first.id);
    expect(killed?.status).toBe("blocked");
    expect(killed?.metadata?.claim).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "running" });
  });

  it("keeps advancing other lanes when an unrelated card failed earlier", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    const failed = await createReadyCard(store, { title: "Failed earlier", agentId: "alpha" });
    await service.settle();
    await endWorker(store, failed, "error");
    await expect(store.get(failed.id)).resolves.toMatchObject({ status: "blocked" });

    await createReadyCard(store, { title: "Beta work", agentId: "beta" });
    await service.settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      lane: expect.stringContaining("workboard:ops:"),
    });
  });

  it("does not duplicate starts across repeated events, manual dispatch, and change bursts", async () => {
    const { store, service, run, dispatch } = await createHarness();
    await enableBoard(store);
    const card = await createReadyCard(store, { title: "Once" });
    service.request({ trigger: "lifecycle", boardIds: ["ops"] });
    service.request({ trigger: "sweep" });
    service.request({ trigger: "change" });
    const manual = dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { boardId: "ops", workspaceAccess: { unrestricted: true } },
    });
    await service.settle();
    await manual;
    service.request({ trigger: "sweep" });
    await service.settle();

    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "running" });
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("re-evaluates after a pass when state changed during it", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    const first = await createReadyCard(store, { title: "First", agentId: "alpha" });
    let injected = false;
    run.mockImplementation(async () => {
      if (!injected) {
        injected = true;
        await createReadyCard(store, { title: "Arrived mid-pass", agentId: "beta" });
      }
      return { runId: `run-${run.mock.calls.length}` };
    });

    await service.settle();

    expect(run).toHaveBeenCalledTimes(2);
    await expect(store.get(first.id)).resolves.toMatchObject({ status: "running" });
    const cards = await store.list({ boardId: "ops" });
    expect(cards.filter((card) => card.status === "running")).toHaveLength(2);
  });

  it("respects capacity and priority ordering", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    await createReadyCard(store, { title: "Low", agentId: "a" });
    const urgent = await store.create({
      title: "Urgent",
      status: "ready",
      boardId: "ops",
      priority: "urgent",
      agentId: "b",
      workspaceAccess: { unrestricted: true },
    });
    await createReadyCard(store, { title: "Third", agentId: "c" });
    await createReadyCard(store, { title: "Fourth", agentId: "d" });

    await service.settle();

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ lane: `workboard:ops:${urgent.id}` });
    const cards = await store.list({ boardId: "ops" });
    expect(cards.filter((card) => card.status === "ready").map((card) => card.title)).toEqual([
      "Fourth",
    ]);
  });

  it("recovers a stranded queue after a Gateway restart via the lifecycle sweep", async () => {
    const { store, service, run, dispatch, clock } = await createHarness();
    await enableBoard(store);
    const first = await createReadyCard(store, { title: "First" });
    const second = await createReadyCard(store, { title: "Second" });
    await service.settle();
    expect(run).toHaveBeenCalledTimes(1);
    // The Gateway restarts: the old service is gone when completion lands.
    service.onGatewayStop();
    await service.stop?.({ logger: { info: vi.fn(), warn: vi.fn() } } as never);
    await store.complete(first.id, { summary: "done" }, null);
    const restarted = createWorkboardAutoAdvanceService({
      store,
      dispatch,
      now: () => clock.now,
    });
    services.push(restarted);
    await restarted.start({ logger: { info: vi.fn(), warn: vi.fn() } } as never);
    // A change event during startup must not dispatch before reconciliation.
    await createReadyCard(store, { title: "Arrived during startup", agentId: "other" });
    await restarted.settle();
    expect(run).toHaveBeenCalledTimes(1);

    restarted.onLifecycleSweep();
    await restarted.settle();

    expect(run).toHaveBeenCalledTimes(3);
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "running" });
    const status = await boardStatus(restarted, store);
    expect(status?.lastTrigger).toBe("gateway-start");
  });

  it("runs a pass after the lifecycle service finishes its sweep", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    await createReadyCard(store, { title: "Sweep start" });
    service.onGatewayStop();
    const lifecycle = createWorkboardLifecycleService({
      store,
      readSessions: vi.fn().mockResolvedValue({ sessions: [], complete: true }),
      onReconciled: service.onLifecycleSweep,
    });
    await lifecycle.start({ logger: { warn: vi.fn() } } as never);
    lifecycle.onGatewayStart();

    await vi.waitFor(async () => {
      await service.settle();
      expect(run).toHaveBeenCalledTimes(1);
    });
    lifecycle.onGatewayStop();
    await lifecycle.stop?.({ logger: { warn: vi.fn() } } as never);
  });

  it("records a visible launch failure, leaves no claim, and backs off instead of hot-looping", async () => {
    const { store, service, run, dispatch, logger, clock } = await createHarness();
    await enableBoard(store);
    const card = await createReadyCard(store, { title: "Cannot start" });
    run.mockRejectedValue(new Error("provider outage"));

    await service.settle();

    const blocked = await store.get(card.id);
    expect(blocked).toMatchObject({ status: "blocked" });
    expect(blocked?.metadata?.claim).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("provider outage"));
    let status = await boardStatus(service, store);
    expect(status?.lastFailure).toMatchObject({
      cardId: card.id,
      error: expect.stringContaining("provider outage"),
    });
    expect(status?.retryAt).toBe(clock.now + WORKBOARD_AUTO_ADVANCE_RETRY_BASE_MS);

    // Preflight failures leave the card Ready; sweeps within the backoff window skip it.
    const dispatchCalls = dispatch.mock.calls.length;
    await store.unblock(card.id);
    await store.update(card.id, { status: "ready" });
    dispatch.mockRejectedValueOnce(new Error("workspace unavailable"));
    await service.settle();
    status = await boardStatus(service, store);
    expect(status?.idleReason).toContain("workspace unavailable");
    const afterFailure = dispatch.mock.calls.length;
    expect(afterFailure).toBeGreaterThan(dispatchCalls);
    service.request({ trigger: "sweep" });
    await service.settle();
    service.request({ trigger: "change" });
    await service.settle();
    expect(dispatch.mock.calls.length).toBe(afterFailure);

    clock.now += WORKBOARD_AUTO_ADVANCE_RETRY_BASE_MS;
    run.mockResolvedValue({ runId: "run-ok" });
    service.request({ trigger: "sweep" });
    await service.settle();
    expect(dispatch.mock.calls.length).toBe(afterFailure + 1);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "running" });
  });

  it("does not run passes after stop until the next lifecycle sweep", async () => {
    const { store, service, run } = await createHarness();
    service.onGatewayStop();
    await enableBoard(store);
    await createReadyCard(store, { title: "Early" });
    service.request({ trigger: "manual" });
    await service.settle();
    expect(run).not.toHaveBeenCalled();

    service.onLifecycleSweep();
    await service.settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses host-authority dispatch for a card with unrecorded workspace authority", async () => {
    const { store, service, run } = await createHarness();
    await enableBoard(store);
    const card = await store.create({
      title: "Unrecorded host workspace",
      status: "ready",
      boardId: "ops",
      workspace: { kind: "dir", path: "/outside" },
    });

    await service.settle();

    expect(run).not.toHaveBeenCalled();
    const current = await store.get(card.id);
    expect(current).toMatchObject({ status: "ready" });
    expect(current?.metadata?.claim).toBeUndefined();
    const status = await boardStatus(service, store);
    expect(status?.lastFailure).toMatchObject({
      cardId: card.id,
      error: expect.stringContaining("workspace authority is unknown"),
    });
    expect(status?.idleReason).toContain("could not start");
    expect(status?.retryAt).toBeDefined();

    // Correcting the card's workspace authority clears the backoff immediately.
    await store.update(card.id, {
      workspace: { kind: "scratch" },
      workspaceAccess: { unrestricted: true },
    });
    await service.settle();

    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "running" });
  });
});

describe("describeWorkboardIdleReason", () => {
  const base = (overrides: Partial<WorkboardCard>): WorkboardCard => ({
    id: "card",
    title: "Card",
    status: "ready",
    priority: "normal",
    labels: [],
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });

  it("reports an empty queue, busy owners, and start failures", () => {
    expect(describeWorkboardIdleReason({ cards: [], failures: [], now: 10 })).toBe(
      "No Ready cards are waiting.",
    );
    const busy = base({ id: "busy", title: "Busy", status: "running", agentId: "main" });
    const waiting = base({ id: "wait", title: "Waiting", agentId: "main" });
    expect(describeWorkboardIdleReason({ cards: [busy, waiting], failures: [], now: 10 })).toBe(
      "Waiting waits for main to finish Busy (running).",
    );
    expect(
      describeWorkboardIdleReason({
        cards: [waiting],
        failures: [{ cardId: "wait", title: "Waiting", error: "no sandbox" }],
        now: 10,
      }),
    ).toBe("Waiting could not start: no sandbox");
  });
});
