import { describe, expect, it, vi } from "vitest";
import { readWorkboardLifecycleSessions } from "./lifecycle-sync.js";

describe("Workboard lifecycle session discovery", () => {
  it("federates configured agents without ownerless sentinels", async () => {
    const request = vi
      .fn()
      .mockImplementation(
        async (_method: string, options: { includeGlobal?: boolean; includeUnknown?: boolean }) => {
          if (options.includeGlobal || options.includeUnknown) {
            throw new Error(
              'Multiple agents are configured, but session key "global" has no explicit owner.',
            );
          }
          return {
            sessions: [
              {
                key: "agent:alpha:dashboard:live",
                status: "running",
                hasActiveRun: false,
                updatedAt: 1234,
              },
            ],
          };
        },
      );

    await expect(
      readWorkboardLifecycleSessions({ isAvailable: async () => true, request }),
    ).resolves.toEqual({
      sessions: [
        {
          key: "agent:alpha:dashboard:live",
          status: "running",
          hasActiveRun: false,
          updatedAt: 1234,
        },
      ],
      complete: true,
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      {
        limit: 10_000,
        configuredAgentsOnly: true,
        includeGlobal: false,
        includeUnknown: false,
      },
      { scopes: ["operator.read"] },
    );
  });

  it("keeps unknown excluded when explicit ownership requires agent selection", async () => {
    const request = vi.fn().mockImplementation(async (method: string, options: object) => {
      if (method === "agents.list") {
        return { selectionRequired: true };
      }
      expect(method).toBe("sessions.list");
      expect(options).toMatchObject({ includeGlobal: false, includeUnknown: false });
      return { sessions: [] };
    });

    await expect(
      readWorkboardLifecycleSessions(
        { isAvailable: async () => true, request },
        { includeUnknown: true },
      ),
    ).resolves.toEqual({ sessions: [], complete: true });
  });

  it("returns an incomplete empty snapshot without requesting while Gateway is unavailable", async () => {
    const request = vi.fn();

    await expect(
      readWorkboardLifecycleSessions({ isAvailable: async () => false, request }),
    ).resolves.toEqual({ sessions: [], complete: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("treats a full sessions.list page as possibly truncated", async () => {
    // Keep a full page conservative even when a mock or older peer omits pagination
    // metadata, or absent sessions could be marked missing.
    const request = vi.fn().mockResolvedValue({
      sessions: Array.from({ length: 10_000 }, (_, index) => ({
        key: `agent:main:dashboard:${index}`,
        status: "done",
      })),
    });

    const snapshot = await readWorkboardLifecycleSessions({
      isAvailable: async () => true,
      request,
    });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.sessions).toHaveLength(10_000);
  });
});
