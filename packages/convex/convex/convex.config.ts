/**
 * Convex app component registration (Phase 9, Plan 09).
 *
 * Registers the official `@convex-dev/presence` component (D-05) so we can drive
 * the disconnected-opponent cue from a real heartbeat/timeout signal instead of
 * the deleted Colyseus `onDrop`/`onReconnect` socket events. This is the FIRST
 * Convex component registered in the project — the file is pure boilerplate from
 * the component docs (https://www.convex.dev/components/presence).
 *
 * Presence is used STRICTLY for the disconnect cue (D-05). Live-aim is a separate
 * `matchAim` mechanism (plan 10); presence-for-aim was rejected in 09-RESEARCH
 * (D-01) — do NOT add aim to this component.
 */
import { defineApp } from "convex/server";
import presence from "@convex-dev/presence/convex.config";

const app = defineApp();
app.use(presence);

export default app;
