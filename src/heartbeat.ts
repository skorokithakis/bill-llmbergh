import type { Context } from "@earendil-works/chord";
import { LiveDoc, type Conversation, type Harness } from "@earendil-works/pi-durable";

const TICK_MS = 60_000;

/**
 * Submit a `heartbeat` input once the root conversation has been idle for `intervalMs`, so the founder
 * keeps working on its own. The request id is the current UTC minute, so a restart inside the same
 * minute cannot deliver the same heartbeat twice.
 *
 * "Idle" is tracked from the conversation's own view: every committed change to it counts as activity,
 * and `pi.live.run` says whether a run is in progress right now. A busy conversation may go longer than
 * the tick without a commit (a slow model call), so the live document is checked separately.
 */
export async function startHeartbeat(
	harness: Harness,
	root: Conversation,
	intervalMs: number,
	context: Context,
): Promise<() => Promise<void>> {
	let lastActivityMs = Date.now();
	let inFlight: Promise<void> | undefined;

	const view = await root.viewState(context);
	const unsubscribe = view.subscribe(() => {
		lastActivityMs = Date.now();
	});

	const tick = async (): Promise<void> => {
		const live = await harness.snapshot(LiveDoc, root.id, context);
		if (live?.run !== undefined) {
			lastActivityMs = Date.now();
			return;
		}
		if (Date.now() - lastActivityMs < intervalMs) return;
		await root.submit(
			{ type: "input", content: "heartbeat", requestId: `heartbeat:${new Date().toISOString().slice(0, 16)}` },
			context,
		);
		lastActivityMs = Date.now();
	};

	const timer = setInterval(() => {
		inFlight = tick();
	}, TICK_MS);
	return async () => {
		clearInterval(timer);
		unsubscribe();
		view.dispose();
		// A tick that fired just before the stop could still be admitting a heartbeat; let it finish
		// before the harness closes so shutdown does not race it.
		await inFlight;
	};
}
