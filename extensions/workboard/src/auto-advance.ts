// Workboard plugin module advances opted-in boards without model or operator polling.
import type {
  WorkboardAutoAdvanceStatus,
  WorkboardAutoAdvanceTrigger,
  WorkboardBoardMetadata,
  WorkboardBoardSummary,
  WorkboardCard,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type { OpenClawPluginService } from "../api.js";
import type { WorkboardDispatchAndStartResult, WorkboardStartFailure } from "./dispatcher.js";
import { cardBoardId, cardParentIds } from "./store-card-helpers.js";
import { workboardCardConsumesOwnerSlot, workboardCardSlotOwner } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

// Bursts of lifecycle and change events collapse into one pass; the pass itself
// serializes behind the per-store queue inside dispatchAndStartWorkboardCards.
export const WORKBOARD_AUTO_ADVANCE_COALESCE_MS = 250;
// Preflight start failures leave a card Ready (nothing was claimed to block), so
// an unchanged board backs off instead of re-failing on every 60s sweep.
export const WORKBOARD_AUTO_ADVANCE_RETRY_BASE_MS = 60_000;
export const WORKBOARD_AUTO_ADVANCE_RETRY_MAX_MS = 15 * 60_000;
const MAX_IDLE_REASON_ENTRIES = 3;
const MAX_TITLE_CHARS = 60;

// Higher entries win when a coalesced batch mixes triggers; only "change" is
// fingerprint-gated, every other trigger forces a real pass.
const TRIGGER_PRECEDENCE: readonly WorkboardAutoAdvanceTrigger[] = [
  "change",
  "sweep",
  "gateway-start",
  "lifecycle",
  "manual",
];

export type WorkboardAutoAdvanceRequest = {
  trigger: WorkboardAutoAdvanceTrigger;
  boardIds?: readonly string[];
};

export type WorkboardAutoAdvanceDispatch = (input: {
  boardId: string;
  now: number;
  /** Evaluated inside each claim so a mid-pass disable, archive, or Gateway stop wins. */
  startGate: (board: WorkboardBoardMetadata | undefined) => boolean;
}) => Promise<WorkboardDispatchAndStartResult>;

export type WorkboardAutoAdvanceService = OpenClawPluginService & {
  request: (input: WorkboardAutoAdvanceRequest) => void;
  onLifecycleMatched: (input: { cards: readonly WorkboardCard[] }) => void;
  onLifecycleSweep: () => void;
  onGatewayStop: () => void;
  describeBoards: (boards: readonly WorkboardBoardSummary[]) => WorkboardBoardSummary[];
  /** Runs any pending pass immediately and resolves once no pass is in flight. */
  settle: () => Promise<void>;
};

type PendingBatch = {
  trigger: WorkboardAutoAdvanceTrigger;
  boardIds: Set<string> | null;
};

type BoardRuntimeState = Omit<WorkboardAutoAdvanceStatus, "enabled"> & {
  fingerprint?: string;
  consecutiveFailures: number;
  /** Last no-start reason written to the log; productive passes do not count. */
  loggedIdleReason?: string;
};

type AutoAdvanceLogger = Pick<
  Parameters<OpenClawPluginService["start"]>[0]["logger"],
  "info" | "warn"
>;

export function workboardBoardAutoAdvanceEnabled(
  board: Pick<WorkboardBoardSummary, "orchestration" | "archivedAt">,
): boolean {
  return board.orchestration?.autoAdvance === true && !board.archivedAt;
}

function shortTitle(card: Pick<WorkboardCard, "title">): string {
  const title = card.title.trim();
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

function cardHasActiveClaim(card: WorkboardCard, now: number): boolean {
  const claim = card.metadata?.claim;
  return Boolean(claim && isFutureDateTimestampMs(claim.expiresAt, { nowMs: now }));
}

// Only fields that change start eligibility or launch preflight. Heartbeats,
// dispatch counters, logs, and comments are excluded so a pass's own
// bookkeeping cannot re-trigger it; workspace inputs are included so fixing a
// card after an authority failure clears its backoff immediately.
export function workboardBoardFingerprint(
  cards: readonly WorkboardCard[],
  board?: Pick<WorkboardBoardSummary, "defaultWorkspace" | "orchestration" | "archivedAt">,
): string {
  const boardPart = board
    ? `board|${JSON.stringify(board.defaultWorkspace ?? null)}|${JSON.stringify(board.orchestration ?? null)}|${board.archivedAt ?? ""}`
    : "";
  const cardPart = cards
    .map((card) =>
      [
        card.id,
        card.status,
        card.priority,
        card.position,
        card.agentId ?? "",
        card.metadata?.claim?.ownerId ?? "",
        card.execution?.status ?? "",
        card.metadata?.archivedAt ?? "",
        cardParentIds(card).join(","),
        JSON.stringify(card.metadata?.automation?.workspace ?? null),
        JSON.stringify(card.metadata?.automation?.workspaceAccess ?? null),
      ].join("|"),
    )
    .toSorted()
    .join("\n");
  return boardPart ? `${boardPart}\n${cardPart}` : cardPart;
}

export function describeWorkboardIdleReason(params: {
  cards: readonly WorkboardCard[];
  failures: readonly WorkboardStartFailure[];
  now: number;
}): string | undefined {
  const { cards, now } = params;
  const failureByCard = new Map(params.failures.map((failure) => [failure.cardId, failure]));
  const ready = cards.filter(
    (card) =>
      card.status === "ready" && !card.metadata?.archivedAt && !cardHasActiveClaim(card, now),
  );
  if (ready.length === 0) {
    return "No Ready cards are waiting.";
  }
  const busyByOwner = new Map<string, WorkboardCard[]>();
  for (const card of cards) {
    if (!workboardCardConsumesOwnerSlot(card, now)) {
      continue;
    }
    const owner = workboardCardSlotOwner(card);
    busyByOwner.set(owner, [...(busyByOwner.get(owner) ?? []), card]);
  }
  const entries = ready.slice(0, MAX_IDLE_REASON_ENTRIES).map((card) => {
    const owner = workboardCardSlotOwner(card, now);
    const busy = busyByOwner.get(owner);
    if (busy && busy.length > 0) {
      const holders = busy.map((holder) => `${shortTitle(holder)} (${holder.status})`).join(", ");
      return `${shortTitle(card)} waits for ${owner} to finish ${holders}.`;
    }
    const failure = failureByCard.get(card.id);
    if (failure) {
      return `${shortTitle(card)} could not start: ${failure.error}`;
    }
    return `${shortTitle(card)} is eligible and will start on the next pass.`;
  });
  const remainder = ready.length - entries.length;
  return remainder > 0 ? `${entries.join(" ")} ${remainder} more Ready.` : entries.join(" ");
}

function boardStatus(
  state: BoardRuntimeState | undefined,
  ready: boolean,
): WorkboardAutoAdvanceStatus {
  if (!state) {
    return {
      enabled: true,
      idleReason: ready ? "Waiting for the first dispatch pass." : "Waiting for Gateway start.",
    };
  }
  const {
    fingerprint: _fingerprint,
    consecutiveFailures: _failures,
    loggedIdleReason: _logged,
    ...status
  } = state;
  return { enabled: true, ...status };
}

export function createWorkboardAutoAdvanceService(params: {
  store: WorkboardStore;
  dispatch: WorkboardAutoAdvanceDispatch;
  now?: () => number;
}): WorkboardAutoAdvanceService {
  const states = new Map<string, BoardRuntimeState>();
  let generation = 0;
  let ready = false;
  let started = false;
  let logger: AutoAdvanceLogger | undefined;
  let unsubscribe: (() => void) | undefined;
  let pending: PendingBatch | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let hasSwept = false;
  const now = () => params.now?.() ?? Date.now();

  const mergePending = (input: WorkboardAutoAdvanceRequest): void => {
    const boardIds = input.boardIds ? new Set(input.boardIds) : null;
    if (!pending) {
      pending = { trigger: input.trigger, boardIds };
      return;
    }
    if (TRIGGER_PRECEDENCE.indexOf(input.trigger) > TRIGGER_PRECEDENCE.indexOf(pending.trigger)) {
      pending.trigger = input.trigger;
    }
    if (pending.boardIds && boardIds) {
      for (const boardId of boardIds) {
        pending.boardIds.add(boardId);
      }
    } else {
      pending.boardIds = null;
    }
  };

  const readBoard = async (boardId: string) =>
    (await params.store.listBoards()).boards.find((entry) => entry.id === boardId);

  const advanceBoard = async (
    board: WorkboardBoardSummary,
    trigger: WorkboardAutoAdvanceTrigger,
    owner: number,
  ): Promise<void> => {
    const boardId = board.id;
    const passAt = now();
    const before = await params.store.list({ boardId });
    const fingerprint = workboardBoardFingerprint(before, board);
    const state = states.get(boardId) ?? { consecutiveFailures: 0 };
    states.set(boardId, state);
    if (state.fingerprint !== fingerprint) {
      state.consecutiveFailures = 0;
      state.retryAt = undefined;
    } else if (trigger === "change") {
      // Same eligibility state as after our last pass: this change was our own
      // bookkeeping or an irrelevant field, so a new pass could only repeat itself.
      return;
    }
    const backingOff = state.retryAt !== undefined && passAt < state.retryAt;
    if (backingOff && trigger !== "manual" && trigger !== "gateway-start") {
      return;
    }
    const startGate = (board: WorkboardBoardMetadata | undefined) =>
      generation === owner &&
      ready &&
      board !== undefined &&
      workboardBoardAutoAdvanceEnabled(board);
    let result: WorkboardDispatchAndStartResult;
    state.passStartedAt = passAt;
    try {
      result = await params.dispatch({ boardId, now: passAt, startGate });
    } catch (error) {
      // Only the pass that set the marker may clear it; a newer pass may own it now.
      if (state.passStartedAt === passAt) {
        state.passStartedAt = undefined;
      }
      const message = formatErrorMessage(error);
      // Keep the pre-pass fingerprint so an unchanged board stays in backoff.
      state.fingerprint = fingerprint;
      state.lastPassAt = passAt;
      state.lastTrigger = trigger;
      state.lastFailure = { error: message, at: passAt };
      state.idleReason = `Dispatch pass failed: ${message}`;
      state.consecutiveFailures += 1;
      state.retryAt = passAt + retryDelay(state.consecutiveFailures);
      logger?.warn(`workboard auto-advance pass failed for board ${boardId}: ${message}`);
      return;
    }
    if (state.passStartedAt === passAt) {
      state.passStartedAt = undefined;
    }
    if (generation !== owner) {
      return;
    }
    const after = await params.store.list({ boardId });
    const afterBoard = await readBoard(boardId);
    const afterFingerprint = workboardBoardFingerprint(after, afterBoard);
    if (afterFingerprint === expectedFingerprintAfterPass(before, board, result)) {
      state.fingerprint = afterFingerprint;
    } else {
      // Something outside this pass changed eligibility while it ran; the
      // coalesced change event for it must not be fingerprint-skipped.
      state.fingerprint = undefined;
      request({ trigger: "change", boardIds: [boardId] });
    }
    state.lastPassAt = passAt;
    state.lastTrigger = trigger;
    const idleReason = describeWorkboardIdleReason({
      cards: after,
      failures: result.startFailures,
      now: passAt,
    });
    if (result.started.length === 0 && idleReason !== state.loggedIdleReason) {
      // Operators read the Gateway log when the board looks stuck; record each
      // new no-start reason once rather than on every 60s sweep.
      logger?.info(`workboard auto-advance idle (${trigger}) on board ${boardId}: ${idleReason}`);
      state.loggedIdleReason = idleReason;
    }
    state.idleReason = idleReason;
    const firstStart = result.started[0];
    const firstFailure = result.startFailures[0];
    if (firstFailure) {
      state.lastFailure = { ...firstFailure, at: passAt };
      logger?.warn(
        `workboard auto-advance could not start card ${firstFailure.cardId} on board ${boardId}: ${firstFailure.error}`,
      );
    }
    if (firstStart) {
      state.lastStart = {
        cardId: firstStart.cardId,
        title: firstStart.title,
        runId: firstStart.runId,
        at: passAt,
      };
      state.consecutiveFailures = 0;
      state.retryAt = undefined;
      for (const run of result.started) {
        logger?.info(
          `workboard auto-advance started card ${run.cardId} run ${run.runId} on board ${boardId}`,
        );
      }
      return;
    }
    if (firstFailure) {
      state.consecutiveFailures += 1;
      state.retryAt = passAt + retryDelay(state.consecutiveFailures);
    }
  };

  const runPass = async (owner: number): Promise<void> => {
    while (pending && generation === owner) {
      const batch = pending;
      pending = undefined;
      let boards: WorkboardBoardSummary[];
      try {
        boards = (await params.store.listBoards()).boards;
      } catch (error) {
        logger?.warn(`workboard auto-advance could not list boards: ${String(error)}`);
        return;
      }
      for (const board of boards) {
        if (generation !== owner) {
          return;
        }
        if (!workboardBoardAutoAdvanceEnabled(board)) {
          // Disabling or archiving stops new starts only; live workers keep running.
          states.delete(board.id);
          continue;
        }
        if (batch.boardIds && !batch.boardIds.has(board.id)) {
          continue;
        }
        try {
          await advanceBoard(board, batch.trigger, owner);
        } catch (error) {
          logger?.warn(`workboard auto-advance failed for board ${board.id}: ${String(error)}`);
        }
      }
    }
  };

  const startPass = (): void => {
    timer = undefined;
    if (!ready || inFlight || !pending) {
      return;
    }
    const owner = generation;
    inFlight = runPass(owner).finally(() => {
      inFlight = undefined;
      // Events that arrived mid-pass re-evaluate immediately instead of waiting
      // for the next sweep, so completion during a pass cannot strand the queue.
      // A restart that re-armed readiness while this pass drained also gets
      // its queued gateway-start batch scheduled here.
      if (pending) {
        schedule();
      }
    });
  };

  const schedule = (): void => {
    if (!ready || timer || inFlight) {
      return;
    }
    timer = setTimeout(startPass, WORKBOARD_AUTO_ADVANCE_COALESCE_MS);
    timer.unref?.();
  };

  const request = (input: WorkboardAutoAdvanceRequest): void => {
    if (!started) {
      return;
    }
    mergePending(input);
    schedule();
  };

  const halt = (): void => {
    generation += 1;
    ready = false;
    hasSwept = false;
    pending = undefined;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    id: "workboard-auto-advance",
    start(ctx) {
      logger = ctx.logger;
      started = true;
      logger.info("workboard auto-advance service started; passes begin after the lifecycle sweep");
      unsubscribe?.();
      unsubscribe = params.store.subscribeChanges(() => request({ trigger: "change" }));
    },
    stop() {
      halt();
      started = false;
      unsubscribe?.();
      unsubscribe = undefined;
      logger = undefined;
    },
    request,
    onLifecycleMatched({ cards }) {
      if (cards.length === 0) {
        return;
      }
      request({ trigger: "lifecycle", boardIds: cards.map((card) => cardBoardId(card)) });
    },
    onLifecycleSweep() {
      // Automatic passes stay gated until the first lifecycle sweep has
      // reconciled prepared launches and live sessions after (re)start, so a
      // change event during startup cannot dispatch against stale worker state.
      const trigger = hasSwept ? "sweep" : "gateway-start";
      if (!hasSwept) {
        logger?.info("workboard auto-advance ready: first lifecycle sweep reconciled");
      }
      hasSwept = true;
      ready = true;
      request({ trigger });
    },
    onGatewayStop() {
      halt();
    },
    describeBoards(boards) {
      return boards.map((board) => {
        if (board.orchestration?.autoAdvance !== true) {
          return board;
        }
        if (board.archivedAt) {
          return { ...board, autoAdvance: { enabled: false, idleReason: "Board is archived." } };
        }
        return { ...board, autoAdvance: boardStatus(states.get(board.id), ready) };
      });
    },
    async settle() {
      while (timer || inFlight || (pending && ready)) {
        if (timer) {
          clearTimeout(timer);
          startPass();
        } else if (pending && !inFlight) {
          startPass();
        }
        await inFlight;
      }
    },
  };
}

// The pass's own writes are exactly the card versions the dispatcher reports;
// any other eligibility change (edits to touched cards included) came from
// elsewhere during the pass and needs a re-run.
function expectedFingerprintAfterPass(
  before: readonly WorkboardCard[],
  board: WorkboardBoardSummary,
  result: WorkboardDispatchAndStartResult,
): string {
  const written = new Map<string, WorkboardCard>();
  for (const card of [
    ...result.promoted,
    ...result.reclaimed,
    ...result.blocked,
    ...result.orchestrated,
  ]) {
    written.set(card.id, card);
  }
  // Start-phase writes supersede data-pass writes to the same card.
  for (const entry of [...result.startFailures, ...result.started]) {
    if (entry.card) {
      written.set(entry.cardId, entry.card);
    }
  }
  return workboardBoardFingerprint(
    before.map((card) => written.get(card.id) ?? card),
    board,
  );
}

function retryDelay(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(
    WORKBOARD_AUTO_ADVANCE_RETRY_MAX_MS,
    WORKBOARD_AUTO_ADVANCE_RETRY_BASE_MS * 2 ** exponent,
  );
}
