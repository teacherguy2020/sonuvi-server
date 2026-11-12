/** Install the same awaited cleanup chain in the server and lifecycle integration tests. */
export function installRuntimeShutdown({ target = process, cleanup, exit = code => process.exit(code) } = {}) {
  let operation;
  const shutdown = signal => {
    if (!operation) operation = Promise.resolve().then(() => cleanup(signal)).then(() => exit(0), () => exit(1));
    return operation;
  };
  const term = () => shutdown('SIGTERM');
  const interrupt = () => shutdown('SIGINT');
  target.once('SIGTERM', term);target.once('SIGINT', interrupt);
  return { shutdown, dispose() { target.removeListener('SIGTERM',term);target.removeListener('SIGINT',interrupt); } };
}
