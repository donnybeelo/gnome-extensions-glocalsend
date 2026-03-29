import "@girs/gjs";
import "@girs/gjs/dom";
import "@girs/gnome-shell/ambient";
import "@girs/gnome-shell/extensions/global";

declare module 'gi://Soup' {
  import Gio from 'gi://Gio';
  import GLib from 'gi://GLib';
  import GObject from 'gi://GObject';

  export enum MemoryUse {
    COPY = 1,
    TAKE = 2,
  }

  export enum ServerListenOptions {
    IPV4_ONLY = 1,
    IPV6_ONLY = 2,
  }

  export class MessageBody extends GObject.Object {
    flatten(): GLib.Bytes;
  }

  export class Message extends GObject.Object {
    static new(method: string, uriString: string): Message;

    connect(signal: string, callback: (...args: unknown[]) => unknown): number;
    get_method(): string;
    get_request_body(): MessageBody;
    get_status(): number;
    get_uri(): GLib.Uri;
    set_request_body_from_bytes(contentType: string | null, bytes: GLib.Bytes | Uint8Array | null): void;
    set_response(contentType: string | null, respUse: MemoryUse, respBody: string | Uint8Array | null): void;
    set_status(statusCode: number, reasonPhrase?: string | null): void;
  }

  export class ServerMessage extends Message {
    pause(): void;
    unpause(): void;
  }

  export class Session extends GObject.Object {
    static new(...args: unknown[]): Session;

    send_and_read_async(
      msg: Message,
      cancellable: Gio.Cancellable | null,
      callback: (session: Session, result: Gio.AsyncResult) => void,
    ): void;

    send_and_read_finish(result: Gio.AsyncResult): GLib.Bytes;
  }

  export class Server extends GObject.Object {
    static new(...args: unknown[]): Server;

    add_handler(path: string | null, callback: (server: Server, msg: ServerMessage, path: string, query: string, client: unknown) => void): void;
    listen_all(port: number, options: number): boolean;
    listen_local(port: number, options: number): boolean;
  }

  const Soup: {
    MemoryUse: typeof MemoryUse;
    ServerListenOptions: typeof ServerListenOptions;
    Message: typeof Message;
    Server: typeof Server;
    Session: typeof Session;
  };

  export default Soup;
}
