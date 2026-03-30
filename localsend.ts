import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup";

import {
	DEFAULT_MULTICAST_GROUP,
	DEFAULT_PORT,
	DeviceType,
	PROTOCOL_VERSION,
	ProtocolType,
	decodeJson,
	encodeJson,
	ensureAlias,
	ensureFingerprint,
	getDefaultDownloadFolder,
	sanitizeFileName,
	stringFromBytes,
	type DeviceInfo,
	type FileDto,
	type MulticastInfo,
	type PrepareUploadRequest,
	type PrepareUploadResponse,
	type RegisterInfo,
} from "./common.js";

export interface LocalSendPeer extends RegisterInfo {
	ip: string;
	lastSeenAt: number;
}

export interface OutgoingTransferItem {
	fileName: string;
	bytes: Uint8Array;
	mimeType: string;
	preview?: string | null;
}

export interface IncomingTransferRequest {
	sender: LocalSendPeer;
	files: FileDto[];
	totalBytes: number;
}

export interface LocalSendServiceCallbacks {
	onStateChanged(): void;
	onNotification(summary: string, body: string, actionUri?: string): void;
	onIncomingTransfer(request: IncomingTransferRequest): Promise<boolean>;
}

interface AcceptedIncomingFile {
	file: FileDto;
	token: string;
	path: string | null;
	received: boolean;
}

interface IncomingSession {
	sessionId: string;
	sender: LocalSendPeer;
	requestIp: string;
	destinationFolder: string;
	files: Map<string, AcceptedIncomingFile>;
}

function now(): number {
	return Date.now();
}

function toBytes(value: Uint8Array | string): Uint8Array {
	return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function textFromJsonBytes(bytes: Uint8Array | null | undefined): string {
	return stringFromBytes(bytes);
}

const SOCKET_LEVEL_SOL = 1;
const SOCKET_OPTION_REUSEADDR = 2;
const SOCKET_OPTION_REUSEPORT = 15;
const HTTP_STATUS_PHRASES: Record<number, string> = {
	200: "OK",
	204: "No Content",
	400: "Bad Request",
	403: "Forbidden",
	404: "Not Found",
	409: "Conflict",
	412: "Precondition Failed",
	500: "Internal Server Error",
};
const REJECT_MESSAGE = "The recipient has rejected the request.";

function parseRequestUrl(message: any): {
	path: string;
	query: Record<string, string>;
} {
	const uriString = message.get_uri().to_string();
	const schemeSeparator = uriString.indexOf("://");
	const pathStart =
		schemeSeparator >= 0
			? uriString.indexOf("/", schemeSeparator + 3)
			: uriString.indexOf("/");
	const rawPath = pathStart >= 0 ? uriString.slice(pathStart) : "/";
	const queryIndex = rawPath.indexOf("?");
	const path = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
	const queryString = queryIndex >= 0 ? rawPath.slice(queryIndex + 1) : "";
	const query: Record<string, string> = {};

	for (const pair of queryString.split("&")) {
		if (pair.trim().length === 0) continue;

		const [rawKey, rawValue = ""] = pair.split("=", 2);
		query[decodeURIComponent(rawKey)] = decodeURIComponent(
			rawValue.replace(/\+/g, " "),
		);
	}

	return { path, query };
}

export class LocalSendService {
	private readonly _settings: Gio.Settings;
	private readonly _callbacks: LocalSendServiceCallbacks;
	private readonly _session: any;
	private readonly _server: any;

	private _enabled = false;
	private _autoDisableSourceId: number | null = null;
	private _alias: string;
	private _fingerprint: string;
	private _port: number;
	private _httpPort: number;
	private _downloadFolder: string;

	private _peers = new Map<string, LocalSendPeer>();
	private _multicastSocket: Gio.Socket | null = null;
	private _multicastSourceId: number | null = null;
	private _announcementSourceId: number | null = null;
	private _peerCleanupSourceId: number | null = null;
	private _incomingSession: IncomingSession | null = null;

	constructor(settings: Gio.Settings, callbacks: LocalSendServiceCallbacks) {
		this._settings = settings;
		this._callbacks = callbacks;
		this._session = new Soup.Session();
		this._server = new Soup.Server();

		this._alias = ensureAlias(this._settings.get_string("alias"));
		this._fingerprint = ensureFingerprint(
			this._settings.get_string("fingerprint"),
		);
		this._port = this._settings.get_int("port") || DEFAULT_PORT;
		this._httpPort = this._port;
		this._downloadFolder = this._resolveDownloadFolder();

		this._settings.set_string("alias", this._alias);
		this._settings.set_string("fingerprint", this._fingerprint);
		this._settings.set_int("port", this._port);
		this._settings.set_string("download-folder", this._downloadFolder);

		this._installServerHandlers();
	}

	get enabled(): boolean {
		return this._enabled;
	}

	get peers(): LocalSendPeer[] {
		return [...this._peers.values()]
			.filter((peer) => now() - peer.lastSeenAt < 180_000)
			.sort((left, right) => left.alias.localeCompare(right.alias));
	}

	get alias(): string {
		return this._alias;
	}

	get fingerprint(): string {
		return this._fingerprint;
	}

	get port(): number {
		return this._httpPort;
	}

	toggleEnabled(): void {
		if (this._enabled) {
			this.stop();
			return;
		}

		if (this._portIsStillBound()) {
			throw new Error(
				"LocalSend cannot be re-enabled until port " +
					String(this._port) +
					" is free.",
			);
		}

		this.start();
	}

	private _scheduleAutoDisable(): void {
		if (this._autoDisableSourceId !== null) {
			GLib.source_remove(this._autoDisableSourceId);
			this._autoDisableSourceId = null;
		}

		this._autoDisableSourceId = GLib.timeout_add_seconds(
			GLib.PRIORITY_DEFAULT,
			600,
			() => {
				this._autoDisableSourceId = null;
				this.stop();
				return GLib.SOURCE_REMOVE;
			},
		);
	}

	private _cancelAutoDisable(): void {
		if (this._autoDisableSourceId === null) return;

		GLib.source_remove(this._autoDisableSourceId);
		this._autoDisableSourceId = null;
	}

	start(): void {
		if (this._enabled) return;

		this._cancelAutoDisable();

		this._port = this._settings.get_int("port") || DEFAULT_PORT;
		this._alias = ensureAlias(this._settings.get_string("alias"));
		this._fingerprint = ensureFingerprint(
			this._settings.get_string("fingerprint"),
		);
		this._downloadFolder = this._resolveDownloadFolder();

		this._settings.set_string("alias", this._alias);
		this._settings.set_string("fingerprint", this._fingerprint);
		this._settings.set_int("port", this._port);
		this._settings.set_string("download-folder", this._downloadFolder);

		this._httpPort = this._listenOnHttpPort(this._port);

		this._startDiscoverySocket();
		this._sendAnnouncement();

		this._announcementSourceId = GLib.timeout_add_seconds(
			GLib.PRIORITY_DEFAULT,
			60,
			() => {
				if (!this._enabled) return GLib.SOURCE_REMOVE;

				this._sendAnnouncement();
				return GLib.SOURCE_CONTINUE;
			},
		);

		this._peerCleanupSourceId = GLib.timeout_add_seconds(
			GLib.PRIORITY_DEFAULT,
			30,
			() => {
				if (!this._enabled) return GLib.SOURCE_REMOVE;

				this._prunePeers();
				return GLib.SOURCE_CONTINUE;
			},
		);

		this._enabled = true;
		this._callbacks.onStateChanged();
		this._scheduleAutoDisable();
	}

	stop(): void {
		this._cancelAutoDisable();

		if (!this._enabled) return;

		this._enabled = false;

		if (this._multicastSourceId !== null) {
			GLib.source_remove(this._multicastSourceId);
			this._multicastSourceId = null;
		}

		if (this._multicastSocket !== null) {
			this._multicastSocket.close();
			this._multicastSocket = null;
		}

		if (this._announcementSourceId !== null) {
			GLib.source_remove(this._announcementSourceId);
			this._announcementSourceId = null;
		}

		if (this._peerCleanupSourceId !== null) {
			GLib.source_remove(this._peerCleanupSourceId);
			this._peerCleanupSourceId = null;
		}

		if (this._server !== null) {
			this._server.disconnect();
		}

		this._incomingSession = null;
		this._callbacks.onStateChanged();
	}

	refreshPeers(): void {
		if (!this._enabled) return;

		this._sendAnnouncement();
	}

	async sendFilesToPeer(
		peer: LocalSendPeer,
		filePaths: string[],
	): Promise<void> {
		if (filePaths.length === 0)
			throw new Error("Choose at least one file to send.");

		const items = await Promise.all(
			filePaths.map(async (path) => {
				const file = Gio.File.new_for_path(path);
				const info = file.query_info(
					"standard::display-name,standard::content-type",
					Gio.FileQueryInfoFlags.NONE,
					null,
				);
				const [bytes] = await file.load_bytes_async(null);

				return {
					fileName: sanitizeFileName(info.get_display_name()),
					bytes: bytes.get_data() ?? new Uint8Array(),
					mimeType: info.get_content_type() ?? "application/octet-stream",
					preview: null,
				} satisfies OutgoingTransferItem;
			}),
		);

		await this._sendOutgoingItems(peer, items);
	}

	async sendClipboardTextToPeer(
		peer: LocalSendPeer,
		text: string,
	): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0)
			throw new Error("The clipboard does not contain any text.");

		await this._sendOutgoingItems(peer, [
			{
				fileName: "clipboard.txt",
				bytes: new TextEncoder().encode(trimmed),
				mimeType: "text/plain",
				preview: trimmed,
			},
		]);
	}

	async sendTypedTextToPeer(peer: LocalSendPeer, text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) throw new Error("Enter text before sending.");

		await this._sendOutgoingItems(peer, [
			{
				fileName: "message.txt",
				bytes: new TextEncoder().encode(trimmed),
				mimeType: "text/plain",
				preview: trimmed,
			},
		]);
	}

	private _resolveDownloadFolder(): string {
		const configured = this._settings.get_string("download-folder").trim();
		if (configured.length > 0) return configured;

		return getDefaultDownloadFolder();
	}

	isPortStillBound(): boolean {
		try {
			const socket = Gio.Socket.new(
				Gio.SocketFamily.IPV4,
				Gio.SocketType.STREAM,
				Gio.SocketProtocol.TCP,
			);
			socket.bind(
				new Gio.InetSocketAddress({
					address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
					port: this._port,
				}),
				true,
			);
			socket.close();
			return false;
		} catch {
			return true;
		}
	}

	private _portIsStillBound(): boolean {
		try {
			const socket = Gio.Socket.new(
				Gio.SocketFamily.IPV4,
				Gio.SocketType.STREAM,
				Gio.SocketProtocol.TCP,
			);
			socket.bind(
				new Gio.InetSocketAddress({
					address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
					port: this._port,
				}),
				true,
			);
			socket.close();
			return false;
		} catch {
			return true;
		}
	}

	private _installServerHandlers(): void {
		this._server.add_handler("/", (_server: unknown, message: any) => {
			const { path } = parseRequestUrl(message);
			const method = message.get_method();

			if (method === "GET" && path === "/api/localsend/v2/info") {
				this._respondJson(message, 200, this._buildInfoPayload());
				return;
			}

			if (method === "POST" && path === "/api/localsend/v2/register") {
				this._handleRegister(message);
				return;
			}

			if (method === "POST" && path === "/api/localsend/v2/prepare-upload") {
				message.pause();
				void this._handlePrepareUpload(message).catch((error) => {
					const messageText =
						error instanceof Error ? error.message : String(error);
					console.warn(`LocalSend prepare-upload failed: ${messageText}`);
				});
				return;
			}

			if (method === "POST" && path === "/api/localsend/v2/upload") {
				this._respondUpload(message);
				return;
			}

			if (method === "POST" && path === "/api/localsend/v2/cancel") {
				this._handleCancel(message);
				return;
			}

			this._respondJson(message, 404, { message: "Not found" });
		});
	}

	private _buildInfoPayload(): DeviceInfo {
		return {
			alias: this._alias,
			version: PROTOCOL_VERSION,
			deviceModel: null,
			deviceType: DeviceType.Desktop,
			fingerprint: this._fingerprint,
			download: false,
		};
	}

	private _buildRegisterPayload(): RegisterInfo {
		return {
			...this._buildInfoPayload(),
			port: this._httpPort,
			protocol: ProtocolType.Http,
		};
	}

	private _rememberPeer(peer: LocalSendPeer): void {
		this._peers.set(peer.fingerprint, peer);
		this._callbacks.onStateChanged();
	}

	private _prunePeers(): void {
		let changed = false;

		for (const [fingerprint, peer] of this._peers.entries()) {
			if (now() - peer.lastSeenAt < 180_000) continue;

			this._peers.delete(fingerprint);
			changed = true;
		}

		if (changed) this._callbacks.onStateChanged();
	}

	private _startDiscoverySocket(): void {
		if (this._multicastSocket !== null) return;

		const socket = Gio.Socket.new(
			Gio.SocketFamily.IPV4,
			Gio.SocketType.DATAGRAM,
			Gio.SocketProtocol.UDP,
		);
		socket.set_blocking(false);
		socket.set_option(SOCKET_LEVEL_SOL, SOCKET_OPTION_REUSEADDR, 1);
		try {
			socket.set_option(SOCKET_LEVEL_SOL, SOCKET_OPTION_REUSEPORT, 1);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`LocalSend could not enable UDP port sharing: ${message}`);
		}

		const address = Gio.InetSocketAddress.new(
			Gio.InetAddress.new_from_string("0.0.0.0"),
			DEFAULT_PORT,
		);
		if (!socket.bind(address, true))
			throw new Error(
				`Could not bind multicast socket on port ${DEFAULT_PORT}.`,
			);

		const multicastGroup = Gio.InetAddress.new_from_string(
			DEFAULT_MULTICAST_GROUP,
		);
		if (!socket.join_multicast_group(multicastGroup, false, null))
			throw new Error(
				`Could not join multicast group ${DEFAULT_MULTICAST_GROUP}.`,
			);

		const source = socket.create_source(GLib.IOCondition.IN, null);
		source.set_callback(() => {
			this._readDiscoveryPackets();
			return GLib.SOURCE_CONTINUE;
		});
		this._multicastSourceId = source.attach(null);
		this._multicastSocket = socket;
	}

	private _sendAnnouncement(): void {
		this._sendMulticastPacket({
			...this._buildRegisterPayload(),
			announce: true,
			announcement: true,
		});
	}

	private _readDiscoveryPackets(): void {
		if (this._multicastSocket === null) return;

		try {
			const [data, address] = this._multicastSocket.receive_bytes_from(
				4096,
				-1,
				null,
			);
			if (address === null || data.get_size() === 0) return;

			const inet = address as Gio.InetSocketAddress;
			const ip = inet.address.to_string();
			if (ip === null || ip.length === 0) return;

			const payload = decodeJson<Partial<MulticastInfo>>(
				data.get_data() ?? new Uint8Array(),
			);
			this._handleDiscoveryPacket(ip, payload);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`LocalSend discovery packet failed: ${message}`);
		}
	}

	private _handleDiscoveryPacket(
		ip: string,
		payload: Partial<MulticastInfo>,
	): void {
		const fingerprint = payload.fingerprint?.trim();
		const alias = payload.alias?.trim();
		if (
			fingerprint === undefined ||
			fingerprint.length === 0 ||
			alias === undefined ||
			alias.length === 0
		)
			return;

		if (fingerprint === this._fingerprint) return;

		const peer: LocalSendPeer = {
			alias,
			version: payload.version?.trim() || PROTOCOL_VERSION,
			deviceModel: payload.deviceModel ?? null,
			deviceType: payload.deviceType ?? DeviceType.Desktop,
			fingerprint,
			port: payload.port || DEFAULT_PORT,
			protocol: payload.protocol ?? ProtocolType.Http,
			download: payload.download ?? false,
			ip,
			lastSeenAt: now(),
		};

		this._rememberPeer(peer);

		if (payload.announce ?? payload.announcement) {
			void this._respondToAnnouncement(peer);
		}
	}

	private async _respondToAnnouncement(peer: LocalSendPeer): Promise<void> {
		try {
			await this._requestJson(
				"POST",
				peer,
				"/api/localsend/v2/register",
				this._buildRegisterPayload(),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`LocalSend register response failed for ${peer.alias}: ${message}`,
			);
			this._sendUdpResponse();
		}
	}

	private _sendUdpResponse(): void {
		this._sendMulticastPacket({
			...this._buildRegisterPayload(),
			announce: false,
			announcement: false,
		});
	}

	private _sendMulticastPacket(payload: MulticastInfo): void {
		if (this._multicastSocket === null) return;

		try {
			this._multicastSocket.send_to(
				Gio.InetSocketAddress.new(
					Gio.InetAddress.new_from_string(DEFAULT_MULTICAST_GROUP),
					DEFAULT_PORT,
				),
				encodeJson(payload).get_data() ?? new Uint8Array(),
				null,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`LocalSend multicast response failed: ${message}`);
		}
	}

	private _handleRegister(message: any): void {
		try {
			const request = decodeJson<RegisterInfo>(this._requestBodyBytes(message));
			if (request.fingerprint === this._fingerprint) {
				this._respondJson(message, 412, { message: "Self-discovered" });
				return;
			}

			const { query } = parseRequestUrl(message);
			this._rememberPeer({
				...request,
				ip: query.ip ?? this._remoteIp(message),
				lastSeenAt: now(),
			});

			this._respondJson(message, 200, this._buildInfoPayload());
		} catch (error) {
			const messageText =
				error instanceof Error ? error.message : String(error);
			this._respondJson(message, 400, { message: messageText });
		}
	}

	private async _handlePrepareUpload(message: any): Promise<void> {
		try {
			const request = decodeJson<PrepareUploadRequest>(
				this._requestBodyBytes(message),
			);
			const sender = request.info;

			if (sender.fingerprint === this._fingerprint) {
				this._respondJson(message, 412, { message: "Self-discovered" });
				return;
			}

			if (this._incomingSession !== null) {
				this._respondJson(message, 409, {
					message: "Blocked by another session",
				});
				return;
			}

			const files = Object.values(request.files);
			if (files.length === 0) {
				this._respondJson(message, 400, {
					message: "Request must contain at least one file",
				});
				return;
			}

			const peer: LocalSendPeer = {
				alias: sender.alias,
				version: sender.version,
				deviceModel: sender.deviceModel ?? null,
				deviceType: sender.deviceType ?? DeviceType.Desktop,
				fingerprint: sender.fingerprint,
				port: sender.port,
				protocol: sender.protocol,
				download: sender.download,
				ip: this._remoteIp(message),
				lastSeenAt: now(),
			};

			const accepted = await this._callbacks.onIncomingTransfer({
				sender: peer,
				files,
				totalBytes: files.reduce((sum, file) => sum + file.size, 0),
			});

			if (!accepted) {
				this._respondJson(message, 403, {
					message: REJECT_MESSAGE,
				});
				return;
			}

			const sessionId = GLib.uuid_string_random();
			const tokens = new Map<string, AcceptedIncomingFile>();

			for (const file of files) {
				tokens.set(file.id, {
					file,
					token: GLib.uuid_string_random(),
					path: null,
					received: false,
				});
			}

			this._incomingSession = {
				sessionId,
				sender: peer,
				requestIp: peer.ip,
				destinationFolder: this._downloadFolder,
				files: tokens,
			};

			this._respondJson(message, 200, {
				sessionId,
				files: Object.fromEntries(
					[...tokens.entries()].map(([fileId, entry]) => [fileId, entry.token]),
				),
			} satisfies PrepareUploadResponse);
		} catch (error) {
			const messageText =
				error instanceof Error ? error.message : String(error);
			this._respondJson(message, 400, { message: messageText });
		} finally {
			message.unpause();
		}
	}

	private _respondUpload(message: any): void {
		try {
			const { query } = parseRequestUrl(message);
			const sessionId = query.sessionId ?? null;
			const fileId = query.fileId ?? null;
			const token = query.token ?? null;

			if (sessionId === null || fileId === null || token === null) {
				this._respondJson(message, 400, { message: "Missing parameters" });
				return;
			}

			if (this._incomingSession === null) {
				this._respondJson(message, 409, { message: "No session" });
				return;
			}

			if (this._incomingSession.sessionId !== sessionId) {
				this._respondJson(message, 403, { message: "Invalid session id" });
				return;
			}

			const remoteIp = this._remoteIp(message);
			if (remoteIp !== this._incomingSession.requestIp) {
				this._respondJson(message, 403, {
					message: `Invalid IP address: ${remoteIp}`,
				});
				return;
			}

			const fileEntry = this._incomingSession.files.get(fileId);
			if (fileEntry === undefined || fileEntry.token !== token) {
				this._respondJson(message, 403, { message: "Invalid token" });
				return;
			}

			const bytes = this._requestBodyBytes(message);
			const fileName = sanitizeFileName(fileEntry.file.fileName);
			const targetPath = this._makeUniquePath(
				this._incomingSession.destinationFolder,
				fileName,
			);
			if (!GLib.file_set_contents(targetPath, bytes))
				throw new Error(`Failed to write ${targetPath}.`);

			fileEntry.path = targetPath;
			fileEntry.received = true;
			this._respondJson(message, 200, null);

			if (
				[...this._incomingSession.files.values()].every(
					(entry) => entry.received,
				)
			) {
				this._callbacks.onNotification(
					"LocalSend",
					`Saved files to ${this._incomingSession.destinationFolder}.`,
					Gio.File.new_for_path(
						this._incomingSession.destinationFolder,
					).get_uri(),
				);
				this._incomingSession = null;
			}
		} catch (error) {
			const messageText =
				error instanceof Error ? error.message : String(error);
			this._respondJson(message, 500, { message: messageText });
		}
	}

	private _handleCancel(message: any): void {
		const { query } = parseRequestUrl(message);
		const sessionId = query.sessionId ?? null;

		if (
			sessionId !== null &&
			this._incomingSession !== null &&
			this._incomingSession.sessionId === sessionId
		)
			this._incomingSession = null;

		this._respondJson(message, 200, null);
	}

	private _requestBodyBytes(message: any): Uint8Array {
		return message.get_request_body().flatten().get_data() ?? new Uint8Array();
	}

	private _respondJson(message: any, statusCode: number, body: unknown): void {
		message.set_status(statusCode, HTTP_STATUS_PHRASES[statusCode] ?? "");

		if (body === null) {
			message.set_response(null, Soup.MemoryUse.COPY, null);
			return;
		}

		message.set_response(
			"application/json; charset=utf-8",
			Soup.MemoryUse.COPY,
			JSON.stringify(body),
		);
	}

	private async _sendOutgoingItems(
		peer: LocalSendPeer,
		items: OutgoingTransferItem[],
	): Promise<void> {
		const files: Record<string, FileDto> = {};
		const buffers = new Map<string, Uint8Array>();

		for (const item of items) {
			const id = GLib.uuid_string_random();
			const bytes = toBytes(item.bytes);
			buffers.set(id, bytes);
			files[id] = {
				id,
				fileName: sanitizeFileName(item.fileName),
				size: bytes.length,
				fileType: item.mimeType,
				sha256: null,
				preview: item.preview ?? null,
				metadata: null,
			};
		}

		const prepare = await this._requestJson(
			"POST",
			peer,
			"/api/localsend/v2/prepare-upload",
			{
				info: this._buildRegisterPayload(),
				files,
			} satisfies PrepareUploadRequest,
		);

		if (prepare.status === 204 || prepare.status === 403) {
			this._callbacks.onNotification("LocalSend", REJECT_MESSAGE);
			return;
		}

		if (prepare.status !== 200)
			throw new Error(
				`An error occurred: ${prepare.status} ${HTTP_STATUS_PHRASES[prepare.status]}.`,
			);

		const response = decodeJson<PrepareUploadResponse>(prepare.body);
		const acceptedIds = Object.keys(response.files);
		if (acceptedIds.length === 0) throw new Error(REJECT_MESSAGE);

		await Promise.all(
			acceptedIds.map(async (fileId) => {
				const token = response.files[fileId];
				const file = files[fileId];
				const bytes = buffers.get(fileId);

				if (token === undefined || file === undefined || bytes === undefined)
					throw new Error(`Missing transfer data for file ${fileId}.`);

				await this._requestBinary(
					"POST",
					peer,
					`/api/localsend/v2/upload?sessionId=${encodeURIComponent(response.sessionId)}&fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}`,
					bytes,
				);
			}),
		);

		this._callbacks.onNotification(
			"LocalSend",
			`Sent ${acceptedIds.length} file${acceptedIds.length === 1 ? "" : "s"} to ${peer.alias}.`,
		);
	}

	private async _requestJson(
		method: string,
		peer: LocalSendPeer,
		path: string,
		payload: unknown,
	): Promise<{ status: number; body: Uint8Array }> {
		const message = Soup.Message.new(method, this._buildUrl(peer, path));
		message.set_request_body_from_bytes(
			"application/json",
			encodeJson(payload),
		);

		if (peer.protocol === ProtocolType.Https)
			message.connect("accept-certificate", () => true);

		return this._sendAndRead(message);
	}

	private async _requestBinary(
		method: string,
		peer: LocalSendPeer,
		path: string,
		bytes: Uint8Array,
	): Promise<void> {
		const message = Soup.Message.new(method, this._buildUrl(peer, path));
		message.set_request_body_from_bytes(
			"application/octet-stream",
			GLib.Bytes.new(bytes),
		);

		if (peer.protocol === ProtocolType.Https)
			message.connect("accept-certificate", () => true);

		const response = await this._sendAndRead(message);
		if (response.status !== 200)
			throw new Error(`LocalSend upload failed with HTTP ${response.status}.`);
	}

	private _buildUrl(peer: LocalSendPeer, path: string): string {
		const protocol = peer.protocol === ProtocolType.Https ? "https" : "http";
		return `${protocol}://${peer.ip}:${peer.port}${path}`;
	}

	private async _sendAndRead(
		message: any,
	): Promise<{ status: number; body: Uint8Array }> {
		return await new Promise((resolve, reject) => {
			try {
				const maybePromise = this._session.send_and_read_async(
					message,
					0,
					null,
					(_session: unknown, result: Gio.AsyncResult) => {
						try {
							const bytes = this._session.send_and_read_finish(result);
							resolve({
								status: message.get_status(),
								body: bytes.get_data() ?? new Uint8Array(),
							});
						} catch (error) {
							reject(error);
						}
					},
				);

				if (
					maybePromise !== undefined &&
					typeof maybePromise === "object" &&
					"catch" in maybePromise
				)
					void (maybePromise as Promise<unknown>).catch(reject);
			} catch (error) {
				reject(error);
			}
		});
	}

	private _makeUniquePath(folder: string, fileName: string): string {
		GLib.mkdir_with_parents(folder, 0o755);

		const base = sanitizeFileName(fileName);
		const extensionIndex = base.lastIndexOf(".");
		const name = extensionIndex > 0 ? base.slice(0, extensionIndex) : base;
		const extension = extensionIndex > 0 ? base.slice(extensionIndex) : "";

		let candidate = GLib.build_filenamev([folder, base]);
		for (
			let index = 1;
			Gio.File.new_for_path(candidate).query_exists(null);
			index++
		) {
			candidate = GLib.build_filenamev([
				folder,
				`${name} (${index})${extension}`,
			]);
		}

		return candidate;
	}

	private _remoteIp(message: any): string {
		const remoteAddress = message.get_remote_address();
		if (remoteAddress instanceof Gio.InetSocketAddress) {
			const ip = remoteAddress.address.to_string();
			if (ip !== null) return ip;
		}

		return this._incomingSession?.requestIp ?? "127.0.0.1";
	}

	private _listenOnHttpPort(preferredPort: number): number {
		const tryListen = (port: number): number => {
			if (!this._server.listen_all(port, 0))
				throw new Error(`Failed to listen on port ${port}.`);

			const uris = this._server.get_uris();
			for (const uri of uris) {
				const portNumber = uri.get_port();
				if (portNumber > 0) return portNumber;
			}

			throw new Error("LocalSend HTTP server did not report a listening port.");
		};

		try {
			return tryListen(preferredPort);
		} catch (error) {
			if (
				!(error instanceof GLib.Error) ||
				error.code !== Gio.IOErrorEnum.ADDRESS_IN_USE
			)
				throw error;

			console.warn(
				`LocalSend port ${preferredPort} is already in use; falling back to an ephemeral port.`,
			);
			const fallbackPort = tryListen(0);
			this._callbacks.onNotification(
				"LocalSend",
				`Port ${preferredPort} is already in use. LocalSend is using port ${fallbackPort} instead.`,
			);
			return fallbackPort;
		}
	}
}
