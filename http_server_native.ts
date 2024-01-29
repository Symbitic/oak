// Copyright 2018-2023 the oak authors. All rights reserved. MIT license.

import type { Application, State } from "./application.ts";
import { NativeRequest } from "./http_server_native_request.ts";
import type {
  HttpServer,
  Listener,
  OakServer,
  ServeInit,
  ServeOptions,
  ServeTlsOptions,
} from "./types.d.ts";
import { createPromiseWithResolvers } from "./util.ts";

// this is included so when down-emitting to npm/Node.js, ReadableStream has
// async iterators
declare global {
  // deno-lint-ignore no-explicit-any
  interface ReadableStream<R = any> {
    [Symbol.asyncIterator](options?: {
      preventCancel?: boolean;
    }): AsyncIterableIterator<R>;
  }
}

const serve: (
  options: ServeInit & (ServeOptions | ServeTlsOptions),
) => HttpServer = "serve" in Deno
  // deno-lint-ignore no-explicit-any
  ? (Deno as any).serve.bind(Deno)
  : undefined;

/** The oak abstraction of the Deno native HTTP server which is used internally
 * for handling native HTTP requests. Generally users of oak do not need to
 * worry about this class. */
// deno-lint-ignore no-explicit-any
export class Server<AS extends State = Record<string, any>>
  implements OakServer<NativeRequest> {
  #app: Application<AS>;
  #closed = false;
  #httpServer?: HttpServer;
  #options: ServeOptions | ServeTlsOptions;
  #stream?: ReadableStream<NativeRequest>;

  constructor(
    app: Application<AS>,
    options: Omit<ServeOptions | ServeTlsOptions, "signal">,
  ) {
    if (!("serve" in Deno)) {
      throw new Error(
        "The native bindings for serving HTTP are not available.",
      );
    }
    this.#app = app;
    this.#options = options;
  }

  get app(): Application<AS> {
    return this.#app;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    if (this.#httpServer) {
      this.#httpServer.unref();
      await this.#httpServer.shutdown();
      this.#httpServer = undefined;
    }
    this.#closed = true;
  }

  listen(): Promise<Listener> {
    if (this.#httpServer) {
      throw new Error("Server already listening.");
    }
    const { signal } = this.#options;
    signal?.addEventListener("abort", () => this.close(), { once: true });
    const { onListen, ...options } = this.#options;
    const { promise, resolve } = createPromiseWithResolvers<Listener>();
    this.#stream = new ReadableStream<NativeRequest>({
      start: (controller) => {
        this.#httpServer = serve({
          handler: (req, info) => {
            const nativeRequest = new NativeRequest(req, info);
            controller.enqueue(nativeRequest);
            return nativeRequest.response;
          },
          onListen({ hostname, port }) {
            if (onListen) {
              onListen({ hostname, port });
            }
            resolve({ addr: { hostname, port } });
          },
          signal,
          ...options,
        });
      },
    });

    return promise;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<NativeRequest> {
    if (!this.#stream) {
      throw new TypeError("Server hasn't started listening.");
    }
    return this.#stream[Symbol.asyncIterator]();
  }
}
