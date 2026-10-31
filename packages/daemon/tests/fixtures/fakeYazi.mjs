// A stand-in for yazi in a tool terminal (docs/yazi-v0.md): as yazi does, it asks the terminal what it is (DA1,
// `CSI c`) as it starts and takes no key until that is answered; then says the folder it was opened on and what it is
// sent, and quits on `q`.
const dir = process.argv[2] ?? "";
process.stdin.setRawMode?.(true);
process.stdout.write("\x1b[0c");
let answered = false;
process.stdin.on("data", (b) => {
  let s = b.toString();
  if (!answered) {
    const reply = /\x1b\[\?[0-9;]*c/.exec(s);
    if (!reply) return;
    answered = true;
    process.stdout.write(`fake yazi in ${dir}\r\n`);
    s = s.slice(reply.index + reply[0].length);
  }
  if (s.includes("q")) process.exit(0);
  if (s) process.stdout.write(`yazi got: ${JSON.stringify(s)}\r\n`);
});
