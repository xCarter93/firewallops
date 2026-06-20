import { describe, it, expect, vi } from "vitest";
import { MatchRoom } from "../src/rooms/MatchRoom.js";

/**
 * Wave-0 graceful-drain test (review H2).
 *
 * A Railway deploy/restart must NOT silently kill a live match. `onBeforeShutdown`
 * is the Colyseus lifecycle hook invoked on shutdown; it must STOP new matchmaking
 * (`this.lock()`) and SIGNAL the drain (a draining broadcast + a `draining` flag)
 * so in-flight clients are notified — i.e. shutdown is observable, not a silent
 * no-op. Reconnection is Phase 5; this is the Phase-4 best-effort drain.
 *
 * Focused unit assertion on the hook's observable effects. The room's
 * server-bound methods (`lock`, `broadcast`) are stubbed because there is no live
 * Colyseus server in the headless harness — the test asserts the hook CALLS them.
 */
describe("shutdown: MatchRoom.onBeforeShutdown locks + drains (review H2)", () => {
  function makeRoom(): {
    room: MatchRoom;
    lock: ReturnType<typeof vi.fn>;
    broadcast: ReturnType<typeof vi.fn>;
  } {
    const room = new MatchRoom();
    const lock = vi.fn(() => Promise.resolve());
    const broadcast = vi.fn();
    // Stub the server-bound methods the hook drives.
    Object.assign(room, { lock, broadcast });
    return { room, lock, broadcast };
  }

  it("locks the room (stops new matchmaking)", async () => {
    const { room, lock } = makeRoom();
    await room.onBeforeShutdown();
    expect(lock).toHaveBeenCalled();
  });

  it("emits a draining signal (broadcast) so the shutdown is not silent", async () => {
    const { room, broadcast } = makeRoom();
    await room.onBeforeShutdown();
    expect(broadcast).toHaveBeenCalled();
    // The first broadcast arg is the draining event name.
    const eventName = broadcast.mock.calls[0]?.[0];
    expect(typeof eventName).toBe("string");
    expect(String(eventName).toLowerCase()).toContain("drain");
  });

  it("sets a draining flag on the room", async () => {
    const { room } = makeRoom();
    await room.onBeforeShutdown();
    expect((room as unknown as { draining: boolean }).draining).toBe(true);
  });
});
