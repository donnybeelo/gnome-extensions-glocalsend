import GLib from "gi://GLib";

export const SETTINGS_SCHEMA = "org.gnome.shell.extensions.glocalsend";

export const PROTOCOL_VERSION = "2.1";
export const DEFAULT_PORT = 53317;
export const DEFAULT_MULTICAST_GROUP = "224.0.0.167";
export const DEFAULT_DOWNLOAD_FOLDER = "";
export const DEFAULT_AUTO_DISABLE_ENABLED = true;
export const DEFAULT_AUTO_DISABLE_MINUTES = 10;

export const KEY_ALIAS = "alias";
export const KEY_FINGERPRINT = "fingerprint";
export const KEY_PORT = "port";
export const KEY_DOWNLOAD_FOLDER = "download-folder";
export const KEY_AUTO_ACCEPT = "auto-accept";
export const KEY_AUTO_DISABLE_ENABLED = "auto-disable-enabled";
export const KEY_AUTO_DISABLE_MINUTES = "auto-disable-minutes";

export enum ProtocolType {
	Http = "http",
	Https = "https",
}

export enum DeviceType {
	Mobile = "mobile",
	Desktop = "desktop",
	Web = "web",
	Headless = "headless",
	Server = "server",
}

export interface DeviceInfo {
	alias: string;
	version: string;
	deviceModel?: string | null;
	deviceType?: DeviceType | null;
	fingerprint: string;
	download: boolean;
}

export interface RegisterInfo extends DeviceInfo {
	port: number;
	protocol: ProtocolType;
}

export interface MulticastInfo extends RegisterInfo {
	announce: boolean;
	announcement?: boolean;
}

export interface FileMetadata {
	modified?: string | null;
	accessed?: string | null;
}

export interface FileDto {
	id: string;
	fileName: string;
	size: number;
	fileType: string;
	sha256?: string | null;
	preview?: string | null;
	metadata?: FileMetadata | null;
}

export interface PrepareUploadRequest {
	info: RegisterInfo;
	files: Record<string, FileDto>;
}

export interface PrepareUploadResponse {
	sessionId: string;
	files: Record<string, string>;
}

export function makeDefaultAlias(): string {
	return GLib.get_host_name() || "LocalSend";
}

export function ensureAlias(value: string): string {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : makeDefaultAlias();
}

export function generateFingerprint(): string {
	return GLib.uuid_string_random();
}

export function ensureFingerprint(value: string): string {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : generateFingerprint();
}

export function sanitizeFileName(fileName: string): string {
	const cleaned = fileName.replace(/[\\/\\0]/g, "-").trim();
	return cleaned.length > 0 ? cleaned : "localsend-file";
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	return unitIndex === 0
		? `${Math.round(value)} ${units[unitIndex]}`
		: `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatRemainingTime(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = seconds % 60;

	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;

	return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function encodeJson(value: unknown): GLib.Bytes {
	return GLib.Bytes.new(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeJson<T>(bytes: Uint8Array | null | undefined): T {
	if (bytes === null || bytes === undefined)
		throw new Error("Empty response body.");

	return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function bytesFromString(value: string): GLib.Bytes {
	return GLib.Bytes.new(new TextEncoder().encode(value));
}

export function stringFromBytes(bytes: Uint8Array | null | undefined): string {
	if (bytes === null || bytes === undefined) return "";

	return new TextDecoder().decode(bytes);
}

export function getDefaultDownloadFolder(): string {
	return GLib.build_filenamev([GLib.get_home_dir(), "Downloads", "LocalSend"]);
}
