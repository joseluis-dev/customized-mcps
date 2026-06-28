import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  createShutdownController,
  type ShutdownDeps,
} from "../src/shutdown.js";

function makeDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
  return {
    server: { close: vi.fn((cb?: (err?: Error) => void) => cb?.()) } as never,
    transport: { close: vi.fn(async () => {}) } as never,
    closePool: vi.fn(async () => {}),
    timeoutMs: 100,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never,
    ...overrides,
  };
}

describe("createShutdownController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in a non-shutting-down state", () => {
    const ctl = createShutdownController(makeDeps());
    expect(ctl.isShuttingDown()).toBe(false);
  });

  it("markShuttingDown transitions the state and logs a warning", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const ctl = createShutdownController(makeDeps({ logger }));
    ctl.markShuttingDown();
    expect(ctl.isShuttingDown()).toBe(true);
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("drain() closes the server, transport, and pool in order", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      server: { close: vi.fn((cb?: (err?: Error) => void) => { calls.push("server"); cb?.(); }) } as never,
      transport: { close: vi.fn(async () => { calls.push("transport"); }) } as never,
      closePool: vi.fn(async () => { calls.push("pool"); }),
    });
    const ctl = createShutdownController(deps);
    ctl.markShuttingDown();
    await ctl.drain();
    expect(calls).toEqual(["server", "transport", "pool"]);
  });

  it("drain() still closes the transport when server.close errors", async () => {
    const transportClose = vi.fn(async () => {});
    const deps = makeDeps({
      server: { close: vi.fn((cb?: (err?: Error) => void) => cb?.(new Error("boom"))) } as never,
      transport: { close: transportClose } as never,
    });
    const ctl = createShutdownController(deps);
    ctl.markShuttingDown();
    await ctl.drain();
    // Server close failed; we should still try to close the transport and pool
    // because they need to be released even on failure paths.
    expect(transportClose).toHaveBeenCalledTimes(1);
  });

  it("drain() force-closes when the timeout elapses", async () => {
    let poolResolve: () => void = () => {};
    const closePool = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          poolResolve = resolve;
        }),
    );
    const transport = new EventEmitter() as never;
    (transport as { close: ReturnType<typeof vi.fn> }).close = vi.fn();
    const deps = makeDeps({
      closePool,
      transport,
      timeoutMs: 50,
    });
    const ctl = createShutdownController(deps);
    ctl.markShuttingDown();
    const drainPromise = ctl.drain();
    // Advance past the timeout.
    await vi.advanceTimersByTimeAsync(60);
    // The drain should resolve via the timeout path; unblock the pool.
    poolResolve();
    await drainPromise;
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("drain() invokes a force-close hook when the timeout elapses", async () => {
    // The force-close hook is the operator's last resort: when the
    // graceful drain does not finish within the timeout, the hook is
    // called so the process can be torn down (e.g. process.exit()).
    const forceClose = vi.fn();
    let poolResolve: () => void = () => {};
    const closePool = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          poolResolve = resolve;
        }),
    );
    const transport = new EventEmitter() as never;
    (transport as { close: ReturnType<typeof vi.fn> }).close = vi.fn();
    const deps = makeDeps({
      closePool,
      transport,
      timeoutMs: 50,
      forceClose,
    });
    const ctl = createShutdownController(deps);
    ctl.markShuttingDown();
    const drainPromise = ctl.drain();
    await vi.advanceTimersByTimeAsync(60);
    expect(forceClose).toHaveBeenCalledTimes(1);
    // unblock and let the drain resolve
    poolResolve();
    await drainPromise;
  });

  it("drain() does not invoke force-close when work finishes before the timeout", async () => {
    const forceClose = vi.fn();
    const deps = makeDeps({
      forceClose,
      timeoutMs: 1000,
    });
    const ctl = createShutdownController(deps);
    ctl.markShuttingDown();
    await ctl.drain();
    expect(forceClose).not.toHaveBeenCalled();
  });

  it("installSignalHandlers wires SIGTERM and SIGINT to markShuttingDown+drain", async () => {
    const emitter = new EventEmitter();
    const deps = makeDeps({
      process: emitter as never,
    });
    const ctl = createShutdownController(deps);
    ctl.installSignalHandlers();
    expect(ctl.isShuttingDown()).toBe(false);
    emitter.emit("SIGTERM");
    expect(ctl.isShuttingDown()).toBe(true);
    await ctl.drain();
  });

  it("drain() resolves within the timeout (no indefinite hang)", async () => {
    // Critical safety property: drain MUST always resolve, even if the
    // underlying close hooks never complete. The force-close hook is
    // the last resort that lets the process exit.
    const forceClose = vi.fn();
    const closePool = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const deps = makeDeps({
      closePool,
      timeoutMs: 25,
      forceClose,
    });
    const ctl = createShutdownController(deps);
    ctl.markShuttingDown();
    const drainPromise = ctl.drain();
    await vi.advanceTimersByTimeAsync(30);
    // The drain should have resolved via the timeout path by now.
    await drainPromise;
    expect(forceClose).toHaveBeenCalledTimes(1);
  });

  it("drain() invokes force-close when closePool rejects (rejection fallback)", async () => {
    // PR1 remediation: a rejection in closePool/closeServer/closeTransport
    // MUST trigger the force-close hook. Without this, the signal
    // handler's `void drain()` would log an unhandled rejection and the
    // process could hang without the operator's last-resort hook ever
    // firing.
    const forceClose = vi.fn();
    const closePool = vi.fn(async () => {
      throw new Error("pool close blew up");
    });
    const deps = makeDeps({
      closePool,
      timeoutMs: 5000,
      forceClose,
    });
    const ctl = createShutdownController(deps);
    ctl.markShuttingDown();
    await ctl.drain();
    expect(forceClose).toHaveBeenCalledTimes(1);
  });

  it("drain() never rejects (signal handlers can safely use `void drain()`)", async () => {
    // PR1 remediation: drain MUST never reject. We trigger every
    // failure path and assert the promise still resolves.
    const forceClose = vi.fn();
    const closePool = vi.fn(async () => {
      throw new Error("intentional rejection");
    });
    const server = {
      close: vi.fn((cb?: (err?: Error) => void) => cb?.(new Error("server close failed"))),
    } as never;
    const transport = {
      close: vi.fn(async () => {
        throw new Error("transport close failed");
      }),
    } as never;
    const deps = makeDeps({
      closePool,
      server,
      transport,
      timeoutMs: 5000,
      forceClose,
    });
    const ctl = createShutdownController(deps);
    ctl.markShuttingDown();
    // The drain promise MUST resolve (not reject) and the force-close
    // hook MUST fire.
    await expect(ctl.drain()).resolves.toBeUndefined();
    expect(forceClose).toHaveBeenCalledTimes(1);
  });
});
