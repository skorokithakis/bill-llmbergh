import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { acceptHostKey, RemoteExecutionEnv, scanHostKey, sshConnection, type Connection, type SshTarget } from "@earendil-works/pi-env";
import type { Config } from "./config.ts";

export type WorkVm = {
	/** A fresh environment per tool call; they share one connection, so equal ids see the same files. */
	environment(): RemoteExecutionEnv;
	warmUp(): Promise<void>;
	close(): Promise<void>;
};

export async function connectToWorkVm(config: Config, dataDir: string): Promise<WorkVm> {
	const identityFile = resolve(dataDir, "ssh/id_ed25519");
	const target: SshTarget = {
		host: config.vm.host,
		user: config.vm.user,
		identityFile,
		knownHostsFile: resolve(dataDir, "ssh/known_hosts"),
		hostKeyAlias: "pi-env-bill",
	};
	// pi-env reports a missing or unreadable key only as a bare spawn_error after the host key scan has
	// already succeeded, which sent the owner looking at the network. Check the one thing they place by
	// hand before touching SSH at all.
	if (!existsSync(identityFile)) {
		throw new Error(`SSH private key ${identityFile} is missing; copy the work VM key there (mode 600)`);
	}
	// The owner copies the key by hand, so the first run has no known key. Trust it once, print the
	// fingerprint so the owner can check it against the VM, and keep it in the data directory after.
	if (!isTrusted(target)) {
		const { lines, fingerprints } = await scanHostKey(target);
		console.log("work VM host key fingerprints:", fingerprints.join(", "));
		await acceptHostKey(target, lines);
	}
	const { connection } = sshConnection(target);
	const environment = () => new RemoteExecutionEnv({ connection, id: "pi-env:bill", cwd: "/root" });
	return {
		environment,
		async warmUp(): Promise<void> {
			// The first remote operation pays for platform detection and the daemon upload (SHA-256
			// verified) over SSH. Pay it at startup so the founder's first tool call is not delayed.
			let output = "";
			const result = await environment().exec("echo warm; uname -sm", { onOutput: (text) => { output += text; } }, BACKGROUND_CONTEXT);
			if (!result.ok) throw new Error(`work VM warm-up failed: ${JSON.stringify(result.error)}`);
			console.log("work VM ready:", output.trim());
		},
		async close(): Promise<void> {
			await connection.close();
		},
	};
}

function isTrusted(target: SshTarget): boolean {
	const known = existsSync(target.knownHostsFile) ? readFileSync(target.knownHostsFile, "utf8") : "";
	return known.split("\n").some((line) => line.startsWith(`${target.hostKeyAlias} `));
}
