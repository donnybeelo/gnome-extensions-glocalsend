import GLib from 'gi://GLib?version=2.0';

export const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.localsend-companion';

export const KEY_LAUNCHER_COMMAND = 'launcher-command';
export const KEY_DISCOVERABLE_DURATION_MINUTES = 'discoverable-duration-minutes';

export const DEFAULT_LAUNCHER_COMMAND = 'localsend_app';
export const DEFAULT_DISCOVERABLE_DURATION_MINUTES = 10;

export function parseCommandLine(commandLine: string): string[] {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0)
    return [DEFAULT_LAUNCHER_COMMAND];

  const [success, argv] = GLib.shell_parse_argv(trimmed);
  if (!success || argv === null || argv.length === 0)
    throw new Error(`Invalid launcher command: ${commandLine}`);

  return argv;
}

export function formatRemainingTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0)
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}
