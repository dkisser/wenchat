import { randomUUID } from "node:crypto";
import type { FileReceiver, PeerConnection } from "@wenchat/core";
import type { Message, PeerInfo, TextMessage } from "@wenchat/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type ConnectionPhase,
	type Effect,
	IDLE_PHASE,
	type MachineEvent,
	reduce,
} from "./connectionMachine";

/** Cap-then-append, mirroring the local helper in App.tsx (extracted to keep
 *  the hook dependency-free). */
function appendCapped(previous: Message[], message: TextMessage): Message[] {
	const MAX_MESSAGES = 2000;
	if (previous.length >= MAX_MESSAGES) {
		return [...previous.slice(previous.length - MAX_MESSAGES + 1), message];
	}
	return [...previous, message];
}

/**
 * Hook that turns the pure state machine into the React-shaped interface
 * `App.tsx` actually needs:
 *
 *   - a `phase` value to render from,
 *   - a `dispatch(event)` for every handler to call,
 *   - an `appendSystemMessage(text)` for ad-hoc chat-log notices,
 *   - the bookkeeping (`lastPeer`, `connectionGeneration`, the timer handle)
 *     that is too imperative to live inside the reducer.
 *
 * The machine owns `phase` and the WHAT/WHEN of each side effect; this
 * module owns HOW effects reach `PeerConnection` / `FileReceiver` /
 * React state, and the async gaps between them.
 */
export type ConnectionMachineBindings = {
	readonly phase: ConnectionPhase;
	readonly phaseRef: React.MutableRefObject<ConnectionPhase>;
	readonly dispatch: (event: MachineEvent) => void;
	readonly appendSystemMessage: (text: string) => void;
	/** Populated when the user has dialed anyone — survives every phase. */
	readonly lastPeerRef: React.MutableRefObject<PeerInfo | null>;
};

export function useConnectionMachine(
	peerConnection: PeerConnection,
	fileReceiver: FileReceiver,
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): ConnectionMachineBindings {
	// The generation token is orthogonal to the phase: it guards the async
	// `connect()` gap, which the pure reducer cannot model. Bumped by the
	// `invalidate-dials` effect from inside the machine, read by `runDial`
	// and `runEffect` after every await.
	const connectionGenerationRef = useRef(0);

	// Survives every phase, including the idle gap after a peer left — so
	// `/reconnect` can redial without the user remembering host:port.
	const lastPeerRef = useRef<PeerInfo | null>(null);

	// `setTimeout` handle for the pending reconnect. Written only by the
	// effect executor (`schedule-retry` / `cancel-retry`) and by the
	// cleanup effect below — never by a command handler.
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const [phase, setPhase] = useState<ConnectionPhase>(IDLE_PHASE);
	const phaseRef = useRef<ConnectionPhase>(phase);
	phaseRef.current = phase;

	const appendSystemMessage = useCallback(
		(text: string) => {
			const message: TextMessage = {
				type: "text",
				id: `system-${randomUUID()}`,
				timestamp: Date.now(),
				payload: { text },
			};
			setMessages((prev) => appendCapped(prev, message));
		},
		[setMessages],
	);

	const cancelReconnectTimer = useCallback(() => {
		if (reconnectTimerRef.current !== null) {
			clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = null;
		}
	}, []);

	// `runDial` and the retry timer need to dispatch, but they are defined
	// below `dispatch`. Route them through a ref so there is no circular
	// `useCallback` dependency (and no stale closure either — every
	// dependency is itself stable).
	const dispatchRef = useRef<(event: MachineEvent) => void>(() => {});

	const runDial = useCallback(
		async (peer: PeerInfo) => {
			const myGeneration = connectionGenerationRef.current;
			try {
				await peerConnection.connect(peer.signalingHost, peer.signalingPort);
				if (connectionGenerationRef.current !== myGeneration) {
					// A user action landed during the handshake — take the late
					// session straight back down without emitting a connected
					// event the user did not ask for.
					peerConnection.closeActiveSession();
				}
			} catch {
				if (connectionGenerationRef.current !== myGeneration) return;
				dispatchRef.current({ kind: "dial-failed" });
			}
		},
		[peerConnection],
	);

	const runEffect = useCallback(
		(effect: Effect) => {
			switch (effect.kind) {
				case "cancel-retry":
					cancelReconnectTimer();
					return;
				case "schedule-retry":
					cancelReconnectTimer();
					reconnectTimerRef.current = setTimeout(() => {
						reconnectTimerRef.current = null;
						dispatchRef.current({ kind: "retry-fired" });
					}, effect.delayMs);
					return;
				case "dial":
					void runDial(effect.peer);
					return;
				case "close-active-session":
					// Release the dead session's UDP/STUN resources so the new
					// pc's ICE gather doesn't stall against the closed pc's
					// leftovers. Safe when no session is active.
					peerConnection.closeActiveSession();
					return;
				case "close-graceful":
					void peerConnection.closeGracefully(effect.reason);
					return;
				case "invalidate-dials":
					connectionGenerationRef.current++;
					return;
				case "dispose-transfers":
					// Any in-flight incoming transfer is now hopeless — clean up
					// its temp file and emit a "failed" system entry per transfer.
					void fileReceiver.dispose();
					return;
				case "system-message":
					appendSystemMessage(effect.text);
					return;
			}
		},
		[appendSystemMessage, cancelReconnectTimer, fileReceiver, peerConnection, runDial],
	);

	const dispatch = useCallback(
		(event: MachineEvent) => {
			// Reduce against the ref, not the rendered `phase`: several events
			// can land inside one tick (a terminal event immediately followed by
			// its retry), and the rendered value would still be the pre-tick one.
			const { phase: next, effects } = reduce(phaseRef.current, event);
			phaseRef.current = next;
			setPhase(next);
			for (const effect of effects) {
				runEffect(effect);
			}
		},
		[runEffect],
	);
	dispatchRef.current = dispatch;

	// Free any pending reconnect on unmount — otherwise the timer fires into
	// a torn-down PeerConnection.
	useEffect(() => () => cancelReconnectTimer(), [cancelReconnectTimer]);

	return { phase, phaseRef, dispatch, appendSystemMessage, lastPeerRef };
}
