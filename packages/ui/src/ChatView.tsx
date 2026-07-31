import type { Message } from "@wenchat/protocol";
import { Box, Text } from "ink";

export type ChatViewProps = {
	messages: Message[];
	localId: string;
};

export function ChatView({ messages, localId }: ChatViewProps) {
	return (
		<Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
			{messages.map((message) => (
				<Text key={message.id}>{formatMessage(message, localId)}</Text>
			))}
		</Box>
	);
}

function formatMessage(message: Message, localId: string): string {
	// The CLI marks local-only system entries with `id: \`system-${randomUUID()}\``
	// (see apps/cli/src/App.tsx). Detect that prefix ahead of the local/peer
	// check so a system entry never accidentally collides with a peer's UUID
	// prefix.
	let prefix: "system" | "me" | "peer";
	if (message.id.startsWith("system-")) {
		prefix = "system";
	} else {
		prefix = message.id.startsWith(localId) ? "me" : "peer";
	}
	if (message.type === "text") {
		return `[${prefix}] ${message.payload.text}`;
	}
	if (message.type === "file-start") {
		return `[${prefix}] sending file: ${message.payload.fileName}`;
	}
	return `[${prefix}] ${message.type}`;
}
