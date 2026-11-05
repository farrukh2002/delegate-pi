import net from "node:net";
export function request(input, timeout = 86400000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.DELEGATE_SOCKET || "/delegate-ipc/control.sock");
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(input) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (buffer.length > 65536) { socket.destroy(); reject(new Error("Response is too large")); return; }
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.split("\n")[0]);
        socket.end();
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      } catch (error) { reject(error); socket.destroy(); }
    });
    socket.on("error", reject);
    socket.on("end", () => { if (!buffer.includes("\n")) reject(new Error("Parent channel closed without an answer")); });
    socket.setTimeout(timeout, () => { socket.destroy(); reject(new Error("Question expired")); });
  });
}
export async function claim(paths) {
  try { return await request({ kind: "claim", paths }, 5000); } catch { return { denied: [] }; }
}
export async function notify(paths) {
  try { return await request({ kind: "notify", paths }, 5000); } catch { return { notes: [] }; }
}
export function deniedText(denied) {
  const item = denied[0];
  return `File ${item.path} is being changed by task ${item.taskId} (${item.agent}). Do not change it and do not retry. Finish the other parts and list it under BLOCKED FILES in your final report.`;
}
export function notesText(notes) {
  return notes.map(item => `Note: task ${item.taskId} (${item.agent}) is changing ${item.path}. Its content can change.`).join("\n");
}
