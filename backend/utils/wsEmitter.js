/**
 * WebSocket emitter singleton.
 * Routes that need to broadcast real-time events can import this module
 * instead of reaching into the App instance directly.
 */

let io = null;

function setIO(socketIO) {
  io = socketIO;
}

function getIO() {
  return io;
}

/**
 * Broadcast a new-log event to all connected dashboard clients.
 */
function emitNewLog(logEntry) {
  if (!io) {
    console.warn("wsEmitter: io not initialized, skipping emitNewLog");
    return;
  }
  io.to("logs").emit("new-log", {
    type: "new-log",
    data: logEntry.toObject ? logEntry.toObject() : logEntry,
    timestamp: new Date(),
  });
}

module.exports = { setIO, getIO, emitNewLog };