// @vitest-environment jsdom
//
// Regression suite for the Colyseus listener-disposer (the leak fix). The
// `@colyseus/sdk` APPENDS listeners and the MatchRoom OUTLIVES the Phaser scene
// (Blocker 3), so a scene mount / reconnect-remount / idempotent-rejoin that
// re-registers WITHOUT removing the prior set used to STACK duplicate handlers
// that fired into the destroyed prior scene. These tests prove attachToMatch
// dedupes on re-attach and disposeMatchHandlers removes a registration cleanly.
import { describe, it, expect, vi } from "vitest";
import {
  attachToMatch,
  disposeMatchHandlers,
  type NetHandlers,
} from "./room.js";
import type { Room } from "@colyseus/sdk";

/**
 * A fake Room that mimics the two SDK listener shapes we depend on: `onMessage`
 * (nanoevents — APPENDS, returns an unbind fn) and `onStateChange`/`onLeave`
 * (createSignal — APPENDS, removed via `.remove(cb)`). `_emit*` fan a value out
 * to every currently-registered handler, exactly like the SDK's emit/invoke.
 */
function makeFakeRoom() {
  const msg: Record<string, Array<(p: unknown) => void>> = {};
  const state: Array<(s: unknown) => void> = [];
  const leave: Array<(c: number) => void> = [];

  const onStateChange = (cb: (s: unknown) => void): void => {
    state.push(cb);
  };
  onStateChange.remove = (cb: (s: unknown) => void): void => {
    const i = state.indexOf(cb);
    if (i >= 0) state.splice(i, 1);
  };

  const onLeave = (cb: (c: number) => void): void => {
    leave.push(cb);
  };
  onLeave.remove = (cb: (c: number) => void): void => {
    const i = leave.indexOf(cb);
    if (i >= 0) leave.splice(i, 1);
  };

  const room = {
    roomId: "R1",
    reconnectionToken: "tok",
    onMessage: (type: string, cb: (p: unknown) => void): (() => void) => {
      (msg[type] ??= []).push(cb);
      return () => {
        const arr = msg[type];
        const i = arr.indexOf(cb);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    onStateChange,
    onLeave,
    _emitState: (s: unknown): void => state.slice().forEach((h) => h(s)),
    _emitMsg: (type: string, p: unknown): void =>
      (msg[type] ?? []).slice().forEach((h) => h(p)),
    _counts: (): { state: number; leave: number } => ({
      state: state.length,
      leave: leave.length,
    }),
  };
  return room;
}

function makeHandlers(): NetHandlers & { [k: string]: ReturnType<typeof vi.fn> } {
  return {
    onShotResult: vi.fn(),
    onTerrainSnapshot: vi.fn(),
    onMatchEnded: vi.fn(),
    onStateChange: vi.fn(),
  } as unknown as NetHandlers & { [k: string]: ReturnType<typeof vi.fn> };
}

describe("listener disposer (leak fix)", () => {
  it("re-attaching the SAME room disposes the prior registration (no stacking)", () => {
    const room = makeFakeRoom();
    const a = makeHandlers();
    const b = makeHandlers();

    attachToMatch(room as unknown as Room, a);
    room._emitState({ tick: 1 });
    expect(a.onStateChange).toHaveBeenCalledTimes(1);

    // Re-attach (e.g. a scene remount on the surviving room) — the OLD handlers
    // must be removed, not stacked.
    attachToMatch(room as unknown as Room, b);
    room._emitState({ tick: 2 });
    expect(b.onStateChange).toHaveBeenCalledTimes(1);
    expect(a.onStateChange).toHaveBeenCalledTimes(1); // NOT called again — no stack.

    // Exactly one state listener + one onLeave (token-clear) remain registered.
    expect(room._counts()).toEqual({ state: 1, leave: 1 });
  });

  it("disposeMatchHandlers removes the registration — no late callbacks fire", () => {
    const room = makeFakeRoom();
    const h = makeHandlers();

    attachToMatch(room as unknown as Room, h);
    disposeMatchHandlers(room as unknown as Room);

    room._emitState({ tick: 1 });
    room._emitMsg("shotResult", { mechId: "x" });
    expect(h.onStateChange).not.toHaveBeenCalled();
    expect(h.onShotResult).not.toHaveBeenCalled();
    expect(room._counts()).toEqual({ state: 0, leave: 0 }); // fully unwound.
  });

  it("the live registration still receives messages (dedupe is targeted, not total)", () => {
    const room = makeFakeRoom();
    const h = makeHandlers();
    attachToMatch(room as unknown as Room, h);
    room._emitMsg("shotResult", { mechId: "x" });
    room._emitMsg("matchEnded", { winnerTeam: 0 });
    expect(h.onShotResult).toHaveBeenCalledTimes(1);
    expect(h.onMatchEnded).toHaveBeenCalledTimes(1);
  });
});
