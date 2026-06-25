import { describe, it, expect } from "vitest";
import {
  buildMatchStartPlayers,
  type PersistableMobile,
} from "../src/match/matchPersistence.js";

describe("buildMatchStartPlayers", () => {
  const mobiles: PersistableMobile[] = [
    { sessionId: "s1", team: 0, displayName: "ALPHA" },
    { sessionId: "s2", team: 1, displayName: "BRAVO" },
  ];

  it("attaches each mobile's bound accountId, team, and displayName", () => {
    const accounts = new Map([
      ["s1", "acc_1"],
      ["s2", "acc_2"],
    ]);
    expect(buildMatchStartPlayers(mobiles, accounts)).toEqual([
      { accountId: "acc_1", team: 0, displayName: "ALPHA" },
      { accountId: "acc_2", team: 1, displayName: "BRAVO" },
    ]);
  });

  it("skips a mobile with no bound account (the training dummy / unauthed seat)", () => {
    const accounts = new Map([["s1", "acc_1"]]); // s2 (and any dummy) has none.
    const withDummy: PersistableMobile[] = [
      ...mobiles,
      { sessionId: "dummy", team: 1, displayName: "RANGE DUMMY" },
    ];
    expect(buildMatchStartPlayers(withDummy, accounts)).toEqual([
      { accountId: "acc_1", team: 0, displayName: "ALPHA" },
    ]);
  });

  it("returns an empty roster when nothing is attributable", () => {
    expect(buildMatchStartPlayers(mobiles, new Map())).toEqual([]);
    expect(buildMatchStartPlayers([], new Map([["s1", "acc_1"]]))).toEqual([]);
  });
});
