// Test-only fault injection: HTTP image POST never responds; all other traffic passes.
// Run alongside start-test-stack.ts and adb reverse tcp:4319 tcp:4319.
import { createServer, request } from "node:http";
import { connect } from "node:net";
const server = createServer((incoming, response) => {
  if (incoming.method === "POST" && incoming.url === "/api/images") {
    incoming.resume();
    console.log("Held native HTTP image upload open");
    return;
  }
  const upstream = request({ hostname: "127.0.0.1", port: 4318, method: incoming.method,
    path: incoming.url, headers: incoming.headers }, (result) => {
    response.writeHead(result.statusCode ?? 502, result.headers);
    result.pipe(response);
  });
  upstream.on("error", () => response.writeHead(502).end());
  incoming.pipe(upstream);
});
server.on("upgrade", (request, socket, head) => {
  const upstream = connect(4318, "127.0.0.1", () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
      Object.entries(request.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") + "\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
server.listen(4319, "127.0.0.1", () => console.log("Image fault fixture ready"));
